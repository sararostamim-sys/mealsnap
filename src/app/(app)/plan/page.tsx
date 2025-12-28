// src/app/plan/page.tsx
'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { DEFAULT_HEALTHY_WHOLE_FOOD_PROFILE } from '@/lib/healthyProfile';
import type { HealthyProfile } from '@/lib/healthyProfile';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import FavoriteButton from '@/components/FavoriteButton';
import { getDevUserId } from '@/lib/user';
import { smartMergeNeeds, ShoppingItem, RawNeed } from '@/lib/shopping';
import { STORES, getPriceEstimate, StoreId } from '@/lib/pricing';
import {
  buildInstacartUrl,
  buildWalmartUrl,
  buildAmazonFreshUrl,
} from '@/lib/groceryLinks';
import { computeRecipePerishability, scoreFromPerishDate } from '@/lib/perishables';
import type { PantryCategory } from '@/lib/pantryCategorizer';
import { prettyCategoryLabel } from '@/lib/pantryCategorizer';
import React, { Fragment, Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { trackEvent } from '@/lib/analytics';

type Recipe = {
  id: string;
  title: string;
  time_min: number;
  diet_tags: string[] | null;
  instructions: string;

  // Optional fields for richer previews (safe even if DB doesn’t have them yet)
  calories?: number | null;   // per serving
  protein_g?: number | null;  // per serving
};

type Ing = {
  recipe_id: string;
  name: string;
  qty: number | null;
  unit: string | null;
  optional: boolean;
};

type Prefs = {
  diet: string;
  allergies: string[];
  dislikes: string[];
  max_prep_minutes: number;
  budget_level: string;
  favorite_mode: 'variety' | 'favorites';
  healthy_whole_food: boolean;
  kid_friendly: boolean;
  // Healthy micro-survey fields (mirroring DB)
  healthy_goal: 'feel_better' | 'weight' | 'metabolic' | '';
  healthy_protein_style: 'mixed' | 'lean_animal' | 'plant_forward' | '';
  healthy_carb_pref: 'more_whole_grains' | 'lower_carb' | 'no_preference' | '';
  updated_at?: string;
};

type HealthySurvey = {
  goal: 'feel_better' | 'weight' | 'metabolic' | '';
  proteinPreference: 'mixed' | 'lean_animal' | 'plant_forward' | '';
  carbBias: 'more_whole_grains' | 'lower_carb' | 'no_preference' | '';
};

const HEALTHY_SURVEY_KEY = 'mc_healthy_survey_v1';

type PantryRow = { name: string; updated_at: string; perish_by: string | null };

type PlanItem = { recipe_id: string; position: number };

type PlanHeader = {
  id: string;
  generated_at: string;
  share_id: string | null;
  user_meal_plan_recipes?: PlanItem[];
};

type PrefsRow = Partial<{
  diet: string;
  allergies: string[];
  disliked_ingredients: string[];
  max_prep_time: number;
  budget_level: string;
  favorite_mode: string;
  healthy_whole_food: boolean;
  kid_friendly: boolean;
  healthy_goal: string;
  healthy_protein_style: string;
  healthy_carb_pref: string;
  updated_at: string;
}>;

// How we present items in the UI / Notes
type DisplayShoppingItem = {
  qtyLabel: string;
  unitLabel: string;
  nameLabel: string; // what user sees in the first column / bullet text
};

type FavoriteRow = {
  recipe_id: string;
};

function formatApproxVolume(qty: number, unit: string): string {
  const u = unit.toLowerCase();

  // Normalize tbsp/tsp into cups for display
  if (u === 'tbsp') {
    const cups = qty / 16; // 16 tbsp = 1 cup
    if (cups >= 0.25) return `${Math.round(cups * 10) / 10} cup`;
    return `${qty} tbsp`;
  }

  if (u === 'tsp') {
    const cups = qty / 48; // 48 tsp = 1 cup
    if (cups >= 0.25) return `${Math.round(cups * 10) / 10} cup`;
    return `${qty} tsp`;
  }

  if (u === 'cup' || u === 'cups') {
    return `${qty} cup`;
  }

  // If it's already g/ml/etc, just use that
  return unit ? `${qty} ${unit}` : `${qty}`;
}

function formatShoppingItem(item: ShoppingItem): DisplayShoppingItem {
  const name = item.name;
  const qty = item.qty;
  const unit = item.unit;

  // Items that are usually bought as containers, not tablespoons/cups
  const PACKAGEY = /(milk|yogurt|cheese|feta|mozzarella|tomato sauce|sauce|broth|stock|cream)/i;
  const HERB_BUNCH = /(basil|dill)/i;
  const LEAFY_BAG = /spinach/i;

  const isCountUnit = unit === 'unit';

  // Liquids / dairy / cheese / sauce: show 1 container + amount in cups/units
  if (PACKAGEY.test(name)) {
    const approxAmount =
      unit && unit !== 'unit'
        ? formatApproxVolume(qty, unit)
        : `${qty}`;

    return {
      qtyLabel: '1',
      unitLabel: '',
      nameLabel: `${name} (about ${approxAmount})`,
    };
  }

  // Leafy greens like spinach → 1 bag once amount is large
  if (LEAFY_BAG.test(name)) {
    if (unit === 'cup' && qty >= 2) {
      const approx = `${qty} cup`;
      return {
        qtyLabel: '1',
        unitLabel: 'bag',
        nameLabel: `${name} (about ${approx})`,
      };
    }
  }

  // Herbs like basil / dill → 1 bunch once amount is large
  if (HERB_BUNCH.test(name)) {
    const bigEnough =
      (unit === 'unit' && qty >= 5) ||
      ((unit === 'tbsp' || unit === 'tsp') && qty >= 2);

    if (bigEnough) {
      return {
        qtyLabel: '1',
        unitLabel: 'bunch',
        nameLabel: name,
      };
    }
  }

  // For normal count items (onion, lemon, garlic, tortillas)
  if (isCountUnit) {
    return {
      qtyLabel: String(qty),
      unitLabel: '',
      nameLabel: name,
    };
  }

  // Default
  const unitLabel = unit === 'unit' ? '' : unit;

  return {
    qtyLabel: String(qty),
    unitLabel,
    nameLabel: name,
  };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAnyTerm(name: string, terms: Set<string>): boolean {
  const lower = name.toLowerCase();
  for (const t of terms) {
    const term = t.toLowerCase().trim();
    if (!term) continue;
    const rx = new RegExp(`\\b${escapeRegex(term)}s?\\b`, 'i');
    if (rx.test(lower)) return true;
  }
  return false;
}

function expandAllergyTerms(allergies: string[]): Set<string> {
  const base = allergies.map((a) => a.toLowerCase().trim()).filter(Boolean);

  // Map “high-level” allergy toggles → ingredient keywords we actually see in recipe_ingredients
  const MAP: Record<string, string[]> = {
    dairy: [
      'milk',
      'cheese',
      'butter',
      'yogurt',
      'cream',
      'sour cream',
      'whey',
      'casein',
      'ghee',
      'mozzarella',
      'cheddar',
      'parmesan',
      'feta',
    ],
    gluten: [
      'wheat',
      'flour',
      'bread',
      'pasta',
      'noodle',
      'tortilla',
      'cracker',
      'breadcrumb',
      'breadcrumbs',
      'soy sauce', // often contains wheat unless tamari
    ],
    egg: ['egg', 'eggs', 'mayonnaise', 'mayo'],
    peanut: ['peanut', 'peanuts'],
    shellfish: ['shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop'],
    soy: ['soy', 'tofu', 'edamame', 'miso', 'tempeh', 'soy sauce'],
    sesame: ['sesame', 'tahini'],
  };

  const out = new Set<string>();

  for (const a of base) {
    out.add(a);

    const extras = MAP[a];
    if (extras && extras.length) {
      for (const x of extras) out.add(x.toLowerCase());
    }
  }

  return out;
}

function getHealthSwapHintForItem(
  item: { name: string; category?: PantryCategory },
  prefs: Prefs | null,
): string | null {
  // Only show hints when the user has asked for a healthy / whole-food focus
  if (!prefs?.healthy_whole_food) return null;

  const name = item.name.toLowerCase();
  const cat = item.category;

  // 1) Refined grains → whole grains
  if (/\bwhite rice\b/.test(name) || (/\brice\b/.test(name) && !/brown/.test(name))) {
    return 'Swap to brown rice or quinoa for more fiber.';
  }

  if (
    /(pasta|spaghetti|penne|fusilli|macaroni|noodle)/.test(name) &&
    !/whole/.test(name) &&
    !/(lentil|chickpea|bean)/.test(name)
  ) {
    return 'Try whole-wheat or legume pasta for extra fiber and protein.';
  }

  if (/(bread|bagel|pita|naan|tortilla|wrap)/.test(name) && !/whole/.test(name)) {
    return 'Look for whole-grain bread or tortillas instead of white.';
  }

  // 2) Sodium-conscious swaps
  if (/(broth|stock)/.test(name) && !/(low sodium|reduced sodium|no salt)/.test(name)) {
    return 'Choose a low-sodium broth or stock if available.';
  }

  if (
    /(canned tomato|tomato sauce|marinara)/.test(name) &&
    !/(no salt|low sodium|reduced sodium)/.test(name)
  ) {
    return 'Pick a no-salt-added or low-sodium tomato product.';
  }

  // 3) Higher-protein / lighter fats
  if (/(sour cream|mayonnaise|mayo)/.test(name)) {
    return 'Plain Greek yogurt can replace sour cream or mayo for more protein.';
  }

  if (/(cheese|cheddar|mozzarella|feta)/.test(name)) {
    return 'Use smaller portions or choose part-skim / lighter cheese if you can.';
  }

  // 4) Snacks & beverages
  if (
    cat === 'beverages' &&
    (/(soda|cola|sweet tea|lemonade)/.test(name) || /juice/.test(name))
  ) {
    return 'Consider water or sparkling water with fruit instead of sugary drinks.';
  }

  if (cat === 'snacks' && /(chips|cookies|candy|cracker|snack)/.test(name)) {
    return 'Try fruit, nuts, or yogurt as a snack instead of ultra-processed options.';
  }

  return null;
}

function uniqueByIdLimit(recipes: Recipe[], limit: number): Recipe[] {
  const seen = new Set<string>();
  const out: Recipe[] = [];

  for (const r of recipes) {
    if (!r?.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) break;
  }

  return out;
}

async function sha256Hex(input: string): Promise<string> {
  try {
    if (typeof window === 'undefined') return input; // should never happen in this client file
    if (!window.crypto?.subtle) return input;

    const enc = new TextEncoder();
    const bytes = enc.encode(input);
    const hashBuf = await window.crypto.subtle.digest('SHA-256', bytes);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback: return the raw string (still stable, just longer)
    return input;
  }
}

function PlanPageInner() {
  useRequireAuth();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const [pantry, setPantry] = useState<PantryRow[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);

  const [meals, setMeals] = useState<Recipe[]>([]);
  const meals7 = useMemo(() => uniqueByIdLimit(meals, 7), [meals]);

  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [planMeta, setPlanMeta] = useState<{
  id: string;
  generated_at: string;
  share_id?: string | null;
  } | null>(null);
  const [stale, setStale] = useState(false);

  const enablePriceHints = process.env.NEXT_PUBLIC_ENABLE_PRICE_HINTS === '1';
  const [storeId, setStoreId] = useState<StoreId>('none');

  // Modal state
  const [openId, setOpenId] = useState<string | null>(null);

    // Auto-open recipe modal when arriving with ?open=<recipeId>
   useEffect(() => {
    const id = searchParams.get('open');
    if (!id) return;

    // Only open if we can actually resolve this recipe in the current plan list
    const inPlan = meals7.some((m) => m.id === id);
    if (inPlan) setOpenId(id);
  }, [searchParams, meals7]);

  function closeRecipeModal() {
    setOpenId(null);

    // If the URL contains ?open=..., remove it so the modal doesn't reopen on refresh/back
    if (searchParams.get('open')) {
      router.replace(pathname);
    }
  }

  // NEW: track whether this plan came from LLM vs heuristic
  const [plannerMode, setPlannerMode] = useState<'llm' | 'heuristic' | null>(
    null,
  );

  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  // NEW: which external shop the user wants to use for links
  const [shopPlatform, setShopPlatform] = useState<
    'none' | 'instacart' | 'walmart' | 'amazon'
  >('none');

  // Healthy micro-survey answers (loaded from localStorage)
  const [healthySurvey, setHealthySurvey] = useState<HealthySurvey | null>(null);

  const [generating, setGenerating] = useState(false);

  const generatingRef = useRef(false);
  const lastPlanReqKeyRef = useRef<string | null>(null);
  const lastPlanReqAtRef = useRef<number>(0);

  // Derived shopping list with price estimates (if enabled)
  const pricedShopping = useMemo(() => {
    return shopping.map((item) => {
      const est = getPriceEstimate(
        { name: item.name, qty: item.qty, unit: item.unit },
        storeId,
      );
      return {
        ...item,
        estPrice: est.price,
        estPriceUnit: est.unitLabel,
      };
    });
  }, [shopping, storeId]);

  const estTotal = useMemo(
    () => pricedShopping.reduce((sum, it) => sum + (it.estPrice ?? 0), 0),
    [pricedShopping],
  );

  /** Prefer authenticated user; fall back to .env dev id */
  async function resolveUserId(): Promise<string> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const uid = user?.id ?? getDevUserId();
    setUserId(uid);
    return uid;
  }

  // Build an index of ingredients by recipe for quick lookups
  const ingByRecipe = useMemo(() => {
    const m = new Map<string, Ing[]>();
    ings.forEach((i) => {
      const arr = m.get(i.recipe_id) || [];
      arr.push(i);
      m.set(i.recipe_id, arr);
    });
    return m;
  }, [ings]);

  // Build a fast lookup for perish-by dates from the pantry
  const pantryPerishBy = useMemo(() => {
    const m = new Map<string, Date>();
    pantry.forEach((p) => {
      if (!p.perish_by) return;
      const ts = Date.parse(p.perish_by);
      if (Number.isNaN(ts)) return;
      m.set(p.name.toLowerCase(), new Date(ts));
    });
    return m;
  }, [pantry]);

  // Recompute shopping list from chosen meals + current pantry (Smart List v1)
  const recomputeShopping = useCallback(
    (chosen: Recipe[]) => {
      const pantrySet = new Set(pantry.map((p) => p.name.toLowerCase()));
      const rawNeeds: RawNeed[] = [];

      for (const r of chosen) {
        const ri = ingByRecipe.get(r.id) || [];
        for (const it of ri) {
          const nameLower = it.name.toLowerCase();
          if (pantrySet.has(nameLower)) continue;

          rawNeeds.push({
            name: it.name,
            qty: it.qty ?? 1,
            unit: it.unit ?? 'unit',
          });
        }
      }

      const merged = smartMergeNeeds(rawNeeds);
      setShopping(merged);
    },
    [ingByRecipe, pantry],
  );

  // Keep shopping list in sync when meals or ingredients change
  useEffect(() => {
    if (meals7.length) recomputeShopping(meals7);
  }, [meals7, recomputeShopping]);

  // Initial load: user + pantry/prefs/recipes/ings + latest saved plan
  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await resolveUserId();

      const [pItems, pRes, rRes, iRes, favRes] = await Promise.all([
        supabase
          .from('pantry_items')
          .select('name,updated_at,perish_by')
          .eq('user_id', uid),
        supabase.from('preferences').select('*').eq('user_id', uid).maybeSingle(),
        supabase
          .from('recipes')
          .select('id,title,time_min,diet_tags,instructions'),
        supabase
          .from('recipe_ingredients')
          .select('recipe_id,name,qty,unit,optional'),
        supabase.from('favorites').select('recipe_id').eq('user_id', uid),
      ]);

      const pantryRows: PantryRow[] = (pItems.data || []).map((x) => ({
        name: String(x.name).toLowerCase(),
        updated_at: x.updated_at || new Date(0).toISOString(),
        perish_by: x.perish_by ?? null,
      }));
      setPantry(pantryRows);

      // Map DB columns → local Prefs shape
      const pr = (pRes.data ?? null) as PrefsRow | null;
      const prefsRow: Prefs = pr
        ? {
            diet: pr.diet ?? 'none',
            allergies: pr.allergies ?? [],
            dislikes: pr.disliked_ingredients ?? [],
            max_prep_minutes: pr.max_prep_time ?? 45,
            budget_level: pr.budget_level ?? 'medium',
            favorite_mode:
              pr.favorite_mode === 'favorites' ? 'favorites' : 'variety',
            healthy_whole_food: pr.healthy_whole_food ?? false,
            kid_friendly: pr.kid_friendly ?? false,
            healthy_goal: (pr.healthy_goal as Prefs['healthy_goal']) ?? '',
            healthy_protein_style:
              (pr.healthy_protein_style as Prefs['healthy_protein_style']) ?? '',
            healthy_carb_pref:
              (pr.healthy_carb_pref as Prefs['healthy_carb_pref']) ?? '',
            updated_at: pr.updated_at ?? undefined,
          }
        : {
            diet: 'none',
            allergies: [],
            dislikes: [],
            max_prep_minutes: 45,
            budget_level: 'medium',
            favorite_mode: 'variety',
            healthy_whole_food: false,
            kid_friendly: false,
            healthy_goal: '',
            healthy_protein_style: '',
            healthy_carb_pref: '',
          };
      setPrefs(prefsRow);

      const recipeRows: Recipe[] = rRes.data || [];
      setRecipes(recipeRows);
      setIngs(iRes.data || []);

      // Build favorites set for quick lookup
      const favSet = new Set<string>(
        (favRes.data || []).map((f: FavoriteRow) => f.recipe_id),
      );
      setFavorites(favSet);

      // Load latest saved plan (+ items) for this user
      const { data: plan } = await supabase
        .from('user_meal_plan')
        .select('id, generated_at, share_id, user_meal_plan_recipes (recipe_id, position)')
        .eq('user_id', uid)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle<PlanHeader>();

      if (plan) {
        const byId = new Map(recipeRows.map((r) => [r.id, r]));
        const items = (plan.user_meal_plan_recipes || [])
          .slice()
          .sort((a, b) => a.position - b.position);
        const chosen = items
          .map((it) => byId.get(it.recipe_id))
          .filter(Boolean) as Recipe[];
        setMeals(chosen);
        setPlanMeta({ id: plan.id, generated_at: plan.generated_at, share_id: plan.share_id ?? null });

        // Staleness: if pantry/prefs changed after plan.generated_at
        const pantryMax = pantryRows.length
          ? Math.max(...pantryRows.map((p) => Date.parse(p.updated_at)))
          : 0;
        const prefsUpdated = prefsRow.updated_at
          ? Date.parse(prefsRow.updated_at)
          : 0;
        const planTs = Date.parse(plan.generated_at);
        setStale(pantryMax > planTs || prefsUpdated > planTs);
      }

      setLoading(false);
    })();
  }, []);

  // Load healthy micro-survey answers (if any) from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(HEALTHY_SURVEY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<HealthySurvey>;
      setHealthySurvey({
        goal: parsed.goal ?? '',
        proteinPreference: parsed.proteinPreference ?? '',
        carbBias: parsed.carbBias ?? '',
      });
    } catch (e) {
      console.warn('[PLAN] Failed to read healthy survey from localStorage:', e);
    }
  }, []);

  // Generate a fresh 7-day dinner plan and persist it
    const generateAndSave = useCallback(async () => {
    if (!prefs || !userId) return;
    trackEvent('generate_plan_click');

    // Prevent duplicate generations (double click, re-entrancy, slow network)
    if (generatingRef.current) {
      console.log('[PLAN] generateAndSave ignored (already running)');
      return;
    }
    generatingRef.current = true;
    setGenerating(true);

    try {

    // Use local survey if present, otherwise fall back to DB-stored answers
    const effectiveSurvey: HealthySurvey | null =
      healthySurvey ??
      (prefs.healthy_goal ||
      prefs.healthy_protein_style ||
      prefs.healthy_carb_pref
        ? {
            goal: prefs.healthy_goal,
            proteinPreference: prefs.healthy_protein_style,
            carbBias: prefs.healthy_carb_pref,
          }
        : null);

    // Build an optional healthy profile for the planner from saved preferences
    // and the micro-survey answers.
    let healthyProfile: HealthyProfile | undefined;

    if (prefs.healthy_whole_food || prefs.kid_friendly) {
      healthyProfile = {
        ...DEFAULT_HEALTHY_WHOLE_FOOD_PROFILE,
        wholeFoodFocus: prefs.healthy_whole_food ?? true,
        kidFriendly: prefs.kid_friendly,
      };

      if (effectiveSurvey) {
        if (effectiveSurvey.goal) {
          healthyProfile.primaryGoal = effectiveSurvey.goal;
        }

        if (effectiveSurvey.proteinPreference) {
          healthyProfile.proteinPreference = effectiveSurvey.proteinPreference;
        }

        if (effectiveSurvey.carbBias) {
          healthyProfile.carbBias = effectiveSurvey.carbBias;
        }

        // Auto-tunes based on goal:
        if (effectiveSurvey.goal === 'weight') {
          if (
            healthyProfile.maxUltraProcessedMealsPerWeek == null ||
            healthyProfile.maxUltraProcessedMealsPerWeek > 1
          ) {
            healthyProfile.maxUltraProcessedMealsPerWeek = 1;
          }
        } else if (effectiveSurvey.goal === 'metabolic') {
          healthyProfile.maxAddedSugarPerDay = 'low';
        }
      }
    }

    const allergy = expandAllergyTerms(prefs.allergies || []);
    const dislike = new Set((prefs.dislikes || []).map((d) => d.toLowerCase()));    
    const pantrySet = new Set(pantry.map((p) => p.name));

    // Build ingredient index (same as before)
    const ingIndex = new Map<string, Ing[]>();
    ings.forEach((i) => {
      const arr = ingIndex.get(i.recipe_id) || [];
      arr.push(i);
      ingIndex.set(i.recipe_id, arr);
    });

    // ---------- 0) Build filtered recipe pool based on preferences ----------
    const DIET_FORBIDDEN_BY_ING: Record<string, RegExp[]> = {
      vegetarian: [
        /\bchicken\b/i,
        /\bbeef\b/i,
        /\bpork\b/i,
        /\bham\b/i,
        /\bsausage\b/i,
        /\bbacon\b/i,
        /\bturkey\b/i,
        /\bshrimp\b/i,
        /\banchovies?\b/i,
      ],
      vegan: [
        /\bchicken\b/i,
        /\bbeef\b/i,
        /\bpork\b/i,
        /\bham\b/i,
        /\bsausage\b/i,
        /\bbacon\b/i,
        /\bturkey\b/i,
        /\bshrimp\b/i,
        /\banchovies?\b/i,
        /\beggs?\b/i,
        /\bcheese\b/i,
        /\bmilk\b/i,
        /\byogurt\b/i,
        /\bbutter\b/i,
      ],
    };

    function violatesDiet(ri: Ing[], diet: string): boolean {
      const rules = DIET_FORBIDDEN_BY_ING[diet] || [];
      if (!rules.length) return false;
      return ri.some((it) => rules.some((rx) => rx.test(it.name)));
    }

    function hasForbiddenFromSet(ri: Ing[], terms: Set<string>): boolean {
      if (!terms.size) return false;
      return ri.some((it) => hasAnyTerm(it.name, terms));
    }

    const filteredRecipes: Recipe[] = recipes.filter((r) => {
      const ri = ingIndex.get(r.id) || [];

      if (violatesDiet(ri, prefs.diet)) return false;
      if (hasForbiddenFromSet(ri, allergy)) return false;
      if (hasForbiddenFromSet(ri, dislike)) return false;

      return true;
    });

    const pool: Recipe[] = filteredRecipes.length ? filteredRecipes : recipes;
    if (!filteredRecipes.length) {
      console.warn(
        '[PLAN] All recipes filtered by prefs; falling back to full list.',
      );
    }

    let chosen: Recipe[] | null = null;
    let mode: 'llm' | 'heuristic' | null = null;

    try {
      const pantryNames = Array.from(pantrySet);

      const recipeLite = pool.map((r) => ({
        id: r.id,
        title: r.title,
        time_min: r.time_min,
        diet_tags: r.diet_tags,
        ingredients: (ingIndex.get(r.id) || []).map((it) =>
          it.name.toLowerCase(),
        ),
        is_favorite: favorites.has(r.id),
      }));

            // Build the exact payload we send to /api/llm-plan (so the key is meaningful)
      const llmPayload = {
        pantryNames,
        prefs: {
          diet: prefs.diet,
          allergies: prefs.allergies,
          dislikes: prefs.dislikes,
          max_prep_minutes: prefs.max_prep_minutes,
          budget_level: prefs.budget_level,
          // favorite_mode: prefs.favorite_mode,
          // healthy_whole_food: prefs.healthy_whole_food,
          // kid_friendly: prefs.kid_friendly,
          // healthy_goal: prefs.healthy_goal,
          // healthy_protein_style: prefs.healthy_protein_style,
          // healthy_carb_pref: prefs.healthy_carb_pref,
        },
        recipes: recipeLite,
        days: 7,
        healthyProfile, // may be undefined
      };

      // Skip identical inputs if user clicks regenerate repeatedly (prevents extra API calls + extra saved plans)
      const reqKey = await sha256Hex(JSON.stringify(llmPayload));
      const nowTs = Date.now();
      const tooSoonMs = 30_000; // 30 seconds (tunable)
      if (
        lastPlanReqKeyRef.current === reqKey &&
        nowTs - lastPlanReqAtRef.current < tooSoonMs
      ) {
        console.log('[PLAN] Skipping LLM call: identical inputs too soon');
        return;
      }

      const res = await fetch('/api/llm-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pantryNames,
          prefs: {
            diet: prefs.diet,
            allergies: prefs.allergies,
            dislikes: prefs.dislikes,
            max_prep_minutes: prefs.max_prep_minutes,
            budget_level: prefs.budget_level,
   //            favorite_mode: prefs.favorite_mode,
   //            healthy_whole_food: prefs.healthy_whole_food,
   //            kid_friendly: prefs.kid_friendly,
   //            healthy_goal: prefs.healthy_goal,
   //            healthy_protein_style: prefs.healthy_protein_style,
   //            healthy_carb_pref: prefs.healthy_carb_pref,
          },
          recipes: recipeLite,
          days: 7,
          healthyProfile, // may be undefined → omitted on JSON.stringify
        }),
      });

      if (res.ok) {
        const data: { ok: boolean; recipeIds?: string[] } = await res.json();
        if (data.ok && data.recipeIds && data.recipeIds.length) {
          const byId = new Map(pool.map((r) => [r.id, r]));

          const picked = data.recipeIds
            .map((id) => byId.get(id))
            .filter((r): r is Recipe => !!r);

          if (picked.length) {
            const finalPicked = picked.filter((r) => {
              const ri = ingIndex.get(r.id) || [];
              if (violatesDiet(ri, prefs.diet)) return false;
              if (hasForbiddenFromSet(ri, allergy)) return false;
              if (hasForbiddenFromSet(ri, dislike)) return false;
              return true;
            });

            chosen = finalPicked.length ? finalPicked : picked;
            setPlannerMode('llm');
            mode = 'llm';
            console.log(
              '[PLAN] Using LLM-selected recipes:',
              chosen.map((p) => p.title),
            );
            // Mark this input as the latest successful request
            lastPlanReqKeyRef.current = reqKey;
            lastPlanReqAtRef.current = Date.now();
          }
        }
      } else {
        console.warn('[PLAN] /api/llm-plan returned status', res.status);
      }
    } catch (e) {
      console.error('[PLAN] LLM plan failed (falling back to heuristic):', e);
    }

    // ---------- 2) Fallback: heuristic ----------
    if (!chosen || !chosen.length) {
      const scored = pool
        .map((r) => {
          const ri = ingIndex.get(r.id) || [];
          let score = 0;

          // 1) Prefer faster recipes
          score += r.time_min <= (prefs.max_prep_minutes ?? 45) ? 2 : -2;

          // 2) Diet tag boost
          if (
            prefs.diet !== 'none' &&
            (r.diet_tags || []).includes(prefs.diet)
          ) {
            score += 1;
          }

          // 3) Pantry usage / avoid allergens / dislikes
          for (const it of ri) {
            const name = it.name.toLowerCase();
            if (pantrySet.has(name)) score += 1;
            if (allergy.has(name)) return { r, score: -999, ri };
            if (dislike.has(name)) score -= 2;
          }

          // 4) Favorites weighting
          if (favorites.has(r.id)) {
            score += prefs.favorite_mode === 'favorites' ? 6 : 1;
          }

          return { r, score, ri };
        })
        .filter((x) => x.score > -500)
        .sort((a, b) => b.score - a.score);

      const fallbackChosen = scored.slice(0, 7).map((x) => x.r);
      chosen = fallbackChosen;
      setPlannerMode('heuristic');
      mode = 'heuristic';
      console.log(
        '[PLAN] Using heuristic-selected recipes (fallback):',
        fallbackChosen.map((p) => p.title),
      );
    }

    if (!chosen || !chosen.length) {
      console.warn('[PLAN] No recipes chosen even after fallback');
      return;
    }

    // ---------- 2.5) Perishables-first ordering ----------
    const withPerishableScore = chosen.map((r) => {
      const ri = ingIndex.get(r.id) || [];
      const ingredientNames = ri.map((it) => it.name);

      const heuristicScore = computeRecipePerishability(ingredientNames);

      let dateScore: 1 | 2 | 3 | 4 = 1;
      for (const it of ri) {
        const pantryDate = pantryPerishBy.get(it.name.toLowerCase());
        if (!pantryDate) continue;
        const s = scoreFromPerishDate(pantryDate);
        if (s > dateScore) dateScore = s;
      }

      const finalScore = dateScore > heuristicScore ? dateScore : heuristicScore;

      return { recipe: r, perishability: finalScore };
    });

    withPerishableScore.sort((a, b) => b.perishability - a.perishability);
    chosen = withPerishableScore.map((x) => x.recipe);

    // Ensure we always save exactly 7 unique recipes (defensive against LLM duplicates / over-return)
   chosen = uniqueByIdLimit(chosen, 7);

   if (chosen.length < 7) {
   console.warn('[PLAN] Fewer than 7 unique recipes after filtering/dedupe:', chosen.length);
   }

    // ---------- 3) Persist to Supabase ----------
    const newShareId =
   (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

   const { data: planRow, error: planErr } = await supabase
   .from('user_meal_plan')
   .insert({ user_id: userId, share_id: newShareId })
   .select('id,generated_at,share_id')
   .single();
    if (planErr || !planRow) {
      console.error(planErr);
      return;
    }

    const itemsPayload = chosen.map((r, idx) => ({
      plan_id: planRow.id,
      recipe_id: r.id,
      position: idx,
    }));
    const { error: itemsErr } = await supabase
      .from('user_meal_plan_recipes')
      .insert(itemsPayload);
    if (itemsErr) {
      console.error(itemsErr);
      return;
    }

    setMeals(chosen);
    setPlanMeta({ id: planRow.id, generated_at: planRow.generated_at, share_id: planRow.share_id ?? null });
    setStale(false);
    recomputeShopping(chosen);
    trackEvent('generate_plan_success', {
    plan_id: planRow.id,
    share_id: planRow.share_id ?? null,
    mode,
   });
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }, [
    prefs,
    userId,
    pantry,
    pantryPerishBy,
    ings,
    recipes,
    recomputeShopping,
    favorites,
    healthySurvey,
  ]);

  function downloadCSV() {
    const header = 'name,qty,unit';
    const lines = shopping.map((s) => `${s.name},${s.qty},${s.unit}`);
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shopping_list.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyToClipboard() {
    if (!shopping.length) {
      alert('Shopping list is empty.');
      return;
    }

    const lines = shopping.map((s) => {
      const disp = formatShoppingItem(s);
      const qtyPart = disp.qtyLabel ? `${disp.qtyLabel} ` : '';
      const unitPart = disp.unitLabel ? `${disp.unitLabel} ` : '';
      return `• ${qtyPart}${unitPart}${disp.nameLabel}`.trim();
    });

    const text = lines.join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          alert('Shopping list copied. You can paste it into Notes or any app.');
        })
        .catch(() => {
          alert(
            'Could not copy automatically. You can select and copy the list manually.',
          );
        });
    } else {
      alert(
        'Clipboard is not available in this browser. You can select and copy the list manually.',
      );
    }
  }

  async function copyShareLink() {
  if (!planMeta?.id) {
    alert('No plan to share yet. Generate a plan first.');
    return;
  }

  let shareId = planMeta.share_id ?? null;

  // If this plan doesn't have a share_id yet, create one now.
  if (!shareId) {
    const generated =
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const { data, error } = await supabase
      .from('user_meal_plan')
      .update({ share_id: generated })
      .eq('id', planMeta.id)
      .select('share_id')
      .single();

    if (error) {
      console.error(error);
      alert('Could not create a share link. Please try again.');
      return;
    }

    const shareRow = data as unknown as { share_id?: string | null } | null;
    shareId = shareRow?.share_id ?? null;

    // ✅ IMPORTANT: use share_id: shareId (not share_id)
    setPlanMeta((prev) => (prev ? { ...prev, share_id: shareId } : prev));
  }

  if (!shareId) {
    alert('Could not create a share link. Please try again.');
    return;
  }

  const url = `${window.location.origin}/share/plan/${shareId}`;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    alert('Share link copied!');
    trackEvent('copy_share_link', { plan_id: planMeta.id, share_id: shareId });
  } else {
    prompt('Copy this share link:', url);
  }
}

  // NEW: does this plan include at least one favorite?
  const hasFavoriteInPlan = useMemo(() => {
    if (!favorites || favorites.size === 0 || meals.length === 0) return false;
    return meals.some((m) => favorites.has(m.id));
  }, [meals, favorites]);

  // NEW: should we show the favorites badge at all?
  const showFavoritesBadge =
    hasFavoriteInPlan && !stale && prefs?.favorite_mode === 'favorites';

  // Group shopping items by store section (category)
  const CATEGORY_ORDER: PantryCategory[] = [
    'produce',
    'protein',
    'grains',
    'dairy',
    'canned',
    'frozen',
    'condiments',
    'baking',
    'snacks',
    'beverages',
    'other',
  ];

  const itemsByCategory = new Map<
    PantryCategory,
    (typeof pricedShopping)[number][]
  >();

  pricedShopping.forEach((it) => {
    const cat = (it.category ?? 'other') as PantryCategory;
    const arr = itemsByCategory.get(cat) || [];
    arr.push(it);
    itemsByCategory.set(cat, arr);
  });

  const groupedShopping = CATEGORY_ORDER
    .map((cat) => ({
      category: cat,
      items: itemsByCategory.get(cat) ?? [],
    }))
    .filter((g) => g.items.length > 0);

  // For header colSpan in the table (3 base cols + optional)
  const shoppingColCount =
    3 +
    (enablePriceHints && storeId !== 'none' ? 1 : 0) +
    (shopPlatform !== 'none' ? 1 : 0);

  if (loading) return <p className="max-w-3xl mx-auto">Loading…</p>;

  const openRecipe = meals7.find((m) => m.id === openId) || null;
  const openIngs = openId ? ingByRecipe.get(openId) || [] : [];
  const generatedLabel = planMeta
    ? new Date(planMeta.generated_at).toLocaleString()
    : null;
  
  // Allergens present in the open recipe, based on user preferences (mapped to real ingredient words)
const allergyHits: string[] = (() => {
  if (!prefs || !openRecipe || !openIngs.length) return [];

  const toggles = (prefs.allergies ?? [])
    .map((a) => a.toLowerCase().trim())
    .filter(Boolean);

  if (!toggles.length) return [];

  // Map toggles -> keyword lists (so UI shows "dairy", but we match "milk", "cheese", etc.)
  const TOGGLE_TO_KEYWORDS: Record<string, string[]> = {
    dairy: Array.from(expandAllergyTerms(['dairy'])),
    gluten: Array.from(expandAllergyTerms(['gluten'])),
    egg: Array.from(expandAllergyTerms(['egg'])),
    peanut: Array.from(expandAllergyTerms(['peanut'])),
    shellfish: Array.from(expandAllergyTerms(['shellfish'])),
    soy: Array.from(expandAllergyTerms(['soy'])),
    sesame: Array.from(expandAllergyTerms(['sesame'])),
  };

  const hits = new Set<string>();

  for (const it of openIngs) {
    const lowerName = it.name.toLowerCase();

    for (const toggle of toggles) {
      const keywords = TOGGLE_TO_KEYWORDS[toggle] ?? [toggle];

      for (const kw of keywords) {
        const term = kw.toLowerCase().trim();
        if (!term) continue;
        const rx = new RegExp(`\\b${escapeRegex(term)}s?\\b`, 'i');
        if (rx.test(lowerName)) {
          hits.add(toggle); // <-- store the TOGGLE label (e.g. "dairy")
          break;
        }
      }
    }
  }

  return Array.from(hits);
})();

  // Do we have any numeric nutrition data on this recipe?
  const hasNutrition =
    !!openRecipe &&
    (typeof openRecipe.calories === 'number' ||
      typeof openRecipe.protein_g === 'number');  

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-start justify-between gap-4">
          {/* LEFT: title only */}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              Your 7-Day Plan
            </h1>
          </div>

          {/* CENTER: AI + favorites pills */}
          <div className="flex flex-col items-center justify-center gap-1 px-2">
            {plannerMode === 'llm' && !stale && (
              <div className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-900/40 dark:text-indigo-200">
                This plan was AI-optimized ✨
              </div>
            )}

            {showFavoritesBadge && (
              <div className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-900/40 dark:text-indigo-200">
                ⭐ Prioritized your favorites
              </div>
            )}
          </div>

          {/* RIGHT: regenerate button */}
        <div className="flex-shrink-0 pt-[2px]">
  <button
    onClick={generateAndSave}
    disabled={generating}
    className={`rounded px-4 py-2 bg-black text-white hover:opacity-90 dark:bg-white dark:text-black ${
      generating ? 'opacity-50 cursor-not-allowed' : ''
    }`}
  >
    {generating ? 'Generating…' : meals.length ? 'Regenerate plan' : 'Generate plan'}
  </button>
</div>
        </div>

        {/* Row 2: date */}
        {generatedLabel && (
  <div className="mt-1 flex items-center justify-between gap-4">
    <p className="text-sm text-gray-600 dark:text-gray-400">
      Generated on {generatedLabel}
    </p>

    <button
      onClick={copyShareLink}
      disabled={!planMeta}
      className={`rounded px-4 py-2 border border-gray-300 dark:border-gray-700 text-sm
        text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-neutral-800
        ${!planMeta ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      Copy share link
    </button>
  </div>
)}

        {/* Row 3: shop with / price store / disclaimer */}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          {/* Preferred grocery platform */}
          <div className="flex items-center gap-2">
            <label className="text-gray-700 dark:text-gray-300">Shop with</label>
            <select
              className="rounded border px-2 py-1 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100"
              value={shopPlatform}
              onChange={(e) =>
                setShopPlatform(
                  e.target.value as 'none' | 'instacart' | 'walmart' | 'amazon',
                )
              }
            >
              <option value="none">Choose…</option>
              <option value="instacart">Instacart</option>
              <option value="walmart">Walmart</option>
              <option value="amazon">Amazon Fresh</option>
            </select>
          </div>

          {/* Price hints store selector */}
          {enablePriceHints && (
            <div className="flex items-center gap-2">
              <label className="text-gray-700 dark:text-gray-300">
                Price store
              </label>
              <select
                className="rounded border px-2 py-1 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value as StoreId)}
              >
                {STORES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {enablePriceHints && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Example pricing only – not yet store- or zip-specific.
            </span>
          )}
        </div>

        {/* Stale warning */}
        {stale && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2 text-sm dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100">
            Your pantry or preferences changed since this plan was created.
            <span className="ml-2 font-medium">Regenerate to refresh.</span>
          </div>
        )}
      </div>

      {/* Meals + shopping card */}
      {meals.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm">
          <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-gray-100">
            Meals
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            {meals7.map((m) => (
              <div
                key={m.id}
                className="border rounded p-3 border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{m.title}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      {m.time_min} min
                    </div>
                  </div>
                  <FavoriteButton recipe={{ id: m.id, title: m.title }} />
                </div>

                <p className="text-sm mt-2 line-clamp-3">{m.instructions}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setOpenId(m.id)}
                    className="rounded border px-3 py-1 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
                  >
                    View Recipe
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h2 className="text-xl font-semibold mt-6 mb-2 text-gray-900 dark:text-gray-100">
            Shopping List
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-200 dark:border-gray-800">
              <thead className="bg-gray-100 dark:bg-neutral-800">
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-100 text-left">
                    Item
                  </th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-100 text-left">
                    Qty
                  </th>
                  <th className="p-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-100 text-left">
                    Unit
                  </th>
                  {enablePriceHints && storeId !== 'none' && (
                    <th className="p-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-100 text-right">
                      Est. Price
                    </th>
                  )}
                  {shopPlatform !== 'none' && (
                    <th className="p-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-100 text-left">
                      Shop
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {groupedShopping.map((group) => (
                  <Fragment key={group.category}>
                    {/* Category header row */}
                    <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-neutral-800/80">
                      <td
                        className="p-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-100"
                        colSpan={shoppingColCount}
                      >
                        {prettyCategoryLabel(group.category)}
                      </td>
                    </tr>

                    {/* Items in this category */}
                    {group.items.map((s, idx) => {
                      const disp = formatShoppingItem(s);
                      const shopUrl =
                        shopPlatform === 'instacart'
                          ? buildInstacartUrl(s.name)
                          : shopPlatform === 'walmart'
                          ? buildWalmartUrl(s.name)
                          : shopPlatform === 'amazon'
                          ? buildAmazonFreshUrl(s.name)
                          : null;
                      const healthHint = getHealthSwapHintForItem(s, prefs);

                      return (
                        <tr
                          key={`${group.category}-${s.name}-${idx}`}
                          className="border-t border-gray-200 dark:border-gray-800"
                        >
                          <td className="p-2 align-top">
                            <div>{disp.nameLabel}</div>
                            {healthHint && (
                              <div className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                                {healthHint}
                              </div>
                            )}
                          </td>
                          <td className="p-2">{disp.qtyLabel}</td>
                          <td className="p-2">{disp.unitLabel}</td>

                          {enablePriceHints && storeId !== 'none' && (
                            <td className="p-2 text-right">
                              {s.estPrice != null
                                ? `$${s.estPrice.toFixed(2)}`
                                : '—'}
                            </td>
                          )}

                          {shopPlatform !== 'none' && (
                            <td className="p-2">
                              {shopUrl ? (
                                <a
                                  href={shopUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-indigo-600 hover:underline"
                                >
                                  Open in{' '}
                                  {shopPlatform === 'instacart'
                                    ? 'Instacart'
                                    : shopPlatform === 'walmart'
                                    ? 'Walmart'
                                    : 'Amazon Fresh'}
                                </a>
                              ) : (
                                <span className="text-xs text-gray-400">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}

                {groupedShopping.length === 0 && (
                  <tr>
                    <td
                      className="p-3 text-gray-500 dark:text-gray-400"
                      colSpan={shoppingColCount}
                    >
                      No items.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {enablePriceHints && storeId !== 'none' && (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              Estimated total (for items with example prices):{' '}
              <span className="font-medium">${estTotal.toFixed(2)}</span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={downloadCSV}
              className="rounded px-4 py-2 bg-black text-white hover:opacity-90 dark:bg-white dark:text-black"
            >
              Download CSV
            </button>
            <button
              onClick={copyToClipboard}
              className="rounded px-4 py-2 border border-gray-300 dark:border-gray-700 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-neutral-800"
            >
              Copy list (for Notes)
            </button>
          </div>
        </div>
      )}

      {/* Modal */}
      <Modal open={!!openId} onClose={closeRecipeModal}>
                {openRecipe ? (
          <div>
            <div className="flex items-start justify-between">
              <h3 className="text-xl font-semibold">{openRecipe.title}</h3>
              <FavoriteButton
                recipe={{ id: openRecipe.id, title: openRecipe.title }}
              />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              {openRecipe.time_min} min
            </div>

            {/* Ingredients */}
            <h4 className="font-medium mt-3 mb-1">Ingredients</h4>
            <ul className="list-disc pl-5 space-y-1">
              {openIngs.map((it, idx) => (
                <li key={idx}>
                  {it.qty ?? ''} {it.unit ?? ''} {it.name}
                  {it.optional ? ' (optional)' : ''}
                </li>
              ))}
              {openIngs.length === 0 && (
                <li className="text-gray-500 dark:text-gray-400">
                  No ingredients listed.
                </li>
              )}
            </ul>

            {/* Allergens (based on your saved Preferences) */}
            {prefs && (
              <div className="mt-4">
                <h4 className="font-medium mb-1">Allergens</h4>

                {allergyHits.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {allergyHits.map((a) => (
                      <span
                        key={a}
                        className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                      >
                        ⚠ {a}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Based on your saved allergies, we don&apos;t see a direct match
                    in this ingredient list. Please still double-check ingredients
                    and packaging.
                  </p>
                )}
              </div>
            )}

            {/* Nutrition */}
            <div className="mt-4">
              <h4 className="font-medium mb-1">Nutrition (per serving)</h4>

              {hasNutrition ? (
                <ul className="space-y-0.5 text-sm text-gray-700 dark:text-gray-300">
                  {typeof openRecipe.calories === 'number' && (
                    <li>
                      <span className="font-medium">
                        {Math.round(openRecipe.calories)} kcal
                      </span>
                    </li>
                  )}
                  {typeof openRecipe.protein_g === 'number' && (
                    <li>{openRecipe.protein_g} g protein</li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Nutrition estimates are coming soon for this recipe.
                </p>
              )}

              <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
                This information is an estimate only and is not medical advice.
              </p>
            </div>

            {/* Instructions */}
            <h4 className="font-medium mt-4 mb-1">Instructions</h4>
            <p className="whitespace-pre-wrap leading-relaxed">
              {openRecipe.instructions}
            </p>

            <div className="mt-4 text-right">
              <button
                onClick={closeRecipeModal}
                className="rounded border px-4 py-2 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default function PlanPage() {
  return (
    <Suspense fallback={<p className="max-w-3xl mx-auto">Loading…</p>}>
      <PlanPageInner />
    </Suspense>
  );
}

/** Simple modal component */
function Modal({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* dialog */}
      <div className="absolute inset-0 flex items-start justify-center mt-16 px-4">
        <div className="w-full max-w-2xl rounded-lg bg-white dark:bg-neutral-900 p-6 shadow-lg border border-gray-200 dark:border-gray-800">
          {children}
        </div>
      </div>
    </div>
  );
}