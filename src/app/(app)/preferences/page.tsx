// src/app/preferences/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { getDevUserId } from '@/lib/user';

type Prefs = {
  user_id?: string;
  diet: string;
  allergies: string[];
  dislikes: string[];
  max_prep_minutes: number;
  budget_level: string;
  favorite_mode: 'variety' | 'favorites';
  healthy_whole_food: boolean;
  kid_friendly: boolean;
  // NEW: healthy micro-survey fields (stored in Supabase)
  healthy_goal: 'feel_better' | 'weight' | 'metabolic' | '';
  healthy_protein_style: 'mixed' | 'lean_animal' | 'plant_forward' | '';
  healthy_carb_pref: 'more_whole_grains' | 'lower_carb' | 'no_preference' | '';
  dinners_per_week: number; // 3–7
  people_count: number;     // 1–6
};

type HealthySurvey = {
  goal: 'feel_better' | 'weight' | 'metabolic' | '';
  proteinPreference: 'mixed' | 'lean_animal' | 'plant_forward' | '';
  carbBias: 'more_whole_grains' | 'lower_carb' | 'no_preference' | '';
};

const DIETS = ['none', 'vegetarian', 'vegan', 'gluten_free', 'halal', 'kosher'] as const;
const BUDGET = ['low', 'medium', 'high'] as const;

const HEALTHY_SURVEY_KEY = 'mc_healthy_survey_v1';
const HEALTHY_SURVEY_DONE_KEY = 'mc_healthy_survey_v1_completed';

export default function PreferencesPage() {
  useRequireAuth();

  const [prefs, setPrefs] = useState<Prefs>({
    diet: 'none',
    allergies: [],
    dislikes: [],
    max_prep_minutes: 45,
    budget_level: 'medium',
    favorite_mode: 'variety',
    healthy_whole_food: false,
    kid_friendly: false,
    healthy_goal: '',
    healthy_protein_style: '',
    healthy_carb_pref: '',
    dinners_per_week: 7,
    people_count: 2,
  });

  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  // Healthy micro-survey state
  const [showHealthySurvey, setShowHealthySurvey] = useState(false);
  const [healthySurvey, setHealthySurvey] = useState<HealthySurvey>({
    goal: '',
    proteinPreference: '',
    carbBias: '',
  });

  /** Resolve current user id (auth → env fallback) */
  async function resolveUserId(): Promise<string> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.id ?? getDevUserId();
  }

  // Load existing preferences + any saved micro-survey answers
  useEffect(() => {
    (async () => {
      const userId = await resolveUserId();
      const { data } = await supabase
        .from('preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (data) {
        setPrefs({
          user_id: data.user_id,
          diet: data.diet ?? 'none',
          allergies: data.allergies ?? [],
          dislikes: data.disliked_ingredients ?? [],
          max_prep_minutes: data.max_prep_time ?? 45,
          budget_level: data.budget_level ?? 'medium',
          favorite_mode: data.favorite_mode === 'favorites' ? 'favorites' : 'variety',
          healthy_whole_food: data.healthy_whole_food ?? false,
          kid_friendly: data.kid_friendly ?? false,
          healthy_goal: (data.healthy_goal as Prefs['healthy_goal']) ?? '',
          healthy_protein_style:
            (data.healthy_protein_style as Prefs['healthy_protein_style']) ?? '',
          healthy_carb_pref:
            (data.healthy_carb_pref as Prefs['healthy_carb_pref']) ?? '',
          dinners_per_week: data.dinners_per_week ?? 7,
          people_count: data.people_count ?? 2,
        });
      }

      // --- Initialize micro-survey state from Supabase + localStorage ---
      // 1) Base from Supabase (if any)
      let surveyFromDb: HealthySurvey = {
        goal: (data?.healthy_goal as HealthySurvey['goal']) ?? '',
        proteinPreference:
          (data?.healthy_protein_style as HealthySurvey['proteinPreference']) ?? '',
        carbBias: (data?.healthy_carb_pref as HealthySurvey['carbBias']) ?? '',
      };

      // 2) If localStorage has newer answers, prefer those
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(HEALTHY_SURVEY_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<HealthySurvey>;
            surveyFromDb = {
              goal: parsed.goal ?? surveyFromDb.goal,
              proteinPreference:
                parsed.proteinPreference ?? surveyFromDb.proteinPreference,
              carbBias: parsed.carbBias ?? surveyFromDb.carbBias,
            };
          } catch {
            // ignore parse errors; we'll just keep DB values
          }
        }
      }

      setHealthySurvey(surveyFromDb);
      setLoading(false);
    })();
  }, []);

  // Toggle allergy/dislike chips
  function editList(field: 'allergies' | 'dislikes', value: string) {
    const cur = new Set(prefs[field]);
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    setPrefs({ ...prefs, [field]: Array.from(cur) });
  }

  // Save or update preferences (now includes micro-survey fields)
  async function save() {
    setSaved(false);
    const userId = await resolveUserId();

    const payload = {
      user_id: userId,
      diet: prefs.diet,
      allergies: prefs.allergies,
      disliked_ingredients: prefs.dislikes,
      max_prep_time: prefs.max_prep_minutes,
      budget_level: prefs.budget_level,
      favorite_mode: prefs.favorite_mode,
      healthy_whole_food: prefs.healthy_whole_food,
      kid_friendly: prefs.kid_friendly,
      healthy_goal: prefs.healthy_goal || null,
      healthy_protein_style: prefs.healthy_protein_style || null,
      healthy_carb_pref: prefs.healthy_carb_pref || null,
      dinners_per_week: prefs.dinners_per_week,
      people_count: prefs.people_count,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('preferences').upsert(payload, {
      onConflict: 'user_id',
    });
    if (!error) setSaved(true);
    else console.error(error);
  }

  // Persist healthy survey to localStorage AND sync into prefs
  function persistHealthySurvey(next: HealthySurvey) {
    setHealthySurvey(next);
    setPrefs((p) => ({
      ...p,
      healthy_goal: next.goal,
      healthy_protein_style: next.proteinPreference,
      healthy_carb_pref: next.carbBias,
    }));

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(HEALTHY_SURVEY_KEY, JSON.stringify(next));
      window.localStorage.setItem(HEALTHY_SURVEY_DONE_KEY, '1');
    }

    // Optional: if you want the micro-survey to auto-save to Supabase
    // as soon as they hit "Save preferences" in the modal, uncomment:
    // void save();
  }

  if (loading) return <p className="max-w-2xl mx-auto">Loading…</p>;

  // shared styles (kept consistent with Pantry)
  const chipBase = 'px-3 py-1.5 rounded-md border text-sm transition';
  const chipOff =
    'border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-700 dark:text-gray-300';
  const chipOn =
    'border-gray-800 dark:border-gray-200 bg-gray-100 dark:bg-neutral-800 text-gray-900 dark:text-gray-100';
  const inputCls =
    'rounded border px-3 py-2 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500';
  const selectCls = inputCls + ' pr-8';

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
        Preferences
      </h1>

      {/* Card (same look & sizing philosophy as Pantry) */}
      <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm">
        {/* Diet */}
        <div className="mb-5">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
            Diet
          </label>
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
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
            Allergies (toggle)
          </label>
          <div className="flex flex-wrap gap-2">
            {['peanut', 'shellfish', 'gluten', 'dairy', 'egg', 'soy', 'sesame'].map(
              (a) => {
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
              },
            )}
          </div>
        </div>

        {/* Dislikes */}
        <div className="mb-6">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
            Dislikes (toggle)
          </label>
          <div className="flex flex-wrap gap-2">
            {['cilantro', 'mushroom', 'tuna', 'broccoli', 'olives', 'beets'].map(
              (d) => {
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
              },
            )}
          </div>
        </div>

        {/* Numbers/select row */}
        <div className="mb-4 flex flex-wrap gap-6">
          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              Max prep minutes
            </label>
            <input
              type="number"
              className={`${inputCls} w-32`}
              value={prefs.max_prep_minutes}
              onChange={(e) =>
                setPrefs((p) => ({
                  ...p,
                  max_prep_minutes: Number(e.target.value),
                }))
              }
            />
          </div>
          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              Budget
            </label>
            <select
              className={`${selectCls} w-40`}
              value={prefs.budget_level}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, budget_level: e.target.value }))
              }
            >
              {BUDGET.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>

                {/* Planning defaults */}
        <div className="mb-5 flex flex-wrap gap-6">
          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              Dinners per week
            </label>
            <select
              className={`${selectCls} w-32`}
              value={prefs.dinners_per_week}
              onChange={(e) =>
                setPrefs((p) => ({
                  ...p,
                  dinners_per_week: Number(e.target.value),
                }))
              }
            >
              {[3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              People
            </label>
            <select
              className={`${selectCls} w-32`}
              value={prefs.people_count}
              onChange={(e) =>
                setPrefs((p) => ({
                  ...p,
                  people_count: Number(e.target.value),
                }))
              }
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Health & family preferences */}
        <div className="mb-5">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
            Health &amp; family preferences
          </label>
          <div className="flex flex-col gap-2 text-sm">
            {/* Healthy whole-food focus with checkbox + pencil */}
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={prefs.healthy_whole_food}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setPrefs((p) => ({ ...p, healthy_whole_food: checked }));

                  if (checked) {
                    // First time enabling? Open micro-survey automatically unless completed before.
                    if (typeof window !== 'undefined') {
                      const done = window.localStorage.getItem(
                        HEALTHY_SURVEY_DONE_KEY,
                      );
                      if (!done) {
                        setShowHealthySurvey(true);
                      }
                    } else {
                      setShowHealthySurvey(true);
                    }
                  }
                }}
              />
              <span className="inline-flex items-center gap-1 text-gray-800 dark:text-gray-200">
                Healthy, whole-food focus
                {prefs.healthy_whole_food && (
                  <button
                    type="button"
                    onClick={() => setShowHealthySurvey(true)}
                    className="ml-1 inline-flex items-center rounded-full border border-gray-300 dark:border-gray-600 bg-white/70 dark:bg-neutral-800/70 px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-700"
                    aria-label="Edit healthy preferences"
                  >
                    <span aria-hidden="true">✏️</span>
                  </button>
                )}
              </span>
            </label>

            {/* Kid-friendly */}
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={prefs.kid_friendly}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, kid_friendly: e.target.checked }))
                }
              />
              <span className="text-gray-800 dark:text-gray-200">
                Make dinners kid-friendly (simpler flavors, softer textures)
              </span>
            </label>
          </div>
        </div>

        {/* Plan style: variety vs favorites */}
        <div className="mb-5">
          <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
            Plan style
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                setPrefs((p) => ({ ...p, favorite_mode: 'variety' }))
              }
              className={`${chipBase} ${
                prefs.favorite_mode === 'variety' ? chipOn : chipOff
              }`}
            >
              Prefer more variety
            </button>
            <button
              type="button"
              onClick={() =>
                setPrefs((p) => ({ ...p, favorite_mode: 'favorites' }))
              }
              className={`${chipBase} ${
                prefs.favorite_mode === 'favorites' ? chipOn : chipOff
              }`}
            >
              Repeat my favorites often
            </button>
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            className="rounded px-4 py-2 bg-black text-white hover:opacity-90 dark:bg:white dark:text-black"
          >
            Save
          </button>
          {saved ? (
            <span className="text-green-600 dark:text-green-400">Saved!</span>
          ) : null}
        </div>
      </section>

      {/* Healthy micro-survey modal */}
      {showHealthySurvey && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowHealthySurvey(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-0 flex items-start justify-center mt-16 px-4">
            <div className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-900 p-6 shadow-lg border border-gray-200 dark:border-gray-800">
              <h2 className="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-100">
                Fine-tune your healthy plan
              </h2>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
                These stay private and simply help MealCue prioritize the right
                recipes for you.
              </p>

              {/* Q1 */}
              <div className="mb-4">
                <div className="text-sm font-medium mb-1 text-gray-900 dark:text-gray-100">
                  1. What&apos;s your main goal right now?
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="goal"
                      value="feel_better"
                      checked={healthySurvey.goal === 'feel_better'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          goal: 'feel_better',
                        }))
                      }
                    />
                    Feel better &amp; have more energy
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="goal"
                      value="weight"
                      checked={healthySurvey.goal === 'weight'}
                      onChange={() =>
                        setHealthySurvey((p) => ({ ...p, goal: 'weight' }))
                      }
                    />
                    Weight &amp; body composition
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="goal"
                      value="metabolic"
                      checked={healthySurvey.goal === 'metabolic'}
                      onChange={() =>
                        setHealthySurvey((p) => ({ ...p, goal: 'metabolic' }))
                      }
                    />
                    Metabolic health (blood sugar, cholesterol, etc.)
                  </label>
                </div>
              </div>

              {/* Q2 */}
              <div className="mb-4">
                <div className="text-sm font-medium mb-1 text-gray-900 dark:text-gray-100">
                  2. How do you prefer to get your protein?
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="proteinPreference"
                      value="mixed"
                      checked={healthySurvey.proteinPreference === 'mixed'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          proteinPreference: 'mixed',
                        }))
                      }
                    />
                    Mix of lean animal and plant proteins
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="proteinPreference"
                      value="lean_animal"
                      checked={healthySurvey.proteinPreference === 'lean_animal'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          proteinPreference: 'lean_animal',
                        }))
                      }
                    />
                    Mostly lean animal proteins (fish, chicken, eggs, yogurt)
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="proteinPreference"
                      value="plant_forward"
                      checked={healthySurvey.proteinPreference === 'plant_forward'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          proteinPreference: 'plant_forward',
                        }))
                      }
                    />
                    Mostly plant-based (beans, lentils, tofu, tempeh)
                  </label>
                </div>
              </div>

              {/* Q3 */}
              <div className="mb-4">
                <div className="text-sm font-medium mb-1 text-gray-900 dark:text-gray-100">
                  3. What&apos;s your comfort level with carbs?
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="carbBias"
                      value="more_whole_grains"
                      checked={healthySurvey.carbBias === 'more_whole_grains'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          carbBias: 'more_whole_grains',
                        }))
                      }
                    />
                    I&apos;m happy with carbs, just prefer whole grains over white
                    versions.
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="carbBias"
                      value="lower_carb"
                      checked={healthySurvey.carbBias === 'lower_carb'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          carbBias: 'lower_carb',
                        }))
                      }
                    />
                    I&apos;d like dinners to be a bit lower in starch / refined carbs.
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="carbBias"
                      value="no_preference"
                      checked={healthySurvey.carbBias === 'no_preference'}
                      onChange={() =>
                        setHealthySurvey((p) => ({
                          ...p,
                          carbBias: 'no_preference',
                        }))
                      }
                    />
                    No strong preference.
                  </label>
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-3">
                <button
                  type="button"
                  className="text-sm text-gray-600 dark:text-gray-300 hover:underline"
                  onClick={() => setShowHealthySurvey(false)}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="rounded px-4 py-2 bg-black text-white hover:opacity-90 dark:bg-white dark:text-black text-sm"
                  onClick={() => {
                    persistHealthySurvey(healthySurvey);
                    setShowHealthySurvey(false);
                  }}
                >
                  Save preferences
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}