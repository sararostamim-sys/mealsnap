'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { trackEvent } from '@/lib/analytics';

type SharedMeal = {
  id: string;
  title: string;
  time_min: number;
  diet_tags: string[] | null;
  position: number;
};

type RecipeJoinRow = {
  id?: unknown;
  title?: unknown;
  time_min?: unknown;
  diet_tags?: unknown;
};

type ItemJoinRow = {
  position?: unknown;
  recipes?: unknown;
};

export default function SharedPlanPage() {
  const router = useRouter();
  const params = useParams<{ shareId: string }>();
  const shareId = params?.shareId;

  // ✅ IMPORTANT: hooks must run unconditionally (no early return before hooks)
  const supabaseShared = useMemo(() => {
    if (!shareId) return null;

    // Dedicated client including x-share-id for RLS
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            'x-share-id': shareId,
          },
        },
      },
    );
  }, [shareId]);

  const [loading, setLoading] = useState(true);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [meals, setMeals] = useState<SharedMeal[]>([]);
  const [error, setError] = useState<string>('');

  function goToLoginForDetails(recipeId: string) {
    if (!shareId) return;
    trackEvent('shared_view_details_click', { share_id: shareId, recipe_id: recipeId });
    const next = `/share/plan/${shareId}?open=${encodeURIComponent(recipeId)}`;
    router.push(`/login?next=${encodeURIComponent(next)}`);
  }

  function goToCreateYourOwnPlan() {
    const next = `/pantry`;
    router.push(`/login?next=${encodeURIComponent(next)}`);
  }

  useEffect(() => {
    if (!shareId || !supabaseShared) {
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      setError('');

      // 1) Fetch the plan by share_id
      const planRes = await supabaseShared
        .from('user_meal_plan')
        .select('id, generated_at')
        .eq('share_id', shareId)
        .maybeSingle();

      if (planRes.error) {
        setError(planRes.error.message);
        setLoading(false);
        return;
      }

      if (!planRes.data) {
        setError('This shared plan link is invalid or expired.');
        setLoading(false);
        return;
      }

      setGeneratedAt(planRes.data.generated_at ?? null);

      // 2) Fetch plan recipes in order, join recipes
      const itemsRes = await supabaseShared
        .from('user_meal_plan_recipes')
        .select(
          `
          position,
          recipes (
            id,
            title,
            time_min,
            diet_tags
          )
        `,
        )
        .eq('plan_id', planRes.data.id)
        .order('position', { ascending: true });

      if (itemsRes.error) {
        setError(itemsRes.error.message);
        setLoading(false);
        return;
      }

      const rawRows = (itemsRes.data ?? []) as unknown[];

      const parsedMeals: SharedMeal[] = rawRows
        .map((r) => r as ItemJoinRow)
        .map((r) => {
          const recipe = (r.recipes as RecipeJoinRow | undefined) ?? undefined;

          const id = recipe?.id != null ? String(recipe.id) : '';
          const title = recipe?.title != null ? String(recipe.title) : '';
          const time_min = recipe?.time_min != null ? Number(recipe.time_min) : 0;
          const diet_tags = Array.isArray(recipe?.diet_tags)
            ? (recipe!.diet_tags as string[])
            : null;

          return {
            position: typeof r.position === 'number' ? r.position : 0,
            id,
            title,
            time_min,
            diet_tags,
          };
        })
        .filter((m) => !!m.id);

      setMeals(parsedMeals);
      setLoading(false);
    })();
  }, [supabaseShared, shareId]);

  // ✅ Now it’s safe to render based on shareId (hooks already ran)
  if (!shareId) return <p className="max-w-3xl mx-auto p-4">Loading…</p>;
  if (loading) return <p className="max-w-3xl mx-auto p-4">Loading…</p>;

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-2xl font-semibold">7-Day Dinner Plan</h1>

      {generatedAt ? (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Generated on {new Date(generatedAt).toLocaleString()}
        </p>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 text-red-900 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      {!error && meals.length > 0 ? (
        <div className="mt-4 grid md:grid-cols-2 gap-4">
          {meals.map((m) => (
            <div
              key={`${m.position}-${m.id}`}
              className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm"
            >
              <div className="font-medium">
                Day {m.position + 1}: {m.title}
              </div>
              <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {m.time_min} min
              </div>

              {m.diet_tags && m.diet_tags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {m.diet_tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded-full border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-200"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="mt-3">
                <button
                  onClick={() => goToLoginForDetails(m.id)}
                  className="text-sm rounded px-3 py-1.5 border transition
                             border-gray-200 dark:border-gray-700
                             text-gray-900 dark:text-gray-100
                             hover:bg-gray-50 dark:hover:bg-neutral-800"
                >
                  View full recipe
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!error && meals.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
          No meals found for this shared plan.
        </p>
      ) : null}

      {!error ? (
        <div className="mt-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4">
          <div className="font-medium">Want a plan like this?</div>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Sign in to build your own plan from your pantry.
          </p>
          <div className="mt-3">
            <button
              onClick={goToCreateYourOwnPlan}
              className="text-sm rounded px-3 py-1.5 bg-black text-white hover:opacity-90 transition
                         dark:bg-white dark:text-black"
            >
              Sign in to create a plan
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}