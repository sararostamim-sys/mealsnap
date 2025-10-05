'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import FavoriteButton from '@/components/FavoriteButton'; // ← NEW

type Recipe = { id: string; title: string; time_min: number; diet_tags: string[] | null; instructions: string; };
type Ing = { recipe_id: string; name: string; qty: number | null; unit: string | null; optional: boolean; };

export default function PlanPage() {
  useRequireAuth();

  const [loading, setLoading] = useState(true);
  const [pantry, setPantry] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<{ diet: string; allergies: string[]; dislikes: string[]; max_prep_minutes: number; budget_level: string } | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);
  const [meals, setMeals] = useState<Recipe[]>([]);
  const [shopping, setShopping] = useState<{ name: string; qty: number; unit: string }[]>([]);

  // Modal state
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [pItems, pRes, rRes, iRes] = await Promise.all([
        supabase.from('pantry_items').select('name'),
        supabase.from('preferences').select('*').maybeSingle(),
        supabase.from('recipes').select('id,title,time_min,diet_tags,instructions'),
        supabase.from('recipe_ingredients').select('recipe_id,name,qty,unit,optional'),
      ]);
      setPantry((pItems.data || []).map(x => x.name.toLowerCase()));
      setPrefs(pRes.data ?? { diet: 'none', allergies: [], dislikes: [], max_prep_minutes: 45, budget_level: 'medium' });
      setRecipes(rRes.data || []);
      setIngs(iRes.data || []);
      setLoading(false);
    })();
  }, []);

  function scoreAndPick() {
    if (!prefs) return;
    const ingByRecipe = new Map<string, Ing[]>();
    ings.forEach(i => {
      const arr = ingByRecipe.get(i.recipe_id) || [];
      arr.push(i); ingByRecipe.set(i.recipe_id, arr);
    });

    const allergy = new Set(prefs.allergies.map(a => a.toLowerCase()));
    const dislike = new Set(prefs.dislikes.map(d => d.toLowerCase()));
    const pantrySet = new Set(pantry);

    const scored = recipes.map(r => {
      const ri = ingByRecipe.get(r.id) || [];
      let score = 0;
      // prefer faster recipes
      score += r.time_min <= (prefs.max_prep_minutes ?? 45) ? 2 : -2;
      // simple diet match boost
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
    .sort((a,b) => b.score - a.score);

    const chosen = scored.slice(0, 7).map(x => x.r);
    setMeals(chosen);

    // build shopping list for chosen
    const need = new Map<string, { name: string; qty: number; unit: string }>();
    for (const { r } of scored.slice(0, 7)) {
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
  }

  // helpers to show recipe detail
  const ingByRecipe = useMemo(() => {
    const m = new Map<string, Ing[]>();
    ings.forEach(i => {
      const arr = m.get(i.recipe_id) || [];
      arr.push(i); m.set(i.recipe_id, arr);
    });
    return m;
  }, [ings]);

  const openRecipe = meals.find(m => m.id === openId) || null;
  const openIngs = openId ? (ingByRecipe.get(openId) || []) : [];

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

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Your 7-Day Plan</h1>
      <button onClick={scoreAndPick} className="rounded bg-black text-white px-4 py-2">Generate Plan</button>

      {meals.length > 0 && (
        <>
          <h2 className="text-xl font-semibold mt-6 mb-2">Meals</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {meals.map(m => (
              <div key={m.id} className="border rounded p-3">
                {/* Card header with favorite */}
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{m.title}</div>
                    <div className="text-sm text-gray-600">{m.time_min} min</div>
                  </div>
                  <FavoriteButton recipe={{ id: m.id, title: m.title }} /> {/* ← NEW */}
                </div>

                <p className="text-sm mt-2 line-clamp-3">{m.instructions}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setOpenId(m.id)}
                    className="rounded border px-3 py-1 hover:bg-gray-50"
                  >
                    View Recipe
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h2 className="text-xl font-semibold mt-6 mb-2">Shopping List</h2>
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">Item</th>
                <th className="text-left p-2">Qty</th>
                <th className="text-left p-2">Unit</th>
              </tr>
            </thead>
            <tbody>
              {shopping.map((s, idx) => (
                <tr key={idx} className="border-t">
                  <td className="p-2">{s.name}</td>
                  <td className="p-2">{s.qty}</td>
                  <td className="p-2">{s.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <button onClick={downloadCSV} className="mt-3 rounded border px-4 py-2 hover:bg-gray-50">
            Download CSV
          </button>
        </>
      )}

      {/* Modal */}
      <Modal open={!!openId} onClose={() => setOpenId(null)}>
        {openRecipe ? (
          <div>
            {/* Modal header with favorite */}
            <div className="flex items-start justify-between">
              <h3 className="text-xl font-semibold">{openRecipe.title}</h3>
              <FavoriteButton recipe={{ id: openRecipe.id, title: openRecipe.title }} /> {/* ← NEW */}
            </div>
            <div className="text-sm text-gray-600 mb-3">{openRecipe.time_min} min</div>

            <h4 className="font-medium mt-3 mb-1">Ingredients</h4>
            <ul className="list-disc pl-5 space-y-1">
              {openIngs.map((it, idx) => (
                <li key={idx}>
                  {it.qty ?? ''} {it.unit ?? ''} {it.name}{it.optional ? ' (optional)' : ''}
                </li>
              ))}
              {openIngs.length === 0 && <li className="text-gray-500">No ingredients listed.</li>}
            </ul>

            <h4 className="font-medium mt-4 mb-1">Instructions</h4>
            <p className="whitespace-pre-wrap leading-relaxed">{openRecipe.instructions}</p>

            <div className="mt-4 text-right">
              <button onClick={() => setOpenId(null)} className="rounded border px-4 py-2 hover:bg-gray-50">
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
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* dialog */}
      <div className="absolute inset-0 flex items-start justify-center mt-16 px-4">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-lg">
          {children}
        </div>
      </div>
    </div>
  );
}