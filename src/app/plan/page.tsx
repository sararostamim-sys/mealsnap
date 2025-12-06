// src/app/plan/page.tsx
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
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
import React, { Fragment } from 'react';

type Recipe = {
  id: string;
  title: string;
  time_min: number;
  diet_tags: string[] | null;
  instructions: string;
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

export default function PlanPage() {
  useRequireAuth();

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const [pantry, setPantry] = useState<PantryRow[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);

  const [meals, setMeals] = useState<Recipe[]>([]);
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [planMeta, setPlanMeta] = useState<{ id: string; generated_at: string } | null>(
    null,
  );
  const [stale, setStale] = useState(false);

  const enablePriceHints = process.env.NEXT_PUBLIC_ENABLE_PRICE_HINTS === '1';
  const [storeId, setStoreId] = useState<StoreId>('none');

  // Modal state
  const [openId, setOpenId] = useState<string | null>(null);

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
    if (meals.length) recomputeShopping(meals);
  }, [meals, recomputeShopping]);

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
        .select('id, generated_at, user_meal_plan_recipes (recipe_id, position)')
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
        setPlanMeta({ id: plan.id, generated_at: plan.generated_at });

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

    const allergy = new Set((prefs.allergies || []).map((a) => a.toLowerCase()));
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
            console.log(
              '[PLAN] Using LLM-selected recipes:',
              chosen.map((p) => p.title),
            );
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

    // ---------- 3) Persist to Supabase ----------
    const { data: planRow, error: planErr } = await supabase
      .from('user_meal_plan')
      .insert({ user_id: userId })
      .select('id,generated_at')
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
    setPlanMeta({ id: planRow.id, generated_at: planRow.generated_at });
    setStale(false);
    recomputeShopping(chosen);
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

  const openRecipe = meals.find((m) => m.id === openId) || null;
  const openIngs = openId ? ingByRecipe.get(openId) || [] : [];
  const generatedLabel = planMeta
    ? new Date(planMeta.generated_at).toLocaleString()
    : null;

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
          <div className="flex-shrink-0 pt-1">
            <button
              onClick={generateAndSave}
              className="rounded px-4 py-2 bg-black text-white hover:opacity-90 dark:bg:white dark:text-black"
            >
              {meals.length ? 'Regenerate plan' : 'Generate plan'}
            </button>
          </div>
        </div>

        {/* Row 2: date */}
        {generatedLabel && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Generated on {generatedLabel}
          </p>
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
            {meals.map((m) => (
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
      <Modal open={!!openId} onClose={() => setOpenId(null)}>
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

            <h4 className="font-medium mt-4 mb-1">Instructions</h4>
            <p className="whitespace-pre-wrap leading-relaxed">
              {openRecipe.instructions}
            </p>

            <div className="mt-4 text-right">
              <button
                onClick={() => setOpenId(null)}
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