// src/app/api/llm-plan/route.ts
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type PrefsLite = {
  diet: string;
  allergies: string[];
  dislikes: string[];
  max_prep_minutes: number;
  budget_level: string;
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
};

type LlmPlanResponse = {
  ok: boolean;
  recipeIds?: string[];
  error?: string;
  detail?: string;
};

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  return key;
}

export async function POST(req: NextRequest) {
      // Feature flag: allow disabling LLM when quota is out or during testing
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
    const { pantryNames, prefs, recipes, days = 7 } = body;

    if (!recipes || recipes.length === 0) {
      return NextResponse.json<LlmPlanResponse>(
        { ok: false, error: 'No recipes provided' },
        { status: 400 },
      );
    }

    const apiKey = getApiKey();

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

Pantry:
- pantryNames is a list of ingredient names the user already has.
- Prefer recipes whose ingredients appear in pantryNames, but some extra shopping is OK.

Other rules:
- Aim for variety across the week (avoid repeating the same recipe if possible).
- If diet !== "none", prefer recipes whose diet_tags contain that diet, or are clearly compatible.
- If you cannot find enough fully compliant recipes, choose the best approximate matches, but NEVER include allergens.

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
    };

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
            // send the structured data as JSON string so the model can inspect it
            content: JSON.stringify(userContent),
          },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      console.error('[LLM-PLAN] OpenAI error:', openaiRes.status, errBody);
      return NextResponse.json<LlmPlanResponse>(
        {
          ok: false,
          error: `LLM error (status ${openaiRes.status})`,
          detail: errBody,
        },
        { status: 502 },
      );
    }

    const raw = await openaiRes.json();

    const text: string | undefined =
      raw?.choices?.[0]?.message?.content ?? '';

    if (!text || typeof text !== 'string') {
      console.error('[LLM-PLAN] Unexpected LLM response format:', raw);
      return NextResponse.json<LlmPlanResponse>(
        { ok: false, error: 'Unexpected LLM response format' },
        { status: 500 },
      );
    }

    let parsed: { recipeIds: string[] };
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('[LLM-PLAN] Failed to parse JSON:', e, text);
      return NextResponse.json<LlmPlanResponse>(
        { ok: false, error: 'Failed to parse JSON from LLM', detail: text },
        { status: 500 },
      );
    }

    if (!parsed.recipeIds || !Array.isArray(parsed.recipeIds)) {
      return NextResponse.json<LlmPlanResponse>(
        { ok: false, error: 'Missing recipeIds in LLM response' },
        { status: 500 },
      );
    }

    return NextResponse.json<LlmPlanResponse>(
      { ok: true, recipeIds: parsed.recipeIds },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('[LLM-PLAN] route error:', err?.message ?? err);
    return NextResponse.json<LlmPlanResponse>(
      { ok: false, error: 'Internal error', detail: String(err?.message ?? err) },
      { status: 500 },
    );
  }
}