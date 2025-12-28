// src/app/favorites/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import FavoriteButton from '@/components/FavoriteButton';

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

export default function FavoritesPage() {
  useRequireAuth();

  const [loading, setLoading] = useState(true);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // 1) get favorite recipe ids (newest first)
      const { data: favs, error: favErr } = await supabase
        .from('favorites')
        .select('recipe_id, created_at')
        .order('created_at', { ascending: false });

      if (favErr) {
        console.error(favErr);
        setRecipes([]);
        setIngs([]);
        setLoading(false);
        return;
      }

      const ids = (favs ?? []).map(f => f.recipe_id);
      if (ids.length === 0) {
        setRecipes([]);
        setIngs([]);
        setLoading(false);
        return;
      }

      // 2) fetch recipe details + ingredients (same fields used on Plan)
      const [{ data: rRes }, { data: iRes }] = await Promise.all([
        supabase.from('recipes')
          .select('id,title,time_min,diet_tags,instructions')
          .in('id', ids),
        supabase.from('recipe_ingredients')
          .select('recipe_id,name,qty,unit,optional')
          .in('recipe_id', ids),
      ]);

      setRecipes(rRes || []);
      setIngs(iRes || []);
      setLoading(false);
    })();
  }, []);

  // helpers to show recipe detail (same pattern as Plan)
  const ingByRecipe = useMemo(() => {
    const m = new Map<string, Ing[]>();
    ings.forEach(i => {
      const arr = m.get(i.recipe_id) || [];
      arr.push(i);
      m.set(i.recipe_id, arr);
    });
    return m;
  }, [ings]);

  const openRecipe = recipes.find(r => r.id === openId) || null;
  const openIngs = openId ? (ingByRecipe.get(openId) || []) : [];

  if (loading) return <p className="max-w-3xl mx-auto">Loading…</p>;
  if (recipes.length === 0) return <p className="max-w-3xl mx-auto">No favorites yet.</p>;

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100">Favorites</h1>

      <div className="grid md:grid-cols-2 gap-4">
        {recipes.map(r => (
          <div
            key={r.id}
            className="border rounded p-3 border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900"
          >
            {/* Card header with favorite (matches Plan) */}
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{r.title}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{r.time_min} min</div>
              </div>
              <FavoriteButton recipe={{ id: r.id, title: r.title }} />
            </div>

            <p className="text-sm mt-2 line-clamp-3">{r.instructions}</p>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setOpenId(r.id)}
                className="rounded border px-3 py-1 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
              >
                View Recipe
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Modal (same look/feel as Plan) */}
      <Modal open={!!openId} onClose={() => setOpenId(null)}>
        {openRecipe ? (
          <div>
            {/* Modal header with favorite */}
            <div className="flex items-start justify-between">
              <h3 className="text-xl font-semibold">{openRecipe.title}</h3>
              <FavoriteButton recipe={{ id: openRecipe.id, title: openRecipe.title }} />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400 mb-3">{openRecipe.time_min} min</div>

            <h4 className="font-medium mt-3 mb-1">Ingredients</h4>
            <ul className="list-disc pl-5 space-y-1">
              {openIngs.map((it, idx) => (
                <li key={idx}>
                  {it.qty ?? ''} {it.unit ?? ''} {it.name}
                  {it.optional ? ' (optional)' : ''}
                </li>
              ))}
              {openIngs.length === 0 && (
                <li className="text-gray-500 dark:text-gray-400">No ingredients listed.</li>
              )}
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

/** Simple modal component (aligned with Plan) */
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