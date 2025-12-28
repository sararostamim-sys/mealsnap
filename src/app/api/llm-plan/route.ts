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
  budget_level: string;
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
      budget_level: prefs.budget_level ?? 'medium',
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
- budget_level: "low" | "medium" | "high" (use cheaper-looking ingredients for "low" when possible)
- favorite_mode: prefs.favorite_mode (if "favorites", it's okay to repeat favorite-type recipes a bit more often)
- healthy_whole_food: prefs.healthy_whole_food (if true, prefer more whole, minimally processed options)
- kid_friendly: prefs.kid_friendly (if true, avoid very spicy or very complex flavors)

${microSurveySection}

Pantry:
- pantryNames is a list of ingredient names the user already has.
- Prefer recipes whose ingredients appear in pantryNames, but some extra shopping is OK.

Other rules:
- Aim for variety across the week (avoid repeating the same recipe if possible).
- If diet !== "none", prefer recipes whose diet_tags contain that diet, or are clearly compatible.
- If you cannot find enough fully compliant recipes, choose the best approximate matches, but NEVER include allergens.
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

      return { ok: true, recipeIds: parsed.recipeIds };
    })();

    inFlight.set(cacheKey, p);
    const value = await p;
    inFlight.delete(cacheKey);

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