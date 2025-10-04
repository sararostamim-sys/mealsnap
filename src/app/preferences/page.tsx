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
    cur.has(value) ? cur.delete(value) : cur.add(value);
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

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4">Preferences</h1>

      <div className="mb-4">
        <label className="block mb-1 font-medium">Diet</label>
        <select
          className="border rounded px-3 py-2"
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

      <div className="mb-4">
        <label className="block mb-1 font-medium">Allergies (toggle)</label>
        <div className="flex flex-wrap gap-2">
          {['peanut', 'shellfish', 'gluten', 'dairy', 'egg', 'soy', 'sesame'].map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => editList('allergies', a)}
              className={`px-3 py-1 rounded border ${
                prefs.allergies.includes(a) ? 'bg-black text-white' : 'bg-white'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <label className="block mb-1 font-medium">Dislikes (toggle)</label>
        <div className="flex flex-wrap gap-2">
          {['cilantro', 'mushroom', 'tuna', 'broccoli', 'olives', 'beets'].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => editList('dislikes', d)}
              className={`px-3 py-1 rounded border ${
                prefs.dislikes.includes(d) ? 'bg-black text-white' : 'bg-white'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex gap-4">
        <div>
          <label className="block mb-1 font-medium">Max prep minutes</label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-32"
            value={prefs.max_prep_minutes}
            onChange={(e) =>
              setPrefs((p) => ({ ...p, max_prep_minutes: Number(e.target.value) }))
            }
          />
        </div>
        <div>
          <label className="block mb-1 font-medium">Budget</label>
          <select
            className="border rounded px-3 py-2"
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

      <div className="flex items-center gap-3">
        <button onClick={save} className="rounded bg-black text-white px-4 py-2">
          Save
        </button>
        {saved && <span className="text-green-600">Saved!</span>}
      </div>
    </div>
  );
}