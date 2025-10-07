'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';

type Prefs = {
  user_id?: string;
  diet: string;
  allergies: string[];
  dislikes: string[];
  max_prep_minutes: number;
  budget_level: string;
};

const DIETS = ['none', 'vegetarian', 'vegan', 'gluten_free', 'halal', 'kosher'] as const;
const BUDGET = ['low', 'medium', 'high'] as const;

export default function PreferencesPage() {
  useRequireAuth();

  const [prefs, setPrefs] = useState<Prefs>({
    diet: 'none',
    allergies: [],
    dislikes: [],
    max_prep_minutes: 45,
    budget_level: 'medium',
  });
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('preferences')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data) setPrefs({ ...data });
      setLoading(false);
    })();
  }, []);

  function editList(field: 'allergies' | 'dislikes', value: string) {
    const cur = new Set(prefs[field]);
    if (cur.has(value)) cur.delete(value); else cur.add(value);
    setPrefs({ ...prefs, [field]: Array.from(cur) });
  }

  async function save() {
    setSaved(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const payload: Prefs = { ...prefs, user_id: user.id };
    const { error } = await supabase.from('preferences').upsert(payload);
    if (!error) setSaved(true);
  }

  if (loading) return <p>Loading…</p>;

  // chip styles
  const chipBase =
    'px-3 py-1.5 rounded-md border text-sm transition';
  const chipOff =
    'border-gray-300 dark:border-gray-700 ' +
    'bg-white dark:bg-neutral-900 ' +
    'text-gray-700 dark:text-gray-300';
  const chipOn =
    'border-gray-800 dark:border-gray-200 ' +
    'bg-gray-100 dark:bg-neutral-800 ' +
    'text-gray-900 dark:text-gray-100';

  const inputCls =
    'rounded border px-3 py-2 ' +
    'border-gray-300 dark:border-gray-700 ' +
    'bg-white dark:bg-neutral-900 ' +
    'text-gray-900 dark:text-gray-100 ' +
    'placeholder:text-gray-400 dark:placeholder:text-gray-500';

  const selectCls = inputCls + ' pr-8';

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100">Preferences</h1>

      <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm">
        {/* Diet */}
        <div className="mb-5">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">Diet</label>
          <select
            className={`${selectCls} w-48`}
            value={prefs.diet}
            onChange={(e) => setPrefs((p) => ({ ...p, diet: e.target.value }))}
          >
            {DIETS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        {/* Allergies */}
        <div className="mb-5">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">Allergies (toggle)</label>
          <div className="flex flex-wrap gap-2">
            {['peanut', 'shellfish', 'gluten', 'dairy', 'egg', 'soy', 'sesame'].map((a) => {
              const selected = prefs.allergies.includes(a);
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => editList('allergies', a)}
                  className={`${chipBase} ${selected ? chipOn : chipOff}`}
                >
                  {a}
                </button>
              );
            })}
          </div>
        </div>

        {/* Dislikes */}
        <div className="mb-6">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">Dislikes (toggle)</label>
          <div className="flex flex-wrap gap-2">
            {['cilantro', 'mushroom', 'tuna', 'broccoli', 'olives', 'beets'].map((d) => {
              const selected = prefs.dislikes.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => editList('dislikes', d)}
                  className={`${chipBase} ${selected ? chipOn : chipOff}`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        {/* Numbers/select row */}
        <div className="mb-6 flex flex-wrap gap-6">
          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">Max prep minutes</label>
            <input
              type="number"
              className={`${inputCls} w-32`}
              value={prefs.max_prep_minutes}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, max_prep_minutes: Number(e.target.value) }))
              }
            />
          </div>
          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">Budget</label>
            <select
              className={`${selectCls} w-40`}
              value={prefs.budget_level}
              onChange={(e) => setPrefs((p) => ({ ...p, budget_level: e.target.value }))}
            >
              {BUDGET.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            className="rounded px-4 py-2 bg-black text-white hover:opacity-90
                       dark:bg-white dark:text-black"
          >
            Save
          </button>
          {saved ? <span className="text-green-600 dark:text-green-400">Saved!</span> : null}
        </div>
      </section>
    </div>
  );
}