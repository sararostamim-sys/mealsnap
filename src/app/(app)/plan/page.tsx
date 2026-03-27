// src/app/plan/page.tsx
'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { DEFAULT_HEALTHY_WHOLE_FOOD_PROFILE } from '@/lib/healthyProfile';
import type { HealthyProfile } from '@/lib/healthyProfile';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import FavoriteButton from '@/components/FavoriteButton';
import { getDevUserId } from '@/lib/user';
import {
  smartMergeNeedsWithSubstitutions,
  subtractPantryFromNeeds,
  ShoppingItem,
  RawNeed,
  normalizeIngredientName,
} from '@/lib/shopping';
import { STORES, getPriceEstimate, StoreId } from '@/lib/pricing';
import {
  buildInstacartUrl,
  buildWalmartUrl,
  buildAmazonFreshUrl,
} from '@/lib/groceryLinks';
import { computeRecipePerishability, scoreFromPerishDate } from '@/lib/perishables';
import type { PantryCategory } from '@/lib/pantryCategorizer';
import { prettyCategoryLabel } from '@/lib/pantryCategorizer';
import { Fragment, Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { trackEvent } from '@/lib/analytics';
import Modal from '@/components/Modal';

type Recipe = {
  id: string;
  title: string;
  time_min: number;
  diet_tags: string[] | null;
  instructions: string;
  servings?: number | null;
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
  favorite_mode: 'variety' | 'favorites';
  healthy_whole_food: boolean;
  kid_friendly: boolean;
  dinners_per_week: number; // 3–7
  people_count: number;     // 1–6
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
// Debug toggle (set NEXT_PUBLIC_DEBUG_PLAN=1 to enable verbose plan logs)
const DEBUG_PLAN = process.env.NEXT_PUBLIC_DEBUG_PLAN === '1';

  // Pantry staples we don’t want to show in the shopping list
const STAPLE_SKIP = new Set([
  'salt',
  'kosher salt',
  'sea salt',

  'black pepper',
  'pepper',

  'olive oil',
  'cooking oil',
  'vegetable oil',
  'canola oil',
  'avocado oil',

  // optional: common spices
  'cumin',
  'paprika',
  'chili powder',
  'garlic powder',
  'onion powder',
  'red pepper flake',
]);

type PantryRow = {
  name: string;
  qty: number;
  unit: string;
  updated_at: string;
  perish_by: string | null;
  use_soon: boolean;
};

type PlanItem = { recipe_id: string; position: number };

type PlanHeader = {
  id: string;
  generated_at: string;
  share_id: string | null;
  people_count: number | null;        
  recipe_prefs_sig: string | null;
  user_meal_plan_recipes?: PlanItem[];
};

type PrefsRow = Partial<{
  diet: string;
  allergies: string[];
  disliked_ingredients: string[];
  max_prep_time: number;
  favorite_mode: string;
  healthy_whole_food: boolean;
  kid_friendly: boolean;
  healthy_goal: string;
  healthy_protein_style: string;
  healthy_carb_pref: string;
  updated_at: string;
  dinners_per_week: number;
  people_count: number;
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


function formatShoppingItem(item: ShoppingItem): DisplayShoppingItem {
  const name = item.name;
  const qty = item.qty;
  const unit = item.unit;

  const HERB_BUNCH = /(basil|dill)/i;
  const LEAFY_BAG = /spinach/i;

  const isCountUnit = unit === 'unit';

  // If shopping.ts already decided it's a container, show it as such.
  // (carton/bottle/can/block/bunch/etc should appear in the unit column.)
  const isContainerUnit = ['can', 'bottle', 'carton', 'block', 'bunch', 'clove'].includes(unit);

  // Leafy greens like spinach → keep bag behavior (but do NOT add "(about ...)" into name)
  if (LEAFY_BAG.test(name)) {
    // If we’re still in cups and it’s large, allow "bag" as a convenience unit
    if (unit === 'cup' && qty >= 2) {
      return {
        qtyLabel: '1',
        unitLabel: 'bag',
        nameLabel: name,
      };
    }
  }

  // Herbs like basil / dill → 1 bunch once amount is large
  // (This is purely display convenience. No "(about ...)" in name.)
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

  // If we have a container unit, show it in the unit column.
  if (isContainerUnit) {
    return {
      qtyLabel: String(qty),
      unitLabel: unit,
      nameLabel: name,
    };
  }

  // For normal count items (onion, lemon, etc.)
  if (isCountUnit) {
    return {
      qtyLabel: String(qty),
      unitLabel: '',
      nameLabel: name,
    };
  }

  // Default: show qty + unit (no "(about ...)" injected into name)
  return {
    qtyLabel: String(qty),
    unitLabel: unit === 'unit' ? '' : unit,
    nameLabel: name,
  };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function normalizeTermSet(terms: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of terms) {
    const n = normalizeIngredientName(String(t));
    if (n) out.add(n);
  }
  return out;
}

function matchesAnyNormalizedTerm(ingredientName: string, termsNorm: Set<string>): boolean {
  if (!termsNorm.size) return false;

  const ingNorm = normalizeIngredientName(ingredientName);
  if (!ingNorm) return false;

  // Exact match
  if (termsNorm.has(ingNorm)) return true;

  // Token / phrase containment (handles multi-word terms like "soy sauce")
  for (const t of termsNorm) {
    if (!t) continue;

    // If the term is multi-word, substring match is usually what we want
    if (t.includes(' ')) {
      if (ingNorm.includes(t)) return true;
      continue;
    }

    // For single tokens, do word-boundary matching on normalized strings
    const rx = new RegExp(`\\b${escapeRegex(t)}s?\\b`, 'i');
    if (rx.test(ingNorm)) return true;
  }

  return false;
}

function recipeMatchesAnyRegex(
  recipe: Pick<Recipe, 'title' | 'diet_tags'>,
  ri: Ing[],
  rules: RegExp[],
): boolean {
  if (!rules.length) return false;

  const haystacks = [
    recipe.title || '',
    ...(recipe.diet_tags ?? []).map((t) => String(t)),
    ...ri.map((it) => String(it.name || '')),
  ];

  return haystacks.some((text) => rules.some((rx) => rx.test(text)));
}

type IngredientWeightBand = 'major' | 'medium' | 'minor';

function ingredientWeightBand(nameNorm: string): IngredientWeightBand {
  // Heuristic: treat proteins/primary carbs/primary produce as "major".
  // Everything else defaults to medium/minor.
  const n = nameNorm;

  // Major proteins
  if (
    /(\bchicken\b|\bbeef\b|\bpork\b|\bturkey\b|\bshrimp\b|\bsalmon\b|\btuna\b|\begg\b|\beggs\b|\btofu\b|\btempeh\b|\blentil\b|\blentils\b|\bbeans\b|\bchickpea\b|\bchickpeas\b)/.test(n)
  ) {
    return 'major';
  }

  // Major starches / grains
  if (
    /(\brice\b|\bquinoa\b|\bpasta\b|\bnoodle\b|\btortilla\b|\bbread\b|\bpotato\b|\bpotatoes\b|\boats\b)/.test(n)
  ) {
    return 'major';
  }

  // Primary produce
  if (
    /(\bonion\b|\bgarlic\b|\btomato\b|\bspinach\b|\bbroccoli\b|\bpepper\b|\bbell pepper\b|\bzucchini\b|\bcarrot\b|\bcauliflower\b|\bmushroom\b|\bcilantro\b|\bdill\b|\bbasil\b)/.test(n)
  ) {
    return 'major';
  }

  // Minor: oils/spices/condiments/acid
  if (
    /(\boil\b|\bsalt\b|\bpepper\b|\bcumin\b|\bpurchase\b|\bpaprika\b|\bchili\b|\bflake\b|\bvinegar\b|\blemon\b|\blime\b|\bsoy sauce\b|\bhot sauce\b|\bsauce\b|\bmustard\b|\bketchup\b)/.test(n)
  ) {
    return 'minor';
  }

  return 'medium';
}

function ingredientWeight(nameNorm: string): number {
  const band = ingredientWeightBand(nameNorm);
  if (band === 'major') return 3;
  if (band === 'medium') return 2;
  return 0.5;
}

function daysUntil(date: Date): number {
  const ms = date.getTime() - Date.now();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
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
        fish: [
      'fish',
      'salmon',
      'tuna',
      'cod',
      'tilapia',
      'trout',
      'halibut',
      'anchovy',
      'anchovies',
      'sardine',
      'sardines',
    ],
    tree_nut: [
      'tree nut',
      'tree nuts',
      'almond',
      'almonds',
      'walnut',
      'walnuts',
      'pecan',
      'pecans',
      'cashew',
      'cashews',
      'pistachio',
      'pistachios',
      'hazelnut',
      'hazelnuts',
      'macadamia',
      'brazil nut',
      'brazil nuts',
      'pine nut',
      'pine nuts',
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

function hashStringToInt(s: string): number {
  // Deterministic small hash (no crypto needed)
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function fillPlanWithRepeats(
  base: Recipe[],
  target: number,
  strictPool: Recipe[],
  seed: string,
): Recipe[] {
  const out = base.slice(0, target);
  if (out.length >= target) return out;

  const pool = (strictPool || []).filter((r) => !!r?.id);
  if (!pool.length) return out; // nothing we can do

  // Stable order for deterministic cycling
  const poolSorted = pool.slice().sort((a, b) => a.id.localeCompare(b.id));
  const start = hashStringToInt(seed) % poolSorted.length;

  let i = 0;
  while (out.length < target) {
    out.push(poolSorted[(start + i) % poolSorted.length]);
    i++;
    // defensive guard (should never hit)
    if (i > target * 10) break;
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

function stableSorted(arr: string[] | null | undefined) {
  return (arr ?? []).map((x) => String(x)).sort();
}

/** Preferences that can change WHICH recipes get selected */
function recipePrefsSignature(p: Prefs) {
  return JSON.stringify({
    diet: p.diet ?? 'none',
    allergies: stableSorted(p.allergies),
    dislikes: stableSorted(p.dislikes),
    max_prep_minutes: p.max_prep_minutes ?? 45,
    favorite_mode: p.favorite_mode ?? 'variety',
    healthy_whole_food: !!p.healthy_whole_food,
    kid_friendly: !!p.kid_friendly,
    healthy_goal: p.healthy_goal ?? '',
    healthy_protein_style: p.healthy_protein_style ?? '',
    healthy_carb_pref: p.healthy_carb_pref ?? '',
    dinners_per_week: p.dinners_per_week ?? 7,
  });
}

// Group shopping items by store section (category)
  const CATEGORY_ORDER: PantryCategory[] = [
    'produce',
    'protein',
    'grains',
    'legumes',
    'dairy',
    'canned',
    'frozen',
    'condiments',
    'spices',
    'baking',
    'snacks',
    'beverages',
    'other',
  ];

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
  const [planMealCount, setPlanMealCount] = useState<number>(7);

    // Snapshot of prefs at the time the currently-loaded plan was generated
  const [planRecipePrefsSig, setPlanRecipePrefsSig] = useState<string | null>(null);
  const [planPeopleCount, setPlanPeopleCount] = useState<number | null>(null);

  // NEW: user-controlled planning knobs (fallbacks are safe)
  const dinnersPerWeek = prefs?.dinners_per_week ?? 7; // generation only
  const peopleCount = prefs?.people_count ?? 2;

  // Display count is the saved plan's size, not the preference
  const displayCount = planMealCount || meals.length || 7;

const mealsN = useMemo(() => {
  // IMPORTANT: do NOT de-dupe here — repeats are allowed to hit dinnersPerWeek
  return (meals || []).slice(0, displayCount).filter(Boolean);
}, [meals, displayCount]);

  const currentRecipeSig = useMemo(() => {
    return prefs ? recipePrefsSignature(prefs) : null;
  }, [prefs]);

    const legacyPlanMissingSnapshots =
  !!meals.length && (planPeopleCount == null || planRecipePrefsSig == null);

  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [planMeta, setPlanMeta] = useState<{
  id: string;
  generated_at: string;
  share_id?: string | null;
  } | null>(null);
  const [stale, setStale] = useState(false);

  const planTs = useMemo(
  () => (planMeta?.generated_at ? Date.parse(planMeta.generated_at) : 0),
  [planMeta?.generated_at],
);

const pantryMax = useMemo(() => {
  return pantry.length
    ? Math.max(
        ...pantry
          .map((p) => Date.parse(p.updated_at))
          .filter((n) => Number.isFinite(n)),
      )
    : 0;
}, [pantry]);

const pantryChangedSincePlan = !!planTs && pantryMax > planTs;

const recipePrefsChangedSincePlan =
  !!planRecipePrefsSig &&
  !!currentRecipeSig &&
  currentRecipeSig !== planRecipePrefsSig;

  const peopleChangedSincePlan =
  planPeopleCount != null && peopleCount !== planPeopleCount;

  const onlyPeopleChangedSincePlan =
  peopleChangedSincePlan && !pantryChangedSincePlan && !recipePrefsChangedSincePlan;

  const enablePriceHints = process.env.NEXT_PUBLIC_ENABLE_PRICE_HINTS === '1';
  const [storeId, setStoreId] = useState<StoreId>('none');

  // Modal state
  const [openId, setOpenId] = useState<string | null>(null);

    // Auto-open recipe modal when arriving with ?open=<recipeId>
   useEffect(() => {
    const id = searchParams.get('open');
    if (!id) return;

    // Only open if we can actually resolve this recipe in the current plan list
    const inPlan = mealsN.some((m) => m.id === id);
    if (inPlan) setOpenId(id);
  }, [searchParams, mealsN]);

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
  const resolveUserId = useCallback(async (): Promise<string> => {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const uid = user?.id ?? getDevUserId();
  setUserId(uid);
  return uid;
}, []);

  // Fetch latest pantry + preferences (used when returning to this page)
const refreshPantryAndPrefs = useCallback(async () => {
  const uid = userId ?? (await resolveUserId());
  if (!uid) return;

  const [pItems, pRes] = await Promise.all([
    supabase
  .from('pantry_items')
  .select('name,qty,unit,updated_at,perish_by,use_soon')
  .eq('user_id', uid),
    supabase.from('preferences').select('*').eq('user_id', uid).maybeSingle(),
  ]);

  const pantryRows: PantryRow[] = (pItems.data || []).map((x) => ({
  name: String(x.name).toLowerCase(),
  qty: Number(x.qty ?? 1) || 1,
  unit: String(x.unit ?? 'unit'),
  updated_at: x.updated_at || new Date(0).toISOString(),
  perish_by: x.perish_by ?? null,
  use_soon: !!(x as { use_soon?: boolean }).use_soon,
}));
  setPantry(pantryRows);

  const pr = (pRes.data ?? null) as PrefsRow | null;
  const prefsRow: Prefs = pr
    ? {
        diet: pr.diet ?? 'none',
        allergies: pr.allergies ?? [],
        dislikes: pr.disliked_ingredients ?? [],
        max_prep_minutes: pr.max_prep_time ?? 45,
        favorite_mode: pr.favorite_mode === 'favorites' ? 'favorites' : 'variety',
        healthy_whole_food: pr.healthy_whole_food ?? false,
        kid_friendly: pr.kid_friendly ?? false,
        dinners_per_week: pr.dinners_per_week ?? 7,
        people_count: pr.people_count ?? 2,
        healthy_goal: (pr.healthy_goal as Prefs['healthy_goal']) ?? '',
        healthy_protein_style: (pr.healthy_protein_style as Prefs['healthy_protein_style']) ?? '',
        healthy_carb_pref: (pr.healthy_carb_pref as Prefs['healthy_carb_pref']) ?? '',
        updated_at: pr.updated_at ?? undefined,
      }
    : {
        diet: 'none',
        allergies: [],
        dislikes: [],
        max_prep_minutes: 45,
        favorite_mode: 'variety',
        healthy_whole_food: false,
        kid_friendly: false,
        dinners_per_week: 7,
        people_count: 2,
        healthy_goal: '',
        healthy_protein_style: '',
        healthy_carb_pref: '',
      };

  setPrefs(prefsRow);
}, [userId, resolveUserId]);

// When user returns to the tab/page, refresh prefs so stale banner is accurate
useEffect(() => {
  const onFocus = () => {
    void refreshPantryAndPrefs();
  };

  window.addEventListener('focus', onFocus);

  const onVis = () => {
    if (document.visibilityState === 'visible') onFocus();
  };
  document.addEventListener('visibilitychange', onVis);

  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVis);
  };
}, [refreshPantryAndPrefs]);

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
    m.set(normalizeIngredientName(p.name), new Date(ts));
  });
  return m;
}, [pantry]);

// Build a fast lookup for "use soon" pantry items (normalized)
const pantryUseSoon = useMemo(() => {
  const s = new Set<string>();
  pantry.forEach((p) => {
    if (p.use_soon) s.add(normalizeIngredientName(p.name));
  });
  return s;
}, [pantry]);

  const recomputeShopping = useCallback(
  (chosen: Recipe[]) => {
    const rawNeeds: RawNeed[] = [];

    for (const r of chosen) {
      const ri = ingByRecipe.get(r.id) || [];

      const baseServings = r.servings ?? 2; // DB default is 2; keep safe fallback
      const multiplier = baseServings > 0 ? peopleCount / baseServings : 1;

      for (const it of ri) {
        const ingNorm = normalizeIngredientName(it.name);

        // Skip pantry staples (salt/pepper etc.)
        if (STAPLE_SKIP.has(ingNorm)) continue;

        // Staples and garnish: we decided to exclude optional items from shopping list
        if (it.optional) continue;

        const baseQty = it.qty ?? 1;
        const scaledQty = baseQty * multiplier;

        rawNeeds.push({
          name: it.name,
          qty: scaledQty,
          unit: it.unit ?? null,
        });
      }
    }

    const remainingNeeds = subtractPantryFromNeeds(
      rawNeeds,
      pantry.map((p) => ({
        name: p.name,
        qty: p.qty,
        unit: p.unit,
      })),
    );

    // Apply substitutions (pantry-aware swaps) before merging.
    // Block substitutions that conflict with allergies/dislikes.
    const blocked = new Set<string>();
    try {
      // Dislikes
      for (const d of prefs?.dislikes ?? []) {
        const n = normalizeIngredientName(String(d));
        if (n) blocked.add(n);
      }
      // Allergies (expanded into concrete ingredient terms)
      for (const t of Array.from(expandAllergyTerms(prefs?.allergies ?? []))) {
        const n = normalizeIngredientName(String(t));
        if (n) blocked.add(n);
      }
    } catch {
      // best-effort only
    }

    // Apply substitutions, but ALWAYS keep the original item in the list
    // and attach a note when a pantry substitution is available.
    const pantryNames = pantry.map((p) => normalizeIngredientName(p.name));
    const { items } = smartMergeNeedsWithSubstitutions(remainingNeeds, pantryNames, {
      blocked,
      keepOriginalInList: true,
    });

    setShopping(items);
  },
  [ingByRecipe, pantry, peopleCount, prefs],
);
  // Keep shopping list in sync when meals or ingredients change
  useEffect(() => {
    if (mealsN.length) recomputeShopping(mealsN);
  }, [mealsN, recomputeShopping]);

  // Initial load: user + pantry/prefs/recipes/ings + latest saved plan
  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await resolveUserId();

      const [pItems, pRes, rRes, iRes, favRes] = await Promise.all([
        supabase
        .from('pantry_items')
        .select('name,qty,unit,updated_at,perish_by,use_soon')
        .eq('user_id', uid),
        supabase.from('preferences').select('*').eq('user_id', uid).maybeSingle(),
        supabase
          .from('recipes')
          .select('id,title,time_min,diet_tags,instructions,servings')
          .eq('is_active', true)
          .eq('qa_status', 'approved'),
        supabase
          .from('recipe_ingredients')
          .select('recipe_id,name,qty,unit,optional'),
        supabase.from('favorites').select('recipe_id').eq('user_id', uid),
      ]);

      const pantryRows: PantryRow[] = (pItems.data || []).map((x) => ({
      name: String(x.name).toLowerCase(),
      qty: Number(x.qty ?? 1) || 1,
      unit: String(x.unit ?? 'unit'),
      updated_at: x.updated_at || new Date(0).toISOString(),
      perish_by: x.perish_by ?? null,
      use_soon: !!(x as { use_soon?: boolean }).use_soon,
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
            favorite_mode:
              pr.favorite_mode === 'favorites' ? 'favorites' : 'variety',
            healthy_whole_food: pr.healthy_whole_food ?? false,
            kid_friendly: pr.kid_friendly ?? false,
            dinners_per_week: pr.dinners_per_week ?? 7,
            people_count: pr.people_count ?? 2,
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
            favorite_mode: 'variety',
            healthy_whole_food: false,
            kid_friendly: false,
            dinners_per_week: 7,
            people_count: 2,
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
        .select('id, generated_at, share_id, people_count, recipe_prefs_sig, user_meal_plan_recipes (recipe_id, position)')
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
       setPlanMealCount(chosen.length || 7);
       setPlanMeta({ id: plan.id, generated_at: plan.generated_at, share_id: plan.share_id ?? null });
       // Snapshot prefs used for this plan (stored on the plan row)
       setPlanRecipePrefsSig(plan.recipe_prefs_sig ?? null);
       setPlanPeopleCount(plan.people_count ?? null);

       }

      setLoading(false);
    })();
  }, [resolveUserId]);

  // Recompute stale whenever pantry/prefs change (Plan page may stay mounted when navigating)
  useEffect(() => {
  if (!planMeta?.generated_at) return;
  setStale(pantryChangedSincePlan || recipePrefsChangedSincePlan);
}, [planMeta?.generated_at, pantryChangedSincePlan, recipePrefsChangedSincePlan]);

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
    const prefsSafe = prefs;
    
    // Prevent duplicate generations (double click, re-entrancy, slow network)
    if (generatingRef.current) {
      console.log('[PLAN] generateAndSave ignored (already running)');
      return;
    }

    trackEvent('generate_plan_click');
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
        wholeFoodFocus: !!prefs.healthy_whole_food || !!prefs.kid_friendly,
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
    const dislike = new Set((prefs.dislikes || []).map((d) => String(d)));

    // Normalize sets once for consistent matching
    const allergyTermsNorm = normalizeTermSet(allergy);
    const dislikeTermsNorm = normalizeTermSet(dislike);

    // --- DEBUG: why a use-soon item (e.g. mushroom) didn't show up ---
    // This is safe to keep (console-only) and helps confirm whether an ingredient
    // is being excluded by dislikes/allergies, or simply not present in recipes.
    if (DEBUG_PLAN) {
      try {
        const dbgMushNorm = normalizeTermSet(['mushroom', 'mushrooms']);
        console.log('[PLAN DEBUG] prefs.dislikes (raw):', prefs.dislikes);
        console.log(
          '[PLAN DEBUG] dislikeTermsNorm has mushroom?:',
          dbgMushNorm.size > 0 &&
            Array.from(dbgMushNorm).some((t) => dislikeTermsNorm.has(t)),
        );
        console.log(
          '[PLAN DEBUG] pantryUseSoon (sample):',
          Array.from(pantryUseSoon).slice(0, 25),
        );
        console.log(
          '[PLAN DEBUG] pantryUseSoon has mushroom?:',
          Array.from(dbgMushNorm).some((t) => pantryUseSoon.has(t)),
        );
      } catch (e) {
        console.warn('[PLAN DEBUG] debug block failed:', e);
      }
    }

    const pantrySet = new Set(pantry.map((p) => normalizeIngredientName(p.name)));

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
        // seafood/fish
        /\bshrimp\b/i,
        /\banchovies?\b/i,
        /\bsalmon\b/i,
        /\btuna\b/i,
        /\bcod\b/i,
        /\btilapia\b/i,
        /\btrout\b/i,
        /\bhalibut\b/i,
        /\bmahi\b/i,
        /\bseafood\b/i,
        /\bfish\b/i,
      ],
      vegan: [
        /\bchicken\b/i,
        /\bbeef\b/i,
        /\bpork\b/i,
        /\bham\b/i,
        /\bsausage\b/i,
        /\bbacon\b/i,
        /\bturkey\b/i,
        // seafood/fish
        /\bshrimp\b/i,
        /\banchovies?\b/i,
        /\bsalmon\b/i,
        /\btuna\b/i,
        /\bcod\b/i,
        /\btilapia\b/i,
        /\btrout\b/i,
        /\bhalibut\b/i,
        /\bmahi\b/i,
        /\bseafood\b/i,
        /\bfish\b/i,
        // animal products
        /\beggs?\b/i,
        /\bcheese\b/i,
        /\bmilk\b/i,
        /\byogurt\b/i,
        /\bbutter\b/i,
      ],
    };

    function violatesDiet(recipe: Recipe, ri: Ing[], diet: string): boolean {
      const rules = DIET_FORBIDDEN_BY_ING[diet] || [];
      if (!rules.length) return false;
      return recipeMatchesAnyRegex(recipe, ri, rules);
    }

    function hasForbiddenFromSet(ri: Ing[], termsNorm: Set<string>): boolean {
      if (!termsNorm.size) return false;
      return ri.some((it) => matchesAnyNormalizedTerm(it.name, termsNorm));
    }

    const filteredRecipes: Recipe[] = recipes.filter((r) => {
      const ri = ingIndex.get(r.id) || [];

      if (violatesDiet(r, ri, prefs.diet)) return false;
      if (hasForbiddenFromSet(ri, allergyTermsNorm)) return false;
      if (hasForbiddenFromSet(ri, dislikeTermsNorm)) return false;

      return true;
    });

    const pool: Recipe[] = filteredRecipes.length ? filteredRecipes : recipes;
    if (!filteredRecipes.length) {
      console.warn(
        '[PLAN] All recipes filtered by prefs; falling back to full list.',
      );
    }

    const strictPool: Recipe[] = pool; // strict-only: never relax constraints

    if (DEBUG_PLAN && prefs.diet !== 'none') {
      const violatingTitles = strictPool
        .filter((r) => violatesDiet(r, ingIndex.get(r.id) || [], prefs.diet))
        .map((r) => r.title);

      console.log('[PLAN DEBUG] strictPool diet check:', {
        diet: prefs.diet,
        strictPoolCount: strictPool.length,
        violatingTitles: violatingTitles.slice(0, 25),
      });
    }

    // --- DEBUG: do we even have eligible recipes that contain mushrooms? ---
    if (DEBUG_PLAN) {
      try {
        const dbgMushNorm = normalizeTermSet(['mushroom', 'mushrooms']);
        const mushEligible = strictPool.filter((r) => {
          const ri = ingIndex.get(r.id) || [];
          return ri.some((it) => matchesAnyNormalizedTerm(it.name, dbgMushNorm));
        });
        console.log(
          '[PLAN DEBUG] eligible recipes containing mushroom:',
          mushEligible.length,
        );
        if (mushEligible.length) {
          console.log(
            '[PLAN DEBUG] mushroom recipe titles (first 10):',
            mushEligible.slice(0, 10).map((r) => r.title),
          );
        }
      } catch (e) {
        console.warn('[PLAN DEBUG] mushroom eligibility check failed:', e);
      }
    }

    let chosen: Recipe[] | null = null;
    let mode: 'llm' | 'heuristic' | null = null;
    let reqKey: string | null = null;

    try {
      const pantryNames = Array.from(pantrySet);

      const recipeLite = pool.map((r) => ({
        id: r.id,
        title: r.title,
        time_min: r.time_min,
        diet_tags: r.diet_tags,
        ingredients: (ingIndex.get(r.id) || [])
       .filter((it) => !it.optional) // optional shouldn’t drive planning
       .map((it) => normalizeIngredientName(it.name)),
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
          favorite_mode: prefs.favorite_mode,
          healthy_whole_food: prefs.healthy_whole_food,
          kid_friendly: prefs.kid_friendly,
          healthy_goal: prefs.healthy_goal,
          healthy_protein_style: prefs.healthy_protein_style,
          healthy_carb_pref: prefs.healthy_carb_pref,
        },
        recipes: recipeLite,
        days: dinnersPerWeek,
        healthyProfile, // may be undefined
      };

      // Skip identical inputs if user clicks regenerate repeatedly (prevents extra API calls + extra saved plans)
      reqKey = await sha256Hex(JSON.stringify(llmPayload));
      const nowTs = Date.now();
      const tooSoonMs = 30_000; // 30 seconds (tunable)
      if (
        lastPlanReqKeyRef.current === reqKey &&
        nowTs - lastPlanReqAtRef.current < tooSoonMs
      ) {
        console.log('[PLAN] Skipping LLM call: identical inputs too soon');
        trackEvent('generate_plan_skipped_identical_too_soon');
        return;
      }

      const res = await fetch('/api/llm-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(llmPayload),
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
            if (violatesDiet(r, ri, prefs.diet)) return false;
            if (hasForbiddenFromSet(ri, allergyTermsNorm)) return false;
            if (hasForbiddenFromSet(ri, dislikeTermsNorm)) return false;
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

    // ---------- 2) Fallback: pantry-first heuristic ----------
    if (!chosen || !chosen.length) {
      type RecipeStats = {
        id: string;
        coverage: number;
        matchedWeight: number;
        totalWeight: number;
        missingWeighted: number;
        missingSet: Set<string>; // normalized missing non-staples, non-optional
        mustUseHits: number;
        baseScore: number;
      };

      // Build "must use" set from pantry items that are explicitly flagged OR expiring soon.
      // (V1: treat perish-by within 3 days as must-use.)
      const mustUseSet = new Set<string>(Array.from(pantryUseSoon));
      for (const [nameNorm, d] of pantryPerishBy.entries()) {
        try {
          if (daysUntil(d) <= 3) mustUseSet.add(nameNorm);
        } catch {
          // ignore
        }
      }

      function computeStats(r: Recipe): RecipeStats {
        const ri = (ingIndex.get(r.id) || []).filter((it) => !it.optional);
        const ingNorms = ri.map((it) => normalizeIngredientName(it.name));

        let totalWeight = 0;
        let matchedWeight = 0;
        let missingWeighted = 0;
        const missingSet = new Set<string>();
        let mustUseHits = 0;

        for (const n of ingNorms) {
          if (!n) continue;

          const w = ingredientWeight(n);
          totalWeight += w;

          const inPantry = pantrySet.has(n);
          if (inPantry) {
            matchedWeight += w;
            if (mustUseSet.has(n)) mustUseHits += 1;
            continue;
          }

          // Missing: ignore staples and do not add to shopping-friction penalty
          if (STAPLE_SKIP.has(n)) continue;

          missingWeighted += w;
          missingSet.add(n);
        }

        const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;

        // Time preference (soft): keep it simple in V1
        const timeScore =
        r.time_min <= (prefsSafe.max_prep_minutes ?? 45) ? 1.5 : -2;

        // Favorites boost
        const favBoost = favorites.has(r.id)
        ? prefsSafe.favorite_mode === 'favorites'
        ? 4
        : 1
        : 0;

        // Must-use boost (waste reduction)
        const mustUseBoost = mustUseHits * 2.5;

        // Pantry-first score
        // - Coverage dominates
        // - Missing ingredients (weighted) penalized
        const baseScore = coverage * 10 - missingWeighted * 1.5 + mustUseBoost + favBoost + timeScore;

        return {
          id: r.id,
          coverage,
          matchedWeight,
          totalWeight,
          missingWeighted,
          missingSet,
          mustUseHits,
          baseScore,
        };
      }

      // Precompute stats for all candidates
      const statsById = new Map<string, RecipeStats>();
      for (const r of pool) statsById.set(r.id, computeStats(r));

      const picked: Recipe[] = [];
      const weekMissing = new Set<string>();

      // Greedy week selection:
      // 1) pick best baseScore
      // 2) for subsequent picks, penalize introducing new missing items not already on the week's list
      for (let k = 0; k < dinnersPerWeek; k++) {
        let best: { r: Recipe; score: number } | null = null;

        for (const r of pool) {
          // Avoid duplicates until we have to fill with repeats later
          if (picked.some((p) => p.id === r.id)) continue;

          const st = statsById.get(r.id);
          if (!st) continue;

          // Week-level penalty for introducing brand new missing items
          let newMissingCount = 0;
          for (const m of st.missingSet) {
            if (!weekMissing.has(m)) newMissingCount += 1;
          }

          const weekPenalty = newMissingCount * 0.75;
          const score = st.baseScore - weekPenalty;

          if (!best || score > best.score) best = { r, score };
        }

        if (!best) break;

        picked.push(best.r);

        // Accumulate missing set for the week
        const st = statsById.get(best.r.id);
        if (st) {
          for (const m of st.missingSet) weekMissing.add(m);
        }
      }

      chosen = picked;
      setPlannerMode('heuristic');
      mode = 'heuristic';

      console.log(
        '[PLAN] Using pantry-first heuristic-selected recipes (fallback):',
        chosen.map((p) => p.title),
      );
    }

    if (!chosen || !chosen.length) {
      console.warn('[PLAN] No recipes chosen even after fallback');
      return;
    }

    // ---------- 2.5) Perishables-first ordering ----------
// Priority order:
// 1) Recipes that consume any pantry items marked "use soon"
// 2) Then recipes with the most urgent perishability (date-based or heuristic)
const withPerishableScore = chosen.map((r) => {
  const ri = ingIndex.get(r.id) || [];
  const riNonOpt = ri.filter((it) => !it.optional);

  const ingredientNames = riNonOpt
    .map((it) => normalizeIngredientName(it.name))
    .filter(Boolean);

  // Use-soon match uses normalized ingredient names for consistency
  const usesSoon = riNonOpt.some((it) =>
    pantryUseSoon.has(normalizeIngredientName(it.name)),
  );

  const heuristicScore = computeRecipePerishability(ingredientNames);

  let dateScore: 1 | 2 | 3 | 4 = 1;
  for (const it of riNonOpt) {
    const pantryDate = pantryPerishBy.get(normalizeIngredientName(it.name));
    if (!pantryDate) continue;
    const s = scoreFromPerishDate(pantryDate);
    if (s > dateScore) dateScore = s;
  }

  const perishability = dateScore > heuristicScore ? dateScore : heuristicScore;

  return { recipe: r, usesSoon, perishability };
});

withPerishableScore.sort((a, b) => {
  if (a.usesSoon !== b.usesSoon) return a.usesSoon ? -1 : 1;
  return b.perishability - a.perishability;
});

chosen = withPerishableScore.map((x) => x.recipe);

    // Ensure we always save exactly dinnersPerWeek meals.
   // Repeats are allowed, but ONLY from the strict pool (no constraint relaxing).
   chosen = (chosen || []).slice(0, dinnersPerWeek);

    if (chosen.length < dinnersPerWeek) {
      const seed =
        reqKey ??
        `${userId}|${recipePrefsSignature(prefs)}|${dinnersPerWeek}`;
      chosen = fillPlanWithRepeats(chosen, dinnersPerWeek, strictPool, seed);

      console.warn(
        `[PLAN] Filled plan with repeats to reach ${dinnersPerWeek} meals. Final length:`,
        chosen.length,
      );
    }

    // ---------- 2.75) Balance veg vs non-veg (for omnivore users) ----------
    // If the user did NOT request vegetarian/vegan, keep the week from skewing too plant-forward.
    // This is a soft constraint: we replace excess veg meals with the best non-veg candidates.
    const dietLower = String(prefsSafe.diet || '').toLowerCase();
    const shouldBalanceNonVeg = dietLower !== 'vegetarian' && dietLower !== 'vegan';

    // Heuristic: "non-veg" if any ingredient looks like meat/fish/seafood.
    // Otherwise treat it as vegetarian-ish (includes egg/dairy meals).
    const NON_VEG_ING_RE = /(\bchicken\b|\bbeef\b|\bpork\b|\bturkey\b|\blamb\b|\bveal\b|\bham\b|\bsausage\b|\bbacon\b|\bpepperoni\b|\bsalami\b|\bprosciutto\b|\banchovies?\b|\btuna\b|\bsalmon\b|\bshrimp\b|\bprawn\b|\bcrab\b|\blobster\b|\bclam\b|\bmussel\b|\boyster\b|\bscallop\b|\bfish\b)/i;

    function isVegLikeRecipe(r: Recipe): boolean {
      const tags = (r.diet_tags ?? []).map((t) => String(t).toLowerCase());
      if (tags.includes('vegan') || tags.includes('vegetarian')) return true;

      const ri = ingIndex.get(r.id) || [];
      // If we see any non-veg ingredient keyword, treat as non-veg.
      const hasNonVeg = ri.some((it) => NON_VEG_ING_RE.test(String(it.name)));
      return !hasNonVeg;
    }

    function isNonVegRecipe(r: Recipe): boolean {
      return !isVegLikeRecipe(r);
    }

    if (shouldBalanceNonVeg && chosen && chosen.length >= 3) {
      // Allow up to 40% veg-like meals for omnivore users.
      const maxVeg = Math.max(1, Math.floor(dinnersPerWeek * 0.4));

      let vegCount = chosen.reduce((acc, r) => acc + (isVegLikeRecipe(r) ? 1 : 0), 0);

      if (vegCount > maxVeg) {
        // Build a replacement pool of non-veg recipes from the strict pool.
        // Keep it deterministic: sort by id.
        const nonVegCandidates = (strictPool || [])
          .filter((r) => !!r?.id)
          .filter((r) => isNonVegRecipe(r))
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id));

        // Track ids already used; we prefer variety but allow repeats if needed.
        const usedCounts = new Map<string, number>();
        for (const r of chosen) usedCounts.set(r.id, (usedCounts.get(r.id) ?? 0) + 1);

        function pickReplacement(): Recipe | null {
          // First pass: avoid duplicates when possible
          for (const r of nonVegCandidates) {
            if ((usedCounts.get(r.id) ?? 0) === 0) return r;
          }
          // Second pass: allow repeats
          return nonVegCandidates[0] ?? null;
        }

        // Replace from the END of the week so perishables-first ordering stays mostly intact.
        const updated = chosen.slice();
        for (let i = updated.length - 1; i >= 0 && vegCount > maxVeg; i--) {
          const r = updated[i];
          if (!isVegLikeRecipe(r)) continue;

          const repl = pickReplacement();
          if (!repl) break;

          // If replacement is the same id, we still accept it (repeats allowed),
          // but try to not do pointless swaps.
          if (repl.id === r.id) break;

          updated[i] = repl;
          // bookkeeping
          usedCounts.set(repl.id, (usedCounts.get(repl.id) ?? 0) + 1);
          vegCount -= 1;
        }

        chosen = updated;
        console.log('[PLAN] Balanced week (veg-like capped):', {
          maxVeg,
          vegCount,
          titles: chosen.map((x) => x.title),
        });
      }
    }

    // ---------- 2.8) Protein variety (avoid too many chicken meals) ----------
    // Best-effort: keep any single protein category from dominating the week.
    // This runs only for omnivore users (not vegetarian/vegan).
    if (shouldBalanceNonVeg && chosen && chosen.length >= 3) {
      type ProteinCat =
        | 'chicken'
        | 'turkey'
        | 'beef'
        | 'lamb'
        | 'pork'
        | 'fish'
        | 'seafood'
        | 'plant'
        | 'other';

      // Preference order for classifying a recipe when multiple proteins appear.
      // (We prefer fish/seafood first, then red meats, then poultry.)
      const CAT_ORDER: ProteinCat[] = [
        'fish',
        'seafood',
        'beef',
        'lamb',
        'pork',
        'turkey',
        'chicken',
        'plant',
        'other',
      ];

      // Match both single-word proteins and common multi-word phrases like
      // "ground turkey" / "ground lamb" / "ground beef".
      const CAT_RE: Record<ProteinCat, RegExp> = {
        chicken: /\b(chicken|ground\s+chicken|drumsticks?|thighs?|breasts?|wings?)\b/i,
        turkey: /\b(turkey|ground\s+turkey)\b/i,
        beef: /\b(beef|steak|sirloin|brisket|ground\s+beef)\b/i,
        lamb: /\b(lamb|mutton|ground\s+lamb|lamb\s+chops?|leg\s+of\s+lamb)\b/i,
        pork: /\b(pork|bacon|ham|sausage|prosciutto|pancetta|ground\s+pork)\b/i,
        // Avoid classifying "fish sauce" as a fish protein.
        fish: /\b(salmon|tuna|cod|tilapia|trout|halibut|mahi(?:\s+mahi)?|snapper|sardines?|pollock|bass)\b/i,
        seafood: /\b(shrimp|prawns?|crab|lobster|clams?|mussels?|oysters?|scallops?|seafood)\b/i,
        plant: /\b(tofu|tempeh|lentils?|beans|chickpeas?|edamame|seitan|tvp)\b/i,
        other: /.^/,
      };

      function recipeProteinCat(r: Recipe): ProteinCat {
        const ri = ingIndex.get(r.id) || [];
        const names = ri.map((it) => String(it.name).replace(/\s+/g, ' ').trim());

        // Prefer explicit matches first
        for (const cat of CAT_ORDER) {
          if (cat === 'other') continue;
          const rx = CAT_RE[cat];
          if (names.some((n) => rx.test(n))) return cat;
        }

        // If it was classified as veg-like earlier, treat as plant/other.
        return isVegLikeRecipe(r) ? 'plant' : 'other';
      }

      const maxPerCat = Math.max(1, Math.ceil(dinnersPerWeek * 0.4));

      const counts = new Map<ProteinCat, number>();
      for (const r of chosen) {
        const c = recipeProteinCat(r);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }

      function isOverCap(cat: ProteinCat) {
        const c = counts.get(cat) ?? 0;
        return c > maxPerCat;
      }

      const updated = chosen.slice();
      const usedIds = new Set(updated.map((r) => r.id));

      function pickReplacement(avoidCat: ProteinCat): Recipe | null {
        // Candidate pool: strictPool already respects diet/allergy/dislike.
        // Prefer non-veg replacements so this pass doesn't re-introduce a veg-heavy week.
        const allCandidates = (strictPool || [])
          .filter((r) => !!r?.id)
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id));

        const nonVegCandidates = allCandidates.filter((r) => isNonVegRecipe(r));

        // Helper: try to find a candidate with optional constraints.
        function tryPick(
          candidates: Recipe[],
          opts: { requireUnderCap: boolean; requireNew: boolean },
        ): Recipe | null {
          for (const r of candidates) {
            const c = recipeProteinCat(r);
            if (c === avoidCat) continue;
            if (opts.requireUnderCap && (counts.get(c) ?? 0) >= maxPerCat) continue;
            if (opts.requireNew && usedIds.has(r.id)) continue;
            return r;
          }
          return null;
        }

        // 1) Best: non-veg, under-cap, and new to the week
        let repl = tryPick(nonVegCandidates, { requireUnderCap: true, requireNew: true });
        if (repl) return repl;

        // 2) Next: non-veg, under-cap (allow repeats)
        repl = tryPick(nonVegCandidates, { requireUnderCap: true, requireNew: false });
        if (repl) return repl;

        // 3) Next: non-veg, any category (still avoid avoidCat), prefer new
        repl = tryPick(nonVegCandidates, { requireUnderCap: false, requireNew: true });
        if (repl) return repl;

        // 4) Fallback: any recipe (including plant), under-cap, prefer new
        repl = tryPick(allCandidates, { requireUnderCap: true, requireNew: true });
        if (repl) return repl;

        // 5) Last resort: any recipe not in avoidCat
        repl = tryPick(allCandidates, { requireUnderCap: false, requireNew: false });
        return repl;
      }

      // If chicken dominates, reduce it first. Otherwise reduce any category over cap.
      const priorityCats: ProteinCat[] = ['chicken', ...CAT_ORDER.filter((c) => c !== 'chicken')];

      for (const overCat of priorityCats) {
        // Keep swapping until that category is within cap (or no replacements exist)
        while (isOverCap(overCat)) {
          let swapped = false;

          // Replace from the END so perishables-first ordering stays mostly intact.
          for (let i = updated.length - 1; i >= 0; i--) {
            const r = updated[i];
            const cat = recipeProteinCat(r);
            if (cat !== overCat) continue;

            const repl = pickReplacement(overCat);
            if (!repl) break;
            if (repl.id === r.id) break;

            // Update counts
            counts.set(overCat, (counts.get(overCat) ?? 1) - 1);
            const newCat = recipeProteinCat(repl);
            counts.set(newCat, (counts.get(newCat) ?? 0) + 1);

            updated[i] = repl;
            usedIds.add(repl.id);
            swapped = true;

            // Check again (while loop)
            break;
          }

          if (!swapped) break;
        }
      }

      chosen = updated;
      console.log('[PLAN] Protein variety pass:', {
        maxPerCat,
        counts: Object.fromEntries(counts.entries()),
        titles: chosen.map((x) => x.title),
      });
    }

    // ---------- 2.85) Protein adjacency smoothing (avoid back‑to‑back same protein family) ----------
    // Goal: avoid consecutive dinners with the same protein *family*
    // Constraints:
    // - Deterministic (stable scan, no randomness)
    // - Preserve perishables-first intent (do not swap across use‑soon boundaries)
    // - Applies to ALL protein types (not just chicken)
    // - Fish + seafood are treated as the same family

    if (shouldBalanceNonVeg && chosen && chosen.length >= 3) {
      // Local classifier (kept inside this block so no types leak outside)
      const CAT_ORDER = [
        'fish',
        'seafood',
        'beef',
        'lamb',
        'pork',
        'turkey',
        'chicken',
        'plant',
        'other',
      ] as const;

      const CAT_RE: Record<(typeof CAT_ORDER)[number], RegExp> = {
        chicken: /\b(chicken|ground\s+chicken|drumsticks?|thighs?|breasts?|wings?)\b/i,
        turkey: /\b(turkey|ground\s+turkey)\b/i,
        beef: /\b(beef|steak|sirloin|brisket|ground\s+beef)\b/i,
        lamb: /\b(lamb|mutton|ground\s+lamb|lamb\s+chops?|leg\s+of\s+lamb)\b/i,
        pork: /\b(pork|bacon|ham|sausage|prosciutto|pancetta|ground\s+pork)\b/i,
        // Avoid classifying "fish sauce" as a fish protein.
        fish: /\b(salmon|tuna|cod|tilapia|trout|halibut|mahi(?:\s+mahi)?|snapper|sardines?|pollock|bass)\b/i,
        seafood: /\b(shrimp|prawns?|crab|lobster|clams?|mussels?|oysters?|scallops?|seafood)\b/i,
        plant: /\b(tofu|tempeh|lentils?|beans|chickpeas?|edamame|seitan|tvp)\b/i,
        other: /.^/,
      };

      function recipeProteinCatLocal(r: Recipe): (typeof CAT_ORDER)[number] {
        const ri = ingIndex.get(r.id) || [];
        const names = ri.map((it) => String(it.name).replace(/\s+/g, ' ').trim());

        for (const cat of CAT_ORDER) {
          if (cat === 'other') continue;
          const rx = CAT_RE[cat];
          if (names.some((n) => rx.test(n))) return cat;
        }

        return isVegLikeRecipe(r) ? 'plant' : 'other';
      }

      function proteinFamily(cat: (typeof CAT_ORDER)[number]): string {
        // Treat fish + seafood as one adjacency family
        if (cat === 'fish' || cat === 'seafood') return 'seafood_family';
        return cat;
      }

      // Helper: does recipe use any pantry "use soon" ingredient?
      function recipeUsesSoon(r: Recipe): boolean {
      const ri = (ingIndex.get(r.id) || []).filter((it) => !it.optional);
      return ri.some((it) => pantryUseSoon.has(normalizeIngredientName(it.name)));
     }

      const updated = chosen.slice();
      const usesSoonFlags = updated.map((r) => recipeUsesSoon(r));

      const updatedCats = updated.map((r) => recipeProteinCatLocal(r));
      const updatedFams = updatedCats.map((c) => proteinFamily(c));

      // Single left-to-right pass; bounded lookahead keeps this cheap + deterministic
      for (let i = 1; i < updated.length; i++) {
        if (updatedFams[i] !== updatedFams[i - 1]) continue;

        const avoidFam = updatedFams[i];
        let swapped = false;

        // Look ahead a few positions for a safe swap
        for (let j = i + 1; j < Math.min(updated.length, i + 4); j++) {
          // Preserve perishables intent:
          // do not move a "use soon" recipe behind a non‑use‑soon one (and vice versa)
          if (usesSoonFlags[i] !== usesSoonFlags[j]) continue;

          const famJ = updatedFams[j];
          if (famJ === avoidFam) continue;

          // Swap i <-> j
          const tmp = updated[i];
          updated[i] = updated[j];
          updated[j] = tmp;

          const tmpCat = updatedCats[i];
          updatedCats[i] = updatedCats[j];
          updatedCats[j] = tmpCat;

          const tmpFam = updatedFams[i];
          updatedFams[i] = updatedFams[j];
          updatedFams[j] = tmpFam;

          const tmpUse = usesSoonFlags[i];
          usesSoonFlags[i] = usesSoonFlags[j];
          usesSoonFlags[j] = tmpUse;

          swapped = true;
          break;
        }

        // Best-effort: if we couldn't fix it, leave as-is
        if (!swapped) continue;
      }

      chosen = updated;

      console.log('[PLAN] Protein adjacency smoothing applied:', {
        families: updatedFams,
        titles: chosen.map((r) => r.title),
      });
    }

    // ---------- 2.9) Pantry "use soon" coverage guardrail (best-effort) ----------
    // If a pantry item is flagged "use soon" but doesn't appear in ANY selected recipe,
    // we will try to swap in a recipe that uses it — ONLY when the swap doesn't
    // meaningfully worsen plan quality (shopping friction / time).
    // Deterministic (stable candidate order) and respects perishables-first intent:
    // we only swap within the same use-soon segment (true/false) to avoid reordering priorities.

    if (chosen && chosen.length) {
      // Base must-use terms (already normalized pantry strings)
      const mustUseBase = new Set<string>(Array.from(pantryUseSoon || []));

      // Cache per-recipe computed values for speed (deterministic)
const missingSetCache = new Map<string, Set<string>>();
const missingWeightedCache = new Map<string, number>();
const coversAnyCache = new Map<string, boolean>();
const coversBaseCache = new Map<string, Set<string>>(); // recipe.id -> set of mustUseBase terms it covers

function getRecipeMissingSetCached(r: Recipe): Set<string> {
  const key = r.id;
  const hit = missingSetCache.get(key);
  if (hit) return hit;
  const s = recipeMissingSet(r);
  missingSetCache.set(key, s);
  return s;
}

function getRecipeMissingWeightedCached(r: Recipe): number {
  const key = r.id;
  const hit = missingWeightedCache.get(key);
  if (hit != null) return hit;
  const w = recipeMissingWeighted(r);
  missingWeightedCache.set(key, w);
  return w;
}

function getRecipeCoveredBasesCached(r: Recipe): Set<string> {
  const key = r.id;
  const hit = coversBaseCache.get(key);
  if (hit) return hit;
  const covered = new Set<string>();
  for (const base of mustUseBase) {
    if (recipeCoversBaseTerm(r, base)) covered.add(base);
  }
  coversBaseCache.set(key, covered);
  return covered;
}

function getRecipeCoversAnyCached(r: Recipe): boolean {
  const key = r.id;
  const hit = coversAnyCache.get(key);
  if (hit != null) return hit;
  const v = getRecipeCoveredBasesCached(r).size > 0;
  coversAnyCache.set(key, v);
  return v;
}

// Week-level missing ingredient counts (a Set is incorrect because missing items can repeat across meals)
function addMissingCounts(m: Map<string, number>, s: Set<string>) {
  for (const k of s) m.set(k, (m.get(k) ?? 0) + 1);
}
function removeMissingCounts(m: Map<string, number>, s: Set<string>) {
  for (const k of s) {
    const next = (m.get(k) ?? 0) - 1;
    if (next <= 0) m.delete(k);
    else m.set(k, next);
  }
}

      // Build a term-set (normalized) per base must-use ingredient.
      // Use matchesAnyNormalizedTerm so we match phrases like "cremini mushrooms".
      function termSetForBase(baseNorm: string): Set<string> {
        const out = new Set<string>();
        const b = normalizeIngredientName(baseNorm);
        if (b) out.add(b);

        // Simple plural/singular handling
        if (b && b.endsWith('s') && b.length > 2) {
          out.add(b.slice(0, -1));
        } else if (b) {
          out.add(`${b}s`);
        }

        return out;
      }

      const mustUseTermsByBase = new Map<string, Set<string>>();
      for (const base of mustUseBase) {
        mustUseTermsByBase.set(base, termSetForBase(base));
      }

      function recipeNormIngs(r: Recipe): string[] {
        return (ingIndex.get(r.id) || [])
          .filter((it) => !it.optional)
          .map((it) => normalizeIngredientName(it.name))
          .filter(Boolean);
      }

      function recipeMissingSet(r: Recipe): Set<string> {
        const s = new Set<string>();
        for (const n of recipeNormIngs(r)) {
          if (!n) continue;
          if (pantrySet.has(n)) continue;
          if (STAPLE_SKIP.has(n)) continue;
          s.add(n);
        }
        return s;
      }

      function recipeMissingWeighted(r: Recipe): number {
        let wsum = 0;
        for (const n of recipeNormIngs(r)) {
          if (!n) continue;
          if (pantrySet.has(n)) continue;
          if (STAPLE_SKIP.has(n)) continue;
          wsum += ingredientWeight(n);
        }
        return wsum;
      }

      function recipeCoversBaseTerm(r: Recipe, base: string): boolean {
        const terms = mustUseTermsByBase.get(base) ?? new Set<string>();
        if (!terms.size) return false;

        const ri = (ingIndex.get(r.id) || []).filter((it) => !it.optional);
        return ri.some((it) => matchesAnyNormalizedTerm(it.name, terms));
      }

      function coveredMustUseForPlan(planArr: Recipe[]): Set<string> {
        const covered = new Set<string>();
        for (const r of planArr) {
          for (const base of mustUseBase) {
            if (covered.has(base)) continue;
            if (recipeCoversBaseTerm(r, base)) covered.add(base);
          }
        }
        return covered;
      }

      // What base use-soon pantry items are already covered by the chosen recipes?
      const coveredMustUse = coveredMustUseForPlan(chosen);

      const missingMustUse = Array.from(mustUseBase)
        .filter((n) => n && !coveredMustUse.has(n))
        .sort((a, b) => a.localeCompare(b));

      // If we have uncovered use-soon items, try to cover a few without harming plan quality.
      if (missingMustUse.length) {
        // Precompute week-level missing set for "new missing" penalty.
        const weekMissingCounts = new Map<string, number>();
        for (const r of chosen) {
        addMissingCounts(weekMissingCounts, getRecipeMissingSetCached(r));
        }

        // Deterministic candidate list.
        const strictSorted = (strictPool || [])
          .filter((r) => !!r?.id)
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id));

        // Swap quality guardrails.
        const maxExtraMissingWeighted = 2.5; // allow a small increase in shopping friction
        const maxNewMissingItems = 1; // allow at most 1 brand-new missing ingredient per forced swap
        const maxExtraTimeMin = 10; // allow up to +10 minutes vs the replaced recipe

        // Track which recipes currently cover ANY must-use item.
        // We'll avoid replacing these when trying to cover additional uncovered terms.
        const usesSoonFlags = chosen.map((r) => getRecipeCoversAnyCached(r));

        const updated = chosen.slice();

        // Track coverage counts for must-use bases across the current plan.
        // This lets us detect coverage regressions cheaply during swaps.
        const coveredCounts = new Map<string, number>();
        for (const r of updated) {
          for (const b of getRecipeCoveredBasesCached(r)) {
            coveredCounts.set(b, (coveredCounts.get(b) ?? 0) + 1);
          }
        }

        for (const term of missingMustUse) {
          // Recompute covered set for updated array
          let alreadyCovered = false;
          for (const r of updated) {
            if (recipeCoversBaseTerm(r, term)) {
              alreadyCovered = true;
              break;
            }
          }
          if (alreadyCovered) continue;

          // Find a candidate recipe that uses this term.
          const candidates = strictSorted.filter((r) => recipeCoversBaseTerm(r, term));
          if (!candidates.length) continue;

          // Pick a swap target index deterministically.
          // If we already have at least one use-soon recipe, prefer swapping within the NOT-use-soon
          // segment so we don't lose existing use-soon coverage (e.g. avoid swapping out the only mushroom recipe
          // when trying to also cover spinach).
          const anyUseSoon = usesSoonFlags.some(Boolean);

          let swapped = false;

          // Try from the END (to preserve earlier perishables priority more strongly).
          for (let i = updated.length - 1; i >= 0; i--) {
            // If we already have at least one must-use (use-soon) recipe in the plan,
            // avoid replacing it while trying to cover additional uncovered must-use terms.
            if (anyUseSoon && usesSoonFlags[i]) continue;

            const current = updated[i];
            const curMissingW = getRecipeMissingWeightedCached(current);
            const curMissingSet = getRecipeMissingSetCached(current);

            // Compute week-missing excluding this recipe (approximate improvement from removal)
            const weekMissingExcl = new Map<string, number>(weekMissingCounts);
            removeMissingCounts(weekMissingExcl, curMissingSet);

            for (const cand of candidates) {
              if (cand.id === current.id) continue;

              const candUseSoon = getRecipeCoversAnyCached(cand);

              // Time guardrail
              if ((cand.time_min ?? 0) - (current.time_min ?? 0) > maxExtraTimeMin) continue;

              const candMissingW = getRecipeMissingWeightedCached(cand);
              if (candMissingW - curMissingW > maxExtraMissingWeighted) continue;

              const candMissingSet = getRecipeMissingSetCached(cand);
              let newMissing = 0;
              for (const m of candMissingSet) {
              if ((weekMissingExcl.get(m) ?? 0) <= 0) newMissing += 1;
              if (newMissing > maxNewMissingItems) break;
              }
              if (newMissing > maxNewMissingItems) continue;

              // Coverage regression guardrail (fast):
              // Only bases that are covered EXACTLY once (by the recipe we're replacing)
              // are at risk of being lost.
              const currentCovered = getRecipeCoveredBasesCached(current);
              let losesCoverage = false;
              if (currentCovered.size) {
                const candCovered = getRecipeCoveredBasesCached(cand);
                for (const b of currentCovered) {
                  // If this base is only covered by `current` (count === 1),
                  // then swapping it out would lose coverage unless `cand` also covers it.
                  if ((coveredCounts.get(b) ?? 0) === 1 && !candCovered.has(b)) {
                    losesCoverage = true;
                    break;
                  }
                }
              }
              if (losesCoverage) continue;

              // ✅ Accept swap
              updated[i] = cand;
              // Update coveredCounts for must-use bases
              for (const b of getRecipeCoveredBasesCached(current)) {
                const next = (coveredCounts.get(b) ?? 0) - 1;
                if (next <= 0) coveredCounts.delete(b);
                else coveredCounts.set(b, next);
              }
              for (const b of getRecipeCoveredBasesCached(cand)) {
                coveredCounts.set(b, (coveredCounts.get(b) ?? 0) + 1);
              }
              // update weekMissingAll for subsequent swaps
              removeMissingCounts(weekMissingCounts, curMissingSet);
              addMissingCounts(weekMissingCounts, candMissingSet);  

              // update usesSoonFlags so subsequent iterations respect segmentation
              usesSoonFlags[i] = candUseSoon;

              console.log('[PLAN] Forced use-soon coverage swap:', {
                term,
                replaced: current.title,
                added: cand.title,
                deltaMissingWeighted: candMissingW - curMissingW,
                newMissing,
                deltaTime: (cand.time_min ?? 0) - (current.time_min ?? 0),
              });

              swapped = true;
              break;
            }

            if (swapped) break;
          }

          // Best-effort: move on if we couldn't safely cover this term
        }

        // After attempting swaps, stably move ANY must-use-covering recipes to the front.
        // This keeps the "use soon" priority visible even if we had to introduce a new use-soon recipe
        // while covering additional uncovered terms (e.g. spinach).
        const zipped = updated.map((r, idx) => ({
          r,
          idx,
          useSoon: getRecipeCoversAnyCached(r),
        }));

        zipped.sort((a, b) => {
          if (a.useSoon !== b.useSoon) return a.useSoon ? -1 : 1;
          return a.idx - b.idx; // stable within group
        });

        chosen = zipped.map((z) => z.r);

        // Final visibility
        try {
          const coveredAfter = coveredMustUseForPlan(chosen);
          console.log('[PLAN] Use-soon coverage summary:', {
            mustUseCount: mustUseBase.size,
            coveredCount: coveredAfter.size,
            uncovered: Array.from(mustUseBase)
              .filter((n) => !coveredAfter.has(n))
              .slice(0, 25),
          });
        } catch {
          // ignore
        }
      }
    }

    if (prefs.diet !== 'none') {
      chosen = chosen.filter((r) => !violatesDiet(r, ingIndex.get(r.id) || [], prefs.diet));
    }

    // ---------- 3) Persist to Supabase ----------
    const newShareId =
   (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

   const prefsSigAtGen = prefs ? recipePrefsSignature(prefs) : null;

const { data: planRow, error: planErr } = await supabase
  .from('user_meal_plan')
  .insert({
    user_id: userId,
    share_id: newShareId,
    people_count: peopleCount,          // NEW
    recipe_prefs_sig: prefsSigAtGen,    // NEW
  })
  .select('id,generated_at,share_id,people_count,recipe_prefs_sig')
  .single();
    if (planErr || !planRow) {
      console.error(planErr);
      return;
    }

    setPlanRecipePrefsSig(planRow.recipe_prefs_sig ?? prefsSigAtGen);
    setPlanPeopleCount(planRow.people_count ?? peopleCount);

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
   setPlanMealCount(chosen.length || dinnersPerWeek); // ✅ critical: update display count immediately
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
    pantryUseSoon,
    ings,
    recipes,
    recomputeShopping,
    favorites,
    healthySurvey,
    dinnersPerWeek,
    peopleCount,
  ]);

 const updateServingsOnly = useCallback(async () => {
  if (!mealsN.length) return;
  if (!planMeta?.id) {
    console.warn('[PLAN] updateServingsOnly: missing planMeta.id');
    return;
  }

  // 1) Recompute shopping immediately for UX
  recomputeShopping(mealsN);

  // 2) Persist the new people_count onto the plan row (this fixes logout/login banner)
  const { data, error } = await supabase
    .from('user_meal_plan')
    .update({ people_count: peopleCount })
    .eq('id', planMeta.id)
    .select('id, people_count')
    .maybeSingle();

  if (error) {
    console.error('[PLAN] Update servings failed:', error);
    alert(`Update servings failed: ${error.message}`);
    return;
  }
  if (!data) {
    console.error('[PLAN] Update servings failed: 0 rows updated (RLS or wrong plan id)');
    alert('Update servings failed (0 rows updated). This is usually an RLS policy issue.');
    return;
  }

  console.log('[PLAN] Updated servings persisted:', data);

  // 3) Sync local snapshot to match DB (so no “people changed” banner)
  setPlanPeopleCount(data.people_count ?? peopleCount);
  setStale(false);

  trackEvent('update_servings_only', {
    plan_id: planMeta.id,
    people_count: peopleCount,
  });
}, [mealsN, recomputeShopping, peopleCount, planMeta?.id]);

  function csvEscape(v: unknown): string {
    const s = String(v ?? '');
    // Escape quotes by doubling them, and wrap the field in quotes.
    return `"${s.replace(/"/g, '""')}"`;
  }

  function downloadCSV() {
    // Include notes for substitutions + healthy hints
    const header = 'name,qty,unit,notes';

    const lines = shopping.map((s) => {
      const disp = formatShoppingItem(s);

      const subNote = (s as unknown as { note?: string | null }).note ?? '';
      const healthHint = getHealthSwapHintForItem(s, prefs) ?? '';

      const notes = [subNote, healthHint].filter(Boolean).join(' | ');

      return [
        csvEscape(disp.nameLabel ?? s.name),
        csvEscape(disp.qtyLabel ?? s.qty),
        csvEscape(disp.unitLabel ?? s.unit),
        csvEscape(notes),
      ].join(',');
    });

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

      const baseLine = `• ${qtyPart}${unitPart}${disp.nameLabel}`.trim();

      const subNote = (s as unknown as { note?: string | null }).note ?? '';
      const healthHint = getHealthSwapHintForItem(s, prefs) ?? '';
      const notes = [subNote, healthHint].filter(Boolean);

      if (!notes.length) return baseLine;

      // Notes lines are indented so they paste nicely into Apple Notes
      const noteLines = notes.map((n) => `  - ${n}`);
      return [baseLine, ...noteLines].join('\n');
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

  const showHealthyBadge = !!prefs?.healthy_whole_food && !stale;

  const groupedShopping = useMemo(() => {
  const itemsByCategory = new Map<
    PantryCategory,
    (typeof pricedShopping)[number][]
  >();

  for (const it of pricedShopping) {
    const cat = (it.category ?? 'other') as PantryCategory;
    const arr = itemsByCategory.get(cat) || [];
    arr.push(it);
    itemsByCategory.set(cat, arr);
  }

  return CATEGORY_ORDER
    .map((cat) => ({
      category: cat,
      items: itemsByCategory.get(cat) ?? [],
    }))
    .filter((g) => g.items.length > 0);
}, [pricedShopping]);

  // For header colSpan in the table (3 base cols + optional)
  const shoppingColCount =
    3 +
    (enablePriceHints && storeId !== 'none' ? 1 : 0) +
    (shopPlatform !== 'none' ? 1 : 0);

    useEffect(() => {
  if (!planMeta?.id) return;
  if (!DEBUG_PLAN) return;

  console.log('[PLAN DEBUG]', {
    plan_id: planMeta.id,
    plan_generated_at: planMeta.generated_at,
    plan_people_count: planPeopleCount,
    plan_recipe_sig_present: planRecipePrefsSig != null,

    prefs_loaded: prefs != null,
    prefs_people_count: prefs?.people_count,
    prefs_updated_at: prefs?.updated_at,

    pantry_len: pantry.length,

    stale,
    pantryChangedSincePlan,
    recipePrefsChangedSincePlan,
    // ⚠️ see note below about peopleChangedSincePlan
    onlyPeopleChangedSincePlan,
    legacyPlanMissingSnapshots,
  });
}, [
  planMeta?.id,
  planMeta?.generated_at,
  planPeopleCount,
  planRecipePrefsSig,
  prefs,
  pantry.length,
  stale,
  pantryChangedSincePlan,
  recipePrefsChangedSincePlan,
  onlyPeopleChangedSincePlan,
  legacyPlanMissingSnapshots,
]);

  if (loading) return <p className="max-w-3xl mx-auto">Loading…</p>;

  const openRecipe = mealsN.find((m) => m.id === openId) || null;
  const openIngs = openId ? ingByRecipe.get(openId) || [] : [];
  // Minimal visual cue for pantry items marked as "use soon"
  function isUseSoonIngredient(name: string): boolean {
  const n = normalizeIngredientName(name);
  if (!n) return false;
  return pantryUseSoon.has(n);
  }
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
    fish: Array.from(expandAllergyTerms(['fish'])),
    tree_nut: Array.from(expandAllergyTerms(['tree_nut'])),
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
              Your {mealsN.length}-Dinner Plan
            </h1>
          </div>

          {/* CENTER: AI + favorites pills */}
          <div className="flex flex-col items-center justify-center gap-1 px-2">
            {plannerMode === 'llm' && !stale && (
              <div className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-900/40 dark:text-indigo-200">
                This plan was AI-optimized ✨
              </div>
            )}

            {showHealthyBadge && (
            <div className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-900/40 dark:text-indigo-200">
            Focused on balanced, whole-food meals
           </div>
           )}
          </div>

          {/* RIGHT: regenerate button */}
        <div className="flex-shrink-0 pt-[2px]">
  <button
  onClick={
  legacyPlanMissingSnapshots
    ? generateAndSave
    : onlyPeopleChangedSincePlan
    ? updateServingsOnly
    : generateAndSave
}
  disabled={generating}
  className={`rounded px-4 py-2 bg-black text-white hover:opacity-90 dark:bg-white dark:text-black ${
    generating ? 'opacity-50 cursor-not-allowed' : ''
  }`}
>
  {generating
  ? 'Generating…'
  : !meals.length
  ? 'Generate plan'
  : legacyPlanMissingSnapshots
  ? 'Regenerate plan'
  : onlyPeopleChangedSincePlan
  ? 'Update servings'
  : 'Regenerate plan'}
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
            <span className="ml-2 font-medium">Regenerate to apply your latest settings.</span>
          </div>
        )}
        {!stale && legacyPlanMissingSnapshots && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2 text-sm dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100">
         This is an older plan. Regenerate once to enable servings-only updates.
          </div>
         )}
        {/* Servings-only change (recipes still valid) */}
        {!stale && !legacyPlanMissingSnapshots && onlyPeopleChangedSincePlan && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 text-blue-900 px-3 py-2 text-sm dark:border-blue-400/40 dark:bg-blue-950 dark:text-blue-100">
        Your servings preference changed to {peopleCount}. Click{' '}
        <span className="font-medium">Update servings</span> to scale the shopping list.
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
            {mealsN.map((m, idx) => (
           <div
            key={`${m.id}-${idx}`}
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

                            {/* Pantry substitution note (shown when we kept the original in the list) */}
                            {(s as unknown as { note?: string | null }).note ? (
                              <div className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                                {(s as unknown as { note?: string | null }).note}
                              </div>
                            ) : null}

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
      <Modal
      open={!!openId}
      onClose={closeRecipeModal}
       >
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
                  {it.qty ?? ''} {it.unit ?? ''}{' '}
                  <span className="inline-flex items-center gap-1">
                    <span>
                      {it.name}
                      {it.optional ? ' (optional)' : ''}
                    </span>
                    {isUseSoonIngredient(it.name) && (
                      <span className="text-xs">⏳</span>
                    )}
                  </span>
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