// src/app/api/llm-plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import type { HealthyProfile } from '@/lib/healthyProfile';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type PrefsLite = {
  diet: string;
  allergies: string[];
  dislikes: string[];
  max_prep_minutes: number;
  favorite_mode?: 'variety' | 'favorites';
  healthy_whole_food?: boolean;
  kid_friendly?: boolean;
  healthy_goal?: 'feel_better' | 'weight' | 'metabolic' | '';
  healthy_protein_style?: 'mixed' | 'lean_animal' | 'plant_forward' | '';
  healthy_carb_pref?: 'more_whole_grains' | 'lower_carb' | 'no_preference' | '';
};

type RecipeLite = {
  id: string;
  title: string;
  time_min: number;
  diet_tags: string[] | null;
  ingredients: string[];
  // Optional: passed from client for better planning
  is_favorite?: boolean;
};

type LlmPlanRequest = {
  pantryNames: string[];
  prefs: PrefsLite;
  recipes: RecipeLite[];
  days?: number;
  healthyProfile?: HealthyProfile;
};

type LlmPlanResponse = {
  ok: boolean;
  recipeIds?: string[];
  error?: string;
  detail?: string;
};

// -------- Simple in-memory cache (best-effort on serverless) --------
// Works great locally and on warm instances. Cold starts will be empty.
type CacheEntry = { expiresAt: number; value: LlmPlanResponse };

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 200;

// Keep cache across requests in the same Node.js process
const g = globalThis as unknown as {
  __mc_llmPlanCache?: Map<string, CacheEntry>;
  __mc_llmPlanInFlight?: Map<string, Promise<LlmPlanResponse>>;
};

const planCache = (g.__mc_llmPlanCache ??= new Map<string, CacheEntry>());
const inFlight = (g.__mc_llmPlanInFlight ??= new Map<
  string,
  Promise<LlmPlanResponse>
>());

function pruneCache(now: number) {
  // Remove expired
  for (const [k, v] of planCache.entries()) {
    if (v.expiresAt <= now) planCache.delete(k);
  }

  // Cap size (simple FIFO eviction)
  while (planCache.size > CACHE_MAX_ENTRIES) {
    const firstKey = planCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    planCache.delete(firstKey);
  }
}

function stableKeyFromRequest(body: LlmPlanRequest): string {
  const days = body.days ?? 7;

  // Normalize pantry/prefs for stable cache keys
  const pantry = [...(body.pantryNames ?? [])]
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)
    .sort();

  const prefs = body.prefs ?? ({} as PrefsLite);
  const allergies = [...(prefs.allergies ?? [])]
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)
    .sort();
  const dislikes = [...(prefs.dislikes ?? [])]
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)
    .sort();

  // Normalize recipes: sort by id; also sort ingredient lists for stability
  const recipes = (body.recipes ?? [])
    .map((r) => ({
      id: r.id,
      title: r.title,
      time_min: r.time_min,
      diet_tags: (r.diet_tags ?? []).slice().sort(),
      ingredients: (r.ingredients ?? [])
        .slice()
        .map((x) => x.toLowerCase().trim())
        .filter(Boolean)
        .sort(),
      is_favorite: !!r.is_favorite,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Healthy profile affects output; include it
  const hp = body.healthyProfile ?? null;

  const canonical = {
    days,
    pantry,
    prefs: {
      diet: prefs.diet ?? 'none',
      max_prep_minutes: prefs.max_prep_minutes ?? 45,
      favorite_mode: prefs.favorite_mode ?? null,
      healthy_whole_food: prefs.healthy_whole_food ?? null,
      kid_friendly: prefs.kid_friendly ?? null,
      healthy_goal: prefs.healthy_goal ?? null,
      healthy_protein_style: prefs.healthy_protein_style ?? null,
      healthy_carb_pref: prefs.healthy_carb_pref ?? null,
      allergies,
      dislikes,
    },
    recipes,
    healthyProfile: hp,
  };

  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  return key;
}

function norm(s: string): string {
  return String(s ?? '').toLowerCase().trim();
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesTerm(ing: string, term: string): boolean {
  const t = norm(term);
  if (!t) return false;
  const i = norm(ing);
  if (!i) return false;

  // Multi-word terms (e.g., "soy sauce") -> substring match on normalized string
  if (t.includes(' ')) return i.includes(t);

  // Single token -> word boundary match
  const rx = new RegExp(`\\b${escapeRegex(t)}s?\\b`, 'i');
  return rx.test(i);
}

// Expand common allergy toggles into the ingredient words we actually see.
function expandAllergyTerms(allergies: string[]): string[] {
  const base = (allergies ?? []).map(norm).filter(Boolean);

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
      'soy sauce',
    ],
    egg: ['egg', 'eggs', 'mayonnaise', 'mayo'],
    peanut: ['peanut', 'peanuts'],
    shellfish: [
      'shrimp',
      'prawn',
      'crab',
      'lobster',
      'clam',
      'mussel',
      'oyster',
      'scallop',
    ],
    soy: ['soy', 'tofu', 'edamame', 'miso', 'tempeh', 'soy sauce'],
    sesame: ['sesame', 'tahini'],
  };

  const out: string[] = [];
  for (const a of base) {
    out.push(a);
    const extras = MAP[a];
    if (extras?.length) out.push(...extras.map(norm));
  }
  return Array.from(new Set(out)).filter(Boolean);
}

const DIET_FORBIDDEN_ING: Record<string, RegExp[]> = {
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
    /\bgelatin\b/i,
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
    /\bgelatin\b/i,
    /\beggs?\b/i,
    /\bcheese\b/i,
    /\bmilk\b/i,
    /\byogurt\b/i,
    /\bbutter\b/i,
    /\bcream\b/i,
    /\bwhey\b/i,
  ],
};

function violatesDietLite(recipe: RecipeLite, diet: string): boolean {
  const d = norm(diet);
  const rules = DIET_FORBIDDEN_ING[d] || [];
  if (!rules.length) return false;
  const ings = recipe.ingredients ?? [];
  return ings.some((ing) => rules.some((rx) => rx.test(ing)));
}

function violatesTermsLite(recipe: RecipeLite, terms: string[]): boolean {
  if (!terms?.length) return false;
  const ings = recipe.ingredients ?? [];
  for (const ing of ings) {
    for (const t of terms) {
      if (matchesTerm(ing, t)) return true;
    }
  }
  return false;
}

function scoreFallbackRecipe(
  recipe: RecipeLite,
  pantrySet: Set<string>,
  prefs: PrefsLite,
): number {
  const ings = (recipe.ingredients ?? []).map(norm).filter(Boolean);
  if (!ings.length) return -999;

  let pantryHits = 0;
  let missing = 0;
  for (const ing of ings) {
    if (pantrySet.has(ing)) pantryHits += 1;
    else missing += 1;
  }

  const timeOk = recipe.time_min <= (prefs.max_prep_minutes ?? 45);
  const timeScore = timeOk ? 1.5 : -2;

  const favBoost = recipe.is_favorite && prefs.favorite_mode === 'favorites' ? 3 : 0;

  // Prefer high pantry overlap, fewer missing items
  return pantryHits * 2 - missing * 0.75 + timeScore + favBoost;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export async function POST(req: NextRequest) {
  if (process.env.USE_LLM_PLAN === 'false') {
    return NextResponse.json(
      {
        ok: false,
        error: 'LLM plan disabled by USE_LLM_PLAN=false',
      },
      { status: 200 },
    );
  }

  try {
    const body = (await req.json()) as LlmPlanRequest;
    const { pantryNames, prefs, recipes, days = 7, healthyProfile } = body;

    // Enforce non-veg/veg balance for all diets EXCEPT vegetarian/vegan.
    // Applies to: "none", "gluten_free", "halal", "kosher", etc.
    const dietNorm = norm(prefs?.diet ?? 'none');
    const enforceNonVegBalance = dietNorm !== 'vegetarian' && dietNorm !== 'vegan';
    // Soft cap used in prompt only (hard enforcement can be done client-side if desired)
    const maxVegMeals = Math.max(1, Math.ceil(days * 0.4));

    const now = Date.now();
    pruneCache(now);

    const cacheKey = stableKeyFromRequest(body);

    //const key8 = cacheKey.slice(0, 8);
    //const beforeSize = planCache.size;

    // 1) Return cached response if present
    const cached = planCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return NextResponse.json<LlmPlanResponse>(
        { ...cached.value, detail: 'cache_hit' },
        { status: 200, headers: { 'x-mc-llm-cache': 'HIT' } },
      );
    }

    // 2) Deduplicate in-flight identical requests (prevents double OpenAI calls)
    const existing = inFlight.get(cacheKey);
    if (existing) {
      const value = await existing;
      return NextResponse.json<LlmPlanResponse>(
        { ...value, detail: 'inflight_hit' },
        { status: 200, headers: { 'x-mc-llm-cache': 'INFLIGHT' } },
      );
    }

    if (!recipes || recipes.length === 0) {
      return NextResponse.json<LlmPlanResponse>(
        { ok: false, error: 'No recipes provided' },
        { status: 400 },
      );
    }

    const apiKey = getApiKey();

    const healthSection = healthyProfile?.wholeFoodFocus
      ? `
Additional healthy, whole-food guidelines:

- Prioritize whole, minimally processed ingredients (vegetables, fruits, whole grains, beans, lentils, eggs, unprocessed meats, nuts, seeds).
- Avoid ultra-processed convenience foods (frozen fried foods, sugary cereals, candy, soda) as the main component of a meal.
- Prefer cooking methods like baking, roasting, grilling, or steaming instead of deep frying.
${
  healthyProfile.maxUltraProcessedMealsPerWeek != null
    ? `- Try to keep ultra-processed meals to ${healthyProfile.maxUltraProcessedMealsPerWeek} or fewer across the week.`
    : ''
}
${
  healthyProfile.maxPrepTimePerMeal != null
    ? `- Keep active cooking time per dinner around or below ${healthyProfile.maxPrepTimePerMeal} minutes when possible.`
    : ''
}
${
  healthyProfile.vegetarianMealsPerWeek != null
    ? `- Aim for about ${healthyProfile.vegetarianMealsPerWeek} vegetarian dinners across the week if recipes allow.`
    : ''
}
${
  healthyProfile.maxAddedSugarPerDay === 'low'
    ? '- Keep added sugar low (avoid dessert-like breakfasts and sugary drinks when possible).'
    : ''
}
${
  healthyProfile.primaryGoal === 'weight'
    ? '- When choosing between otherwise similar recipes, prefer ones that are a bit lighter (more vegetables, lean protein, fewer heavy creams and cheeses).'
    : healthyProfile.primaryGoal === 'metabolic'
      ? '- When possible, favor higher-fiber, lower-sugar meals (beans, lentils, vegetables, whole grains) over very sugary or refined-carb options.'
      : ''
}
${
  healthyProfile.proteinPreference === 'plant_forward'
    ? '- When it fits the other constraints, include more plant-based protein dinners (beans, lentils, tofu, tempeh).'
    : healthyProfile.proteinPreference === 'lean_animal'
      ? '- Prefer recipes with lean animal proteins such as fish, chicken, eggs, or yogurt over red or processed meats.'
      : ''
}
${
  healthyProfile.carbBias === 'lower_carb'
    ? '- When there is a choice, lean toward dinners with more vegetables and protein and fewer refined starch sides (white bread, white rice, white pasta).'
    : healthyProfile.carbBias === 'more_whole_grains'
      ? '- Prefer whole-grain versions of carbohydrates (brown rice, whole-wheat pasta, whole-grain tortillas) when possible.'
      : ''
}
`.trim()
      : '';

    const kidSection = healthyProfile?.kidFriendly
      ? `
Kid-friendly guidelines:

- Choose recipes that many 3–6 year olds might enjoy: familiar flavors, not very spicy, not extremely sour or bitter.
- When possible, allow serving components separately (e.g., rice, chicken, and vegetables side-by-side instead of heavily mixed).
- Avoid choking hazards and very hard textures; prefer bite-sized, softer foods.
`.trim()
      : '';

    const microSurveySection = `
Healthy micro-survey signals (may be empty strings if not answered):

- healthy_goal: prefs.healthy_goal
  - "feel_better": general energy / vitality.
  - "weight": gently prefer meals that are not heavy in refined starches or added fats, while still satisfying.
  - "metabolic": gently prefer meals rich in vegetables and lean protein; avoid very sugary or ultra-refined meals.
- healthy_protein_style: prefs.healthy_protein_style
  - "mixed": balanced use of lean animal and plant proteins.
  - "lean_animal": lean meats, fish, eggs, yogurt can be favored slightly over heavy red meats.
  - "plant_forward": if recipes allow, bias a bit toward beans, lentils, tofu, tempeh, etc.
- healthy_carb_pref: prefs.healthy_carb_pref
  - "more_whole_grains": when you have a choice between otherwise similar recipes, prefer those that use whole grains or beans instead of refined white starches.
  - "lower_carb": gently prefer recipes that are not dominated by pasta, bread, or potatoes, while still staying realistic.
  - "no_preference": treat carbs normally.
`.trim();

    const systemPrompt = `
You are a meal-planning assistant for busy families.

Goal:
- Choose ${days} MAIN MEALS (dinners) for the next ${days} days.
- Use ONLY the provided recipes (no invented recipes).
- For each chosen recipe, you must return its "id" from the provided list.

User preferences:
- diet: prefs.diet ("none", "vegetarian", "vegan", "gluten_free", "halal", "kosher")
- allergies: prefs.allergies (MUST be strictly avoided)
- dislikes: prefs.dislikes (avoid when possible)
- max_prep_minutes: prefer recipes under this time
- favorite_mode: prefs.favorite_mode (if "favorites", it's okay to repeat favorite-type recipes a bit more often)
- healthy_whole_food: prefs.healthy_whole_food (if true, prefer more whole, minimally processed options)
- kid_friendly: prefs.kid_friendly (if true, avoid very spicy or very complex flavors)

${microSurveySection}

Pantry:
- pantryNames is a list of ingredient names the user already has.
- Prefer recipes whose ingredients appear in pantryNames, but some extra shopping is OK.

Other rules:
- Pantry-first: prefer recipes that use more pantry ingredients.
- Minimize shopping friction: prefer plans that reuse the same missing ingredients across multiple meals (consolidate the list).
- Waste reduction: if possible, use perishable-looking pantry items earlier in the week.
- Aim for variety across the week (avoid repeating the same recipe if possible).
${enforceNonVegBalance ? `
Protein mix rule (diet is not vegetarian/vegan):
- Do NOT return a plan where vegetarian/vegan meals are the majority.
- Cap vegetarian/vegan meals to ${maxVegMeals} or fewer across the ${days} dinners when possible.
- Prefer a balanced mix of proteins across the week (e.g., chicken/fish/eggs/beans/tofu), unless user preferences force otherwise.
` : ''}
- If diet !== "none", prefer recipes whose diet_tags contain that diet, or are clearly compatible.
- If you cannot find enough fully compliant recipes, return as many as you can, but NEVER include allergens.
${healthSection ? `

${healthSection}` : ''}${kidSection ? `

${kidSection}` : ''}

Return ONLY valid JSON in this exact shape and nothing else:

{
  "recipeIds": ["id1", "id2", "id3", "id4", "id5", "id6", "id7"]
}

- Use valid recipe IDs from the "recipes" list.
- Length of recipeIds should be ${days} if possible.
`.trim();

    const userContent = {
      pantryNames,
      prefs,
      recipes,
      days,
      healthyProfile, // may be undefined
    };

    // --- ITEM #4 ONLY: wrap OpenAI call in an in-flight promise and cache on success ---
    const p = (async (): Promise<LlmPlanResponse> => {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: JSON.stringify(userContent),
            },
          ],
        }),
      });

      if (!openaiRes.ok) {
        const errBody = await openaiRes.text();
        console.error('[LLM-PLAN] OpenAI error:', openaiRes.status, errBody);
        return {
          ok: false,
          error: `LLM error (status ${openaiRes.status})`,
          detail: errBody,
        };
      }

      const raw = await openaiRes.json();
      const text: string | undefined = raw?.choices?.[0]?.message?.content ?? '';

      if (!text || typeof text !== 'string') {
        console.error('[LLM-PLAN] Unexpected LLM response format:', raw);
        return { ok: false, error: 'Unexpected LLM response format' };
      }

      let parsed: { recipeIds: string[] };
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.error('[LLM-PLAN] Failed to parse JSON:', e, text);
        return { ok: false, error: 'Failed to parse JSON from LLM', detail: text };
      }

      if (!parsed.recipeIds || !Array.isArray(parsed.recipeIds)) {
        return { ok: false, error: 'Missing recipeIds in LLM response' };
      }

      // --- Server-side guardrails: NEVER return allergens/dislikes/diet-violating recipes ---
      const pantrySet = new Set((pantryNames ?? []).map(norm).filter(Boolean));

      const allergyTerms = expandAllergyTerms(prefs?.allergies ?? []);
      const dislikeTerms = (prefs?.dislikes ?? []).map(norm).filter(Boolean);

      // Build a safe candidate list from provided recipes
      const recipeById = new Map<string, RecipeLite>();
      for (const r of recipes ?? []) recipeById.set(r.id, r);

      const safeRecipes: RecipeLite[] = (recipes ?? []).filter((r) => {
        if (!r?.id) return false;
        if (violatesDietLite(r, prefs?.diet ?? 'none')) return false;
        if (violatesTermsLite(r, allergyTerms)) return false; // HARD
        // dislikes are treated as hard here to bullet-proof; client can relax separately if desired
        if (violatesTermsLite(r, dislikeTerms)) return false;
        return true;
      });

      // Sanitize the model output
      const rawIds = parsed.recipeIds.map((x) => String(x)).filter(Boolean);
      const uniqueIds = uniq(rawIds);

      const pickedSafe: string[] = [];
      for (const id of uniqueIds) {
        const r = recipeById.get(id);
        if (!r) continue;
        if (violatesDietLite(r, prefs?.diet ?? 'none')) continue;
        if (violatesTermsLite(r, allergyTerms)) continue;
        if (violatesTermsLite(r, dislikeTerms)) continue;
        pickedSafe.push(id);
        if (pickedSafe.length >= days) break;
      }

      // Fill remainder deterministically from safe pool
      if (pickedSafe.length < days && safeRecipes.length) {
        const already = new Set(pickedSafe);
        const ranked = safeRecipes
          .filter((r) => !already.has(r.id))
          .slice()
          .sort((a, b) => {
            const sa = scoreFallbackRecipe(a, pantrySet, prefs);
            const sb = scoreFallbackRecipe(b, pantrySet, prefs);
            if (sb !== sa) return sb - sa;
            return a.id.localeCompare(b.id);
          });

        for (const r of ranked) {
          pickedSafe.push(r.id);
          if (pickedSafe.length >= days) break;
        }
      }

      // As an absolute last resort, return whatever safe IDs we could find (may be < days)
      return { ok: true, recipeIds: pickedSafe };
    })();

    inFlight.set(cacheKey, p);
    let value: LlmPlanResponse;
    try {
      value = await p;
    } finally {
      inFlight.delete(cacheKey);
    }

    // Cache only successful plans with recipeIds
    if (value.ok && Array.isArray(value.recipeIds) && value.recipeIds.length) {
      planCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return NextResponse.json<LlmPlanResponse>(value, {
      status: value.ok ? 200 : 502,
      headers: { 'x-mc-llm-cache': 'MISS'},
    });
    // --- END ITEM #4 ONLY ---
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[LLM-PLAN] route error:', message);
    return NextResponse.json<LlmPlanResponse>(
      { ok: false, error: 'Internal error', detail: message },
      { status: 500 },
    );
  }
}