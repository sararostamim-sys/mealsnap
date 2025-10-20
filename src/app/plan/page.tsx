'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import FavoriteButton from '@/components/FavoriteButton';
import { getDevUserId } from '@/lib/user';

type Recipe = { id: string; title: string; time_min: number; diet_tags: string[] | null; instructions: string };
type Ing = { recipe_id: string; name: string; qty: number | null; unit: string | null; optional: boolean };
type Prefs = { diet: string; allergies: string[]; dislikes: string[]; max_prep_minutes: number; budget_level: string; updated_at?: string };
type PantryRow = { name: string; updated_at: string };
type PlanItem = { recipe_id: string; position: number };
type PlanHeader = { id: string; generated_at: string; user_meal_plan_recipes?: PlanItem[] };

export default function PlanPage() {
  useRequireAuth();

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const [pantry, setPantry] = useState<PantryRow[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);

  const [meals, setMeals] = useState<Recipe[]>([]);
  const [shopping, setShopping] = useState<{ name: string; qty: number; unit: string }[]>([]);
  const [planMeta, setPlanMeta] = useState<{ id: string; generated_at: string } | null>(null);
  const [stale, setStale] = useState(false);

  // Modal state
  const [openId, setOpenId] = useState<string | null>(null);

  /** Prefer authenticated user; fall back to .env dev id */
  async function resolveUserId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? getDevUserId();
    setUserId(uid);
    return uid;
  }

  // Build an index of ingredients by recipe for quick lookups
  const ingByRecipe = useMemo(() => {
    const m = new Map<string, Ing[]>();
    ings.forEach(i => {
      const arr = m.get(i.recipe_id) || [];
      arr.push(i);
      m.set(i.recipe_id, arr);
    });
    return m;
  }, [ings]);

  // Recompute shopping list from chosen meals + current pantry
  const recomputeShopping = useCallback((chosen: Recipe[]) => {
    const pantrySet = new Set(pantry.map(p => p.name.toLowerCase()));
    const need = new Map<string, { name: string; qty: number; unit: string }>();

    for (const r of chosen) {
      const ri = ingByRecipe.get(r.id) || [];
      for (const it of ri) {
        const name = it.name.toLowerCase();
        if (!pantrySet.has(name)) {
          const key = `${name}|${it.unit ?? 'unit'}`;
          const cur = need.get(key) || { name, qty: 0, unit: it.unit ?? 'unit' };
          need.set(key, { ...cur, qty: cur.qty + (Number(it.qty) || 1) });
        }
      }
    }
    setShopping(Array.from(need.values()));
  }, [ingByRecipe, pantry]);

  // Keep shopping list in sync when meals or ingredients change
  useEffect(() => {
    if (meals.length) recomputeShopping(meals);
  }, [meals, recomputeShopping]);

  // Initial load: user + pantry/prefs/recipes/ings + latest saved plan
  useEffect(() => {
    (async () => {
      setLoading(true);
      const uid = await resolveUserId();

      const [pItems, pRes, rRes, iRes] = await Promise.all([
        supabase.from('pantry_items')
          .select('name,updated_at')
          .eq('user_id', uid),
        supabase.from('preferences')
          .select('*')
          .eq('user_id', uid)
          .maybeSingle(),
        supabase.from('recipes')
          .select('id,title,time_min,diet_tags,instructions'),
        supabase.from('recipe_ingredients')
          .select('recipe_id,name,qty,unit,optional'),
      ]);

      const pantryRows: PantryRow[] = (pItems.data || []).map(x => ({
        name: String(x.name).toLowerCase(),
        updated_at: x.updated_at || new Date(0).toISOString(),
      }));
      setPantry(pantryRows);

      // Map DB columns → local Prefs shape
      const pr = pRes.data as any;
      const prefsRow: Prefs = pr ? {
        diet: pr.diet ?? 'none',
        allergies: pr.allergies ?? [],
        dislikes: pr.disliked_ingredients ?? [],        // map from DB column
        max_prep_minutes: pr.max_prep_time ?? 45,       // map from DB column
        budget_level: pr.budget_level ?? 'medium',
        updated_at: pr.updated_at ?? undefined
      } : {
        diet: 'none',
        allergies: [],
        dislikes: [],
        max_prep_minutes: 45,
        budget_level: 'medium',
      };
      setPrefs(prefsRow);

      const recipeRows: Recipe[] = rRes.data || [];
      setRecipes(recipeRows);
      setIngs(iRes.data || []);

      // Load latest saved plan (+ items) for this user
      const { data: plan } = await supabase
        .from('user_meal_plan')
        .select('id, generated_at, user_meal_plan_recipes (recipe_id, position)')
        .eq('user_id', uid)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle<PlanHeader>();

      if (plan) {
        const byId = new Map(recipeRows.map(r => [r.id, r]));
        const items = (plan.user_meal_plan_recipes || []).slice().sort((a, b) => a.position - b.position);
        const chosen = items.map(it => byId.get(it.recipe_id)).filter(Boolean) as Recipe[];
        setMeals(chosen);
        setPlanMeta({ id: plan.id, generated_at: plan.generated_at });

        // Staleness: if pantry/prefs changed after plan.generated_at
        const pantryMax = pantryRows.length ? Math.max(...pantryRows.map(p => Date.parse(p.updated_at))) : 0;
        const prefsUpdated = prefsRow.updated_at ? Date.parse(prefsRow.updated_at) : 0;
        const planTs = Date.parse(plan.generated_at);
        setStale(pantryMax > planTs || prefsUpdated > planTs);
      }

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generate a fresh plan and persist it
  const generateAndSave = useCallback(async () => {
    if (!prefs || !userId) return;

    // Build indexes for scoring
    const allergy = new Set((prefs.allergies || []).map(a => a.toLowerCase()));
    const dislike = new Set((prefs.dislikes || []).map(d => d.toLowerCase()));
    const pantrySet = new Set(pantry.map(p => p.name));

    const ingIndex = new Map<string, Ing[]>();
    ings.forEach(i => {
      const arr = ingIndex.get(i.recipe_id) || [];
      arr.push(i); ingIndex.set(i.recipe_id, arr);
    });

    const scored = recipes.map(r => {
      const ri = ingIndex.get(r.id) || [];
      let score = 0;
      // prefer faster recipes
      score += r.time_min <= (prefs.max_prep_minutes ?? 45) ? 2 : -2;
      // diet tag boost
      if (prefs.diet !== 'none' && (r.diet_tags || []).includes(prefs.diet)) score += 1;
      // pantry usage / avoid allergens / dislikes
      for (const it of ri) {
        const name = it.name.toLowerCase();
        if (pantrySet.has(name)) score += 1;
        if (allergy.has(name)) return { r, score: -999, ri }; // hard reject
        if (dislike.has(name)) score -= 2;
      }
      return { r, score, ri };
    })
    .filter(x => x.score > -500)
    .sort((a, b) => b.score - a.score);

    const chosen = scored.slice(0, 7).map(x => x.r);

    // 1) create plan header (scoped to current user)
    const { data: planRow, error: planErr } = await supabase
      .from('user_meal_plan')
      .insert({ user_id: userId })
      .select('id,generated_at')
      .single();
    if (planErr || !planRow) { console.error(planErr); return; }

    // 2) insert plan items
    const itemsPayload = chosen.map((r, idx) => ({
      plan_id: planRow.id,
      recipe_id: r.id,
      position: idx,
    }));
    const { error: itemsErr } = await supabase.from('user_meal_plan_recipes').insert(itemsPayload);
    if (itemsErr) { console.error(itemsErr); return; }

    // 3) update UI
    setMeals(chosen);
    setPlanMeta({ id: planRow.id, generated_at: planRow.generated_at });
    setStale(false);
    recomputeShopping(chosen);
  }, [prefs, userId, pantry, ings, recipes, recomputeShopping]);

  function downloadCSV() {
    const header = 'name,qty,unit';
    const lines = shopping.map(s => `${s.name},${s.qty},${s.unit}`);
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'shopping_list.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p>Loading…</p>;

  const openRecipe = meals.find(m => m.id === openId) || null;
  const openIngs = openId ? (ingByRecipe.get(openId) || []) : [];
  const generatedLabel = planMeta ? new Date(planMeta.generated_at).toLocaleString() : null;

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Your 7-Day Plan</h1>
          {generatedLabel && !stale && (
            <p className="text-sm text-gray-600 dark:text-gray-400">Generated on {generatedLabel}</p>
          )}
          {stale && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2 text-sm
                            dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100">
              Your pantry or preferences changed since this plan was created.
              <span className="ml-2 font-medium">Regenerate to refresh.</span>
            </div>
          )}
        </div>

        {/* Primary button (dark-mode friendly) */}
        <button
          onClick={generateAndSave}
          className="rounded px-4 py-2
                     bg-black text-white hover:opacity-90
                     dark:bg-white dark:text-black"
        >
          {meals.length ? 'Regenerate plan' : 'Generate plan'}
        </button>
      </div>

      {meals.length > 0 && (
        <>
          <h2 className="text-xl font-semibold mt-6 mb-2">Meals</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {meals.map(m => (
              <div
                key={m.id}
                className="border rounded p-3 border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{m.title}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">{m.time_min} min</div>
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

          <h2 className="text-xl font-semibold mt-6 mb-2">Shopping List</h2>
          <table className="w-full text-sm border border-gray-200 dark:border-gray-800">
            <thead className="bg-gray-50 dark:bg-neutral-900">
              <tr>
                <th className="text-left p-2">Item</th>
                <th className="text-left p-2">Qty</th>
                <th className="text-left p-2">Unit</th>
              </tr>
            </thead>
            <tbody>
              {shopping.map((s, idx) => (
                <tr key={idx} className="border-t border-gray-200 dark:border-gray-800">
                  <td className="p-2">{s.name}</td>
                  <td className="p-2">{s.qty}</td>
                  <td className="p-2">{s.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Download CSV matches primary button style, bottom-left */}
          <div className="mt-3">
            <button
              onClick={downloadCSV}
              className="rounded px-4 py-2
                         bg-black text-white hover:opacity-90
                         dark:bg-white dark:text-black"
            >
              Download CSV
            </button>
          </div>
        </>
      )}

      {/* Modal */}
      <Modal open={!!openId} onClose={() => setOpenId(null)}>
        {openRecipe ? (
          <div>
            <div className="flex items-start justify-between">
              <h3 className="text-xl font-semibold">{openRecipe.title}</h3>
              <FavoriteButton recipe={{ id: openRecipe.id, title: openRecipe.title }} />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400 mb-3">{openRecipe.time_min} min</div>

            <h4 className="font-medium mt-3 mb-1">Ingredients</h4>
            <ul className="list-disc pl-5 space-y-1">
              {openIngs.map((it, idx) => (
                <li key={idx}>
                  {it.qty ?? ''} {it.unit ?? ''} {it.name}{it.optional ? ' (optional)' : ''}
                </li>
              ))}
              {openIngs.length === 0 && <li className="text-gray-500 dark:text-gray-400">No ingredients listed.</li>}
            </ul>

            <h4 className="font-medium mt-4 mb-1">Instructions</h4>
            <p className="whitespace-pre-wrap leading-relaxed">{openRecipe.instructions}</p>

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
function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      {/* dialog */}
      <div className="absolute inset-0 flex items-start justify-center mt-16 px-4">
        <div className="w-full max-w-2xl rounded-lg bg-white dark:bg-neutral-900 p-6 shadow-lg border border-gray-200 dark:border-gray-800">
          {children}
        </div>
      </div>
    </div>
  );
}