// src/app/pantry/page.tsx
'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { getDevUserId } from '@/lib/user';

import BarcodeScanner from '@/components/BarcodeScanner';
import { ocrDetectSingle, upcLookup, type DetectedItem } from '@/lib/helpers';
import { properCaseName } from '@/lib/normalize';
import { normalizeIngredientName } from '@/lib/shopping';

// Normalize a pantry item name for duplicate detection
// Keep this aligned with shopping list merging behavior.
function normalizeNameForKey(name: string): string {
  const s = (name || '')
    .toLowerCase()
    // Strip common brand / marketing noise that differs across sources
    .replace(/\b(trader joe'?s|kirkland|costco|o organics|organic)\b/g, '')
    // Collapse non-alphanumerics to spaces
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  // Reuse shopping normalizer so pantry matches shopping list keys
  return normalizeIngredientName(s);
}

type PantryItem = {
  id: string;
  name: string;
  qty: number;
  unit: string;
  use_soon: boolean;
  perish_by: string | null;
};

// Helper: get today's date as YYYY-MM-DD (ISO)
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Freshness UI (Option A): single column driven by use_soon + perish_by
function formatDateShort(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  // e.g. Feb 6
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getFreshnessBadge(item: { use_soon: boolean; perish_by: string | null }): {
  label: string;
  detail?: string;
  tone: 'neutral' | 'green' | 'amber' | 'red';
} {
  const hasDate = !!item.perish_by;

  // Rules (single source of truth):
  // - Red: expired OR perish_by within 3 days
  // - Amber: user-marked "Use soon" OR perish_by within 7 days
  // - Green: dated item with perish_by > 7 days
  // - Neutral: no date and not marked

  if (hasDate) {
    const ts = Date.parse(item.perish_by as string);
    if (!Number.isNaN(ts)) {
      const days = Math.ceil((ts - Date.now()) / (1000 * 60 * 60 * 24));
      const dateLabel = formatDateShort(item.perish_by as string);

      // Past date (already expired)
      if (days < 0) {
        return { label: 'Expired', detail: dateLabel, tone: 'red' };
      }

      // Truly urgent by date
      if (days <= 3) {
        return { label: 'Use soon', detail: dateLabel, tone: 'red' };
      }

      // User intent: they want to use it soon, but it's not date-urgent
      if (item.use_soon) {
        return { label: 'Use soon', detail: dateLabel, tone: 'amber' };
      }

      // Date is coming up, but not urgent
      if (days <= 7) {
        return { label: 'Use soon', detail: dateLabel, tone: 'amber' };
      }

      // Plenty of runway
      return { label: 'Fresh', detail: dateLabel, tone: 'green' };
    }
  }

  // No valid date
  if (item.use_soon) return { label: 'Use soon', tone: 'amber' };
  return { label: '—', tone: 'neutral' };
}

/** Common, readable units for pantry rows (single source of truth) */
const UNIT_OPTIONS = [
  'unit',
  'can',
  'bottle',
  'carton',
  'block',
  'bunch',
  'clove',
  'head',

  'oz',
  'lb',
  'g',
  'ml',

  'cup',
  'tbsp',
  'tsp',
] as const;


type UnitOption = (typeof UNIT_OPTIONS)[number];

function coerceUnitOption(v: unknown): UnitOption {
  if (typeof v === 'string' && (UNIT_OPTIONS as readonly string[]).includes(v)) {
    return v as UnitOption;
  }
  return 'unit';
}

// --- Soft-mode unit recommendations (reduce errors, still allow "More") ---
const UNIT_SETS: Record<
  'protein' | 'produce' | 'dairy' | 'grains' | 'legumes' | 'spices' | 'condiments' | 'other',
  UnitOption[]
> = {
  protein: ['lb', 'oz', 'unit'],
  produce: ['unit', 'lb', 'oz', 'bunch', 'head', 'clove'],
  dairy: ['oz', 'lb', 'unit', 'block', 'carton'],
  grains: ['lb', 'oz', 'cup', 'unit'],
  legumes: ['can', 'lb', 'oz', 'cup', 'unit'],
  spices: ['tsp', 'tbsp', 'oz', 'unit'],
  condiments: ['oz', 'bottle', 'unit'],
  other: ['unit', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'g', 'ml'],
};

function inferUnitBucketFromName(nameRaw: string): keyof typeof UNIT_SETS {
  const n = normalizeNameForKey(nameRaw || '');
  if (!n) return 'other';

  if (/(^|\s)(beef|turkey|chicken|pork|lamb|veal|shrimp|fish|salmon|tuna|cod|tilapia)(\s|$)/.test(n)) return 'protein';

  if (/(^|\s)(lettuce|spinach|kale|arugula|broccoli|cauliflower|zucchini|cucumber|pepper|carrot|onion|garlic|potato|tomato|lemon|lime|cilantro|parsley|dill|basil|mint)(\s|$)/.test(n))
    return 'produce';

  if (/(^|\s)(milk|yogurt|cheese|feta|parmesan|butter|cream|sour cream)(\s|$)/.test(n)) return 'dairy';

  if (/(^|\s)(rice|quinoa|pasta|noodles?|flour|oats?|couscous|bulgur|bread|tortilla)(\s|$)/.test(n)) return 'grains';

  if (/(^|\s)(bean|beans|chickpea|chickpeas|garbanzo|lentil|lentils|peas)(\s|$)/.test(n)) return 'legumes';

  if (/(^|\s)(cumin|paprika|oregano|thyme|rosemary|cinnamon|turmeric|chili|pepper|salt)(\s|$)/.test(n)) return 'spices';

  if (/(^|\s)(soy sauce|tamari|vinegar|oil|hot sauce|sriracha|mustard|ketchup|mayo)(\s|$)/.test(n)) return 'condiments';

  return 'other';
}

function recommendedUnitsForName(nameRaw: string): UnitOption[] {
  const bucket = inferUnitBucketFromName(nameRaw);
  return UNIT_SETS[bucket] ?? UNIT_SETS.other;
}

// Used for Manual/Upload/Barcode flows to pick a sane starting unit/qty.
// Non-destructive: call sites should only apply when the user hasn't already chosen.
function inferDefaultUnitQtyForName(nameRaw: string): { unit: UnitOption; qty: number } {
  const n = normalizeNameForKey(nameRaw || '');

  // Grains / pantry bags
  if (/(^|\s)(pasta|spaghetti|penne|rigatoni|farfalle|fusilli|noodles?|rice|quinoa|bulgur|couscous|flour|oats?)(\s|$)/.test(n)) {
    return { unit: 'oz', qty: 16 };
  }

  // Canned goods
  if (/(^|\s)(bean|beans|chickpea|chickpeas|garbanzo|corn|peas|tomato|tomatoes|tuna|salmon|soup|broth)(\s|$)/.test(n)) {
    return { unit: 'can', qty: 1 };
  }

  // Dairy liquids / tubs
  if (/(^|\s)(milk|almond milk|oat milk|soy milk|yogurt|greek yogurt|cream|half and half)(\s|$)/.test(n)) {
    return { unit: 'carton', qty: 1 };
  }

  // Cheese / tofu / butter
  if (/(^|\s)(cheese|cheddar|mozzarella|parmesan|feta|goat cheese|tofu|butter)(\s|$)/.test(n)) {
    return { unit: 'block', qty: 1 };
  }

  // Bottled condiments & oils
  if (/(^|\s)(olive oil|oil|vinegar|soy sauce|tamari|ketchup|mustard|mayo|hot sauce|sriracha|dressing)(\s|$)/.test(n)) {
    return { unit: 'bottle', qty: 1 };
  }

  // Eggs
  if (/(^|\s)(egg|eggs)(\s|$)/.test(n)) {
    return { unit: 'unit', qty: 12 };
  }

  // Bread / tortillas
  if (/(^|\s)(bread|loaf|bagel|bun|tortilla|wrap)(\s|$)/.test(n)) {
    return { unit: 'unit', qty: 1 };
  }

  // Herbs
  if (/(^|\s)(cilantro|parsley|dill|basil|mint)(\s|$)/.test(n)) {
    return { unit: 'bunch', qty: 1 };
  }

  // Garlic
  if (n === 'garlic') {
    return { unit: 'clove', qty: 3 };
  }

  // Proteins
  if (/(^|\s)(beef|turkey|chicken|pork|lamb|veal|shrimp|fish|salmon|tuna|cod|tilapia)(\s|$)/.test(n)) {
    return { unit: 'lb', qty: 1 };
  }

  return { unit: 'unit', qty: 1 };
}

function sanitizeBarcodeDetectedQtyUnit(
  nameRaw: string,
  qty: number | undefined,
  unit: string | undefined,
): { qty: number; unit: UnitOption } {
  const fallback = inferDefaultUnitQtyForName(nameRaw);
  const normalizedUnit = coerceUnitOption(unit);
  const numericQty = Number(qty);
  const hasValidQty = Number.isFinite(numericQty) && numericQty > 0;

  // If UPC metadata does not provide a usable qty, fall back immediately.
  if (!hasValidQty) {
    return fallback;
  }

  const n = normalizeNameForKey(nameRaw || '');

  // UPC providers sometimes return serving-size style metadata (for example 4.6 oz)
  // instead of package/container count. For pantry staples, prefer the package default.
  const looksCannedStaple =
    /(^|\s)(bean|beans|kidney bean|kidney beans|black bean|black beans|pinto bean|pinto beans|cannellini bean|cannellini beans|chickpea|chickpeas|garbanzo|corn|peas|tomato|tomatoes|tuna|salmon|soup|broth)(\s|$)/.test(
      n,
    );

  const looksDryPantryStaple =
    /(^|\s)(pasta|spaghetti|penne|rigatoni|farfalle|fusilli|noodles?|rice|quinoa|bulgur|couscous|flour|oats?)(\s|$)/.test(
      n,
    );

  const looksFreshProtein =
    /(^|\s)(ground beef|ground turkey|ground chicken|ground pork|ground lamb|beef|turkey|chicken|pork|lamb|veal|shrimp|fish|salmon|tuna|cod|tilapia)(\s|$)/.test(
      n,
    );

      const looksDairyStaple =
    /(^|\s)(milk|almond milk|oat milk|soy milk|yogurt|greek yogurt|cream|half and half)(\s|$)/.test(
      n,
    );

  const looksBlockStaple =
    /(^|\s)(cheese|cheddar|mozzarella|parmesan|feta|goat cheese|tofu|butter)(\s|$)/.test(
      n,
    );

  const looksBottleStaple =
    /(^|\s)(olive oil|oil|vinegar|soy sauce|tamari|ketchup|mustard|mayo|hot sauce|sriracha|dressing)(\s|$)/.test(
      n,
    );

  const looksEggStaple = /(^|\s)(egg|eggs)(\s|$)/.test(n);

  const looksBreadStaple = /(^|\s)(bread|loaf|bagel|bun|tortilla|wrap)(\s|$)/.test(n);

  const looksServingSizeLike =
    (normalizedUnit === 'oz' && numericQty > 0 && numericQty <= 8) ||
    (normalizedUnit === 'g' && numericQty > 0 && numericQty <= 150) ||
    (normalizedUnit === 'cup' && numericQty > 0 && numericQty <= 1.5) ||
    (normalizedUnit === 'tbsp' && numericQty > 0 && numericQty <= 8) ||
    (normalizedUnit === 'tsp' && numericQty > 0 && numericQty <= 24);

  // If UPC metadata comes back as a generic "unit" for things we know have a
  // better pantry default (for example tomato sauce cans or fresh proteins),
  // prefer the inferred fallback.
    const looksTooGenericForItem =
    normalizedUnit === 'unit' &&
    fallback.unit !== 'unit' &&
    (
      looksCannedStaple ||
      looksDryPantryStaple ||
      looksFreshProtein ||
      looksDairyStaple ||
      looksBlockStaple ||
      looksBottleStaple ||
      looksEggStaple ||
      looksBreadStaple
    );

  if (looksTooGenericForItem) {
    return fallback;
  }

  if ((looksCannedStaple || looksDryPantryStaple) && looksServingSizeLike) {
    return fallback;
  }

  return { qty: numericQty, unit: normalizedUnit };
}

function UnitSelectSoftMode(props: {
  value: string;
  onChange: (v: string) => void;
  nameForSuggestion: string;
  className?: string;
}) {
  const { value, onChange, nameForSuggestion, className } = props;
  const recommended = recommendedUnitsForName(nameForSuggestion);
  const all = UNIT_OPTIONS as readonly string[];

  // Sentinel values used as menu actions (never persisted as the unit value)
  const MORE_SENTINEL = '__more_units__';
  const LESS_SENTINEL = '__less_units__';

  const recommendedSet = new Set<string>(recommended as readonly string[]);
  const allSet = new Set<string>(all);
  const recommendedEqualsAll =
    recommendedSet.size === allSet.size &&
    Array.from(recommendedSet).every((u) => allSet.has(u));

  const [showAll, setShowAll] = React.useState(false);
  const baseOptions = showAll ? all : (recommended as readonly string[]);

  // Ensure current value stays visible even if user previously picked something outside the recommended set
  const withValue = baseOptions.includes(value)
    ? baseOptions
    : Array.from(new Set([value, ...baseOptions]));

  // Add “More…” / “Less…” as an action INSIDE the menu only when it’s meaningful.
  const actionOption = recommendedEqualsAll ? null : showAll ? LESS_SENTINEL : MORE_SENTINEL;
  const options = actionOption ? [...withValue, actionOption] : withValue;

  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;

    const onDown: EventListener = (e) => {
      const el = rootRef.current;
      if (!el) return;
      const t = e.target;
      if (t instanceof Node && !el.contains(t)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const displayValue = value || 'unit';

  const handlePick = (v: string) => {
    if (v === MORE_SENTINEL || v === LESS_SENTINEL) {
      // Keep this state local so toggling More/Less does not rerender parent containers
      // like BarcodeCapture (which includes the live scanner).
      setShowAll((prev) => !prev);
      return;
    }
    onChange(v);
    setOpen(false);
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen((o) => !o);
    }
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        className={className}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate">{displayValue}</span>
          <span aria-hidden className="opacity-60">▾</span>
        </span>
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 min-w-full rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 shadow-lg"
          role="listbox"
          aria-label="Units"
        >
          <ul className="max-h-64 overflow-auto py-1">
            {options.map((u) => {
              const isAction = u === MORE_SENTINEL || u === LESS_SENTINEL;
              const label =
                u === MORE_SENTINEL ? 'More…' : u === LESS_SENTINEL ? 'Less…' : u;
              const selected = !isAction && u === value;

              return (
                <li key={u}>
                  <button
                    type="button"
                    className={
                      'w-full px-3 py-2 text-left text-sm flex items-center gap-2 ' +
                      (selected
                        ? 'bg-black/5 dark:bg-white/10'
                        : 'hover:bg-black/5 dark:hover:bg-white/10')
                    }
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handlePick(u)}
                  >
                    <span className="w-4">{selected ? '✓' : ''}</span>
                    <span className={isAction ? 'opacity-80' : ''}>{label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Resolve current user id (shared helper) */
async function resolveUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? getDevUserId();
}

export default function PantryPage() {
  const { checking } = useRequireAuth();

  const [items, setItems] = useState<PantryItem[]>([]);
  const [form, setForm] = useState({
    name: '',
    qty: 1,
    unit: 'unit',
    use_soon: false,
    perish_by: '',
    perish_by_dirty: false,
  });
  // Soft-mode unit UX for Manual add (non-destructive suggestion)
  const [formUnitDirty, setFormUnitDirty] = useState(false);
  const [loading, setLoading] = useState(true);

  // tabs
  const [tab, setTab] = useState<'manual' | 'upload' | 'barcode'>('manual');

  // inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    name: string;
    qty: number;
    unit: string;
    use_soon: boolean;
    perish_by: string | '';
    perish_by_dirty: boolean;
  }>({
    name: '',
    qty: 1,
    unit: 'unit',
    use_soon: false,
    perish_by: '',
    perish_by_dirty: false,
  });
  const isEditing = (id: string) => editingId === id;

  const load = useCallback(async () => {
  setLoading(true);
  const userId = await resolveUserId();
  const { data, error } = await supabase
    .from('pantry_items')
    .select('id,name,qty,unit,use_soon,perish_by')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (!error) setItems(data || []);
  setLoading(false);
}, []);

    // We only need to load once on mount; `load` captures everything it needs.
    useEffect(() => {
  void load();
}, [load]);

 // Add-or-merge helper: if a matching row exists (same normalized name + unit),
// increment qty; otherwise insert a new row.
const upsertPantryItem = useCallback(
  async (input: {
    name: string;
    qty?: number;
    unit?: string;
    use_soon?: boolean;
    perish_by?: string | null;
  }) => {
    const userId = await resolveUserId();
    const nameTrim = input.name.trim();
    if (!nameTrim) return;

    const qty = Number(input.qty ?? 1) || 1;
    const unit = input.unit ?? 'unit';
    const use_soon = !!input.use_soon;
    const perish_by = input.perish_by ?? null;

    const key = normalizeNameForKey(nameTrim);

    // Fetch possible matches for this user+unit, then match by normalized name in JS.
    const { data, error: selErr } = await supabase
      .from('pantry_items')
      .select('id,name,qty,unit,use_soon')
      .eq('user_id', userId)
      .eq('unit', unit);

    if (selErr) {
      console.error(selErr);
      alert('Failed to read existing items.');
      return;
    }

    const existing = (data ?? []).find(
      (row) => normalizeNameForKey(row.name) === key
    );

    if (existing) {
      const newQty = (existing.qty ?? 0) + qty;
      const nextUseSoon = (existing as { use_soon?: boolean }).use_soon || use_soon;

      const { error } = await supabase
        .from('pantry_items')
        .update({ qty: newQty, use_soon: nextUseSoon })
        .eq('id', existing.id)
        .eq('user_id', userId);

      if (error) {
        console.error(error);
        alert('Failed to update existing item.');
        return;
      }

      // Optimistic local update
      setItems((prev) =>
        prev.map((i) => (i.id === existing.id ? { ...i, qty: newQty, use_soon: nextUseSoon } : i))
      );
    } else {
      const payload = {
        user_id: userId,
        name: nameTrim.toLowerCase(),
        qty,
        unit,
        use_soon,
        perish_by,
      };

      const { error } = await supabase.from('pantry_items').insert(payload);
      if (error) {
        console.error(error);
        alert('Failed to add item.');
        return;
      }

      // We'll let the caller decide when to call load() to refresh from DB.
    }
  },
  [] // <-- IMPORTANT: no `items` here
);

    async function add() {
    if (!form.name.trim()) return;

    await upsertPantryItem({
      name: form.name,
      qty: form.qty,
      unit: form.unit,
      use_soon: form.use_soon,
      perish_by: form.perish_by_dirty ? (form.perish_by || null) : null,
    });

    // Reset form + refresh from DB so everything is consistent
    setForm({
      name: '',
      qty: 1,
      unit: 'unit',
      use_soon: false,
      perish_by: '',
      perish_by_dirty: false,
    });
    setFormUnitDirty(false);
    await load();
  }

    const handleBarcodeCommit = useCallback(
    async (item: { name: string; qty?: number; unit?: string }) => {
      const rawName = item.name ?? '';
      const niceName = properCaseName(rawName);

      await upsertPantryItem({
        name: niceName,
        qty: item.qty ?? 1,
        unit: item.unit ?? 'unit',
        use_soon: false,
        perish_by: null,
      });

      await load();
    },
    [upsertPantryItem, load]
  );

  async function remove(id: string) {
    const userId = await resolveUserId();
    const { error } = await supabase
      .from('pantry_items')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (!error) {
      setItems((prev) => prev.filter((i) => i.id !== id));
      if (editingId === id) setEditingId(null);
    } else {
      console.error(error);
      alert('Failed to delete item.');
    }
  }

  function beginEdit(row: PantryItem) {
    setEditingId(row.id);
    setDraft({
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      use_soon: !!row.use_soon,
      perish_by: row.perish_by ?? '',
      perish_by_dirty: false,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft({
      name: '',
      qty: 1,
      unit: 'unit',
      use_soon: false,
      perish_by: '',
      perish_by_dirty: false,
    });
  }

  async function saveEdit(id: string) {
    const userId = await resolveUserId();
    const payload = {
      name: draft.name.trim(),
      qty: Number(draft.qty) || 1,
      unit: draft.unit,
      use_soon: !!draft.use_soon,
      // IMPORTANT: show today's date as a UI hint, but do NOT save it unless user actually picked a date.
      perish_by: draft.perish_by_dirty ? (draft.perish_by || null) : (draft.perish_by || null),
    };
    const { error } = await supabase
      .from('pantry_items')
      .update(payload)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error(error);
      alert('Failed to save changes.');
      return;
    }

    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...payload } as PantryItem : i)));
    setEditingId(null);
  }

  function onDraftKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      if (editingId) void saveEdit(editingId);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  }

  if (checking) return <div className="p-6 text-sm text-gray-500">Loading...</div>;

  return (
    <div className="max-w-3xl md:max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100" data-build="pantry-tabs-v1">Pantry</h1>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm">
        {/* Tabs */}
        <div className="mb-4 border-b border-gray-200 dark:border-gray-800">
          <nav className="-mb-px flex gap-4">
            {(['manual','upload','barcode'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={[
                  'px-3 py-2 text-sm',
                  tab === t ? 'border-b-2 border-black dark:border-white font-medium' : 'text-gray-500'
                ].join(' ')}
              >
                {t === 'manual' ? 'Manual' : t === 'upload' ? 'Upload Photos' : 'Scan Barcode'}
              </button>
            ))}
          </nav>
        </div>

        {/* MANUAL */}
        {tab === 'manual' && (
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              className="rounded border px-3 py-2 flex-1 min-w-[12rem]
                         border-gray-300 dark:border-gray-700
                         bg-white dark:bg-neutral-900
                         text-gray-900 dark:text-gray-100
                         placeholder:text-gray-400 dark:placeholder:text-gray-500"
              placeholder="e.g., chicken breast"
              value={form.name}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => {
                  if (formUnitDirty) return { ...f, name: v };
                  const d = inferDefaultUnitQtyForName(v);
                  return { ...f, name: v, unit: d.unit };
                });
              }}
            />
            <input
              className="rounded border px-3 py-2 w-24
                         border-gray-300 dark:border-gray-700
                         bg-white dark:bg-neutral-900
                         text-gray-900 dark:text-gray-100"
              type="number"
              value={form.qty}
              onChange={(e) => setForm((f) => ({ ...f, qty: Number(e.target.value) }))}
            />
            <UnitSelectSoftMode
              value={form.unit}
              nameForSuggestion={form.name}
              onChange={(v) => {
                setFormUnitDirty(true);
                setForm((f) => ({ ...f, unit: v }));
              }}
              className="rounded border px-3 py-2 w-28 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100"
            />
            <label className="inline-flex items-center gap-2 rounded border px-3 py-2
                    border-gray-300 dark:border-gray-700
                    bg-white dark:bg-neutral-900
                    text-gray-900 dark:text-gray-100">
              <input
                type="checkbox"
                checked={form.use_soon}
                onChange={(e) => setForm((f) => ({ ...f, use_soon: e.target.checked }))}
              />
              <span className="text-sm">Use soon</span>
            </label>

            <input
              className={
                "rounded border px-3 py-2 w-44 " +
                "border-gray-300 dark:border-gray-700 " +
                "bg-white dark:bg-neutral-900 " +
                (!form.perish_by_dirty && !form.perish_by
                  ? "text-gray-400 dark:text-gray-500"
                  : "text-gray-900 dark:text-gray-100")
              }
              type="date"
              value={form.perish_by || todayIsoDate()}
              onChange={(e) => {
              const v = e.target.value; // '' when cleared
             setForm((f) => ({
             ...f,
             perish_by: v,
             perish_by_dirty: !!v,
             }));
             }}
              aria-label="Perish by (optional)"
            />
            <button
              onClick={add}
              className="rounded px-4 py-2 bg-black text-white hover:opacity-90
                         dark:bg-white dark:text-black"
            >
              Add
            </button>
          </div>
        )}

        {/* UPLOAD */}
                {tab === 'upload' && (
          <UploadPhoto
            onConfirm={async (rows) => {
              if (!rows.length) return;

              // Sequentially upsert each detected row
for (const r of rows) {
  const rawName = r.name ?? '';
  const niceName = properCaseName(rawName);

  await upsertPantryItem({
    name: niceName,
    qty: r.qty ?? 1,
    unit: r.unit ?? 'unit',
    use_soon: false,
    perish_by: null,
  });
}

              await load();
            }}
          />
        )}

        {/* BARCODE */}
        {tab === 'barcode' && (
  <MemoBarcodeCapture onCommit={handleBarcodeCommit} />
)}
        {/* TABLE (using colgroup to rebalance widths) */}
        {loading ? (
          <p className="text-gray-600 dark:text-gray-400">Loading…</p>
        ) : (
          <div
            className={
             'overflow-x-auto ' +
             (tab === 'barcode' ? 'max-h-[60vh] overflow-y-auto' : '')
             }
            >
            <table className="w-full text-sm border border-gray-200 dark:border-gray-800">
              <colgroup>
                <col className="w-[52%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[18%]" />
                <col className="w-[10%]" />
              </colgroup>

              <thead className="bg-gray-50 dark:bg-neutral-900">
                <tr>
                  <th className="text-left p-2">Item</th>
                  <th className="text-left p-2">Qty</th>
                  <th className="text-left p-2">Unit</th>
                  <th className="text-left p-2">Freshness</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>

              <tbody>
                {items.map((i) => {
                  const editing = isEditing(i.id);
                  return (
                    <tr key={i.id} className="border-t border-gray-200 dark:border-gray-800 align-top">
                      {/* Item */}
                      <td className="p-2">
                        {editing ? (
                          <input
                            className="border rounded px-2 py-1 w-full"
                            value={draft.name}
                            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                            onKeyDown={onDraftKeyDown}
                            autoFocus
                          />
                        ) : (
                          <div className="truncate">{properCaseName(i.name)}</div>
                        )}
                      </td>
                      {/* Qty */}
                      <td className="p-2">
                        {editing ? (
                          <input
                            type="number"
                            className="border rounded px-2 py-1 w-20"
                            value={draft.qty}
                            onChange={(e) => setDraft((d) => ({ ...d, qty: Number(e.target.value) }))}
                            onKeyDown={onDraftKeyDown}
                          />
                        ) : (
                          i.qty
                        )}
                      </td>
                      {/* Unit */}
                      <td className="p-2">
                        {editing ? (
                          <select
                            className="border rounded px-2 py-1 w-24"
                            value={draft.unit}
                            onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
                            onKeyDown={onDraftKeyDown}
                          >
                            {UNIT_OPTIONS.map(u => (
                              <option key={u} value={u}>{u}</option>
                            ))}
                          </select>
                        ) : (
                          i.unit
                        )}
                      </td>
                      {/* Freshness (Option A: single column) */}
                      <td className="p-2">
                        {editing ? (
                          <div className="space-y-2">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={draft.use_soon}
                                onChange={(e) =>
                                  setDraft((d) => ({ ...d, use_soon: e.target.checked }))
                                }
                                onKeyDown={onDraftKeyDown}
                              />
                              <span className="text-xs opacity-70">Use soon</span>
                            </label>

                            <div className="flex flex-col gap-1">
                              <span className="text-xs text-gray-500 dark:text-gray-400">Perish by (optional)</span>
                              <input
                                type="date"
                                className={
                                  "border rounded px-2 py-1 w-44 " +
                                  (!draft.perish_by_dirty && !draft.perish_by
                                    ? "text-gray-400 dark:text-gray-500"
                                    : "text-gray-900 dark:text-gray-100")
                                }
                                value={draft.perish_by || todayIsoDate()}
                                onChange={(e) => {
                                const v = e.target.value; // '' when cleared
                                setDraft((d) => ({
                                ...d,
                                perish_by: v,
                                perish_by_dirty: !!v,
                                }));
                               }}
                                onKeyDown={onDraftKeyDown}
                              />
                            </div>
                          </div>
                        ) : (() => {
                          const b = getFreshnessBadge({
                            use_soon: !!i.use_soon,
                            perish_by: i.perish_by,
                          });

                          if (b.tone === 'neutral') {
                            return <span className="text-xs text-gray-400">—</span>;
                          }

                          const cls =
                            b.tone === 'red'
                              ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
                              : b.tone === 'amber'
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';

                          return (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${cls}`}>
                                {b.label}
                              </span>
                              {b.detail ? (
                                <span className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                                  {b.detail}
                                </span>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      {/* Actions */}
                      <td className="p-2">
                        <div className="flex justify-end items-center gap-3 whitespace-nowrap">
                          {editing ? (
                            <>
                              <button
                                onClick={() => saveEdit(i.id)}
                                className="text-green-700 dark:text-green-400 hover:underline"
                                aria-label="Save changes"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="text-gray-600 dark:text-gray-400 hover:underline"
                                aria-label="Cancel editing"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => remove(i.id)}
                                className="text-red-600 dark:text-red-400 hover:underline"
                                aria-label="Delete item"
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => beginEdit(i)}
                                className="text-blue-700 dark:text-blue-400 hover:underline"
                                aria-label="Edit item"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => remove(i.id)}
                                className="text-red-600 dark:text-red-400 hover:underline"
                                aria-label="Delete item"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {items.length === 0 && (
                  <tr>
                    <td className="p-3 text-gray-500 dark:text-gray-400" colSpan={5}>
                      No items yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- Inline helpers (UI) ----------------------- */

function UploadPhoto({ onConfirm }: { onConfirm: (rows: { name: string; qty: number; unit: string }[]) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [rows, setRows] = useState<DetectedItem[] | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    setPending(true);
    try {
      const items = await ocrDetectSingle(file);
      console.log('[UploadPhoto] items from OCR:', items);

      const dedup = Array.from(
        new Map(items.map((i) => [i.name, i])).values()
      ).slice(0, 10);

      setRows(
        dedup.map((it) => {
          const detectedQtyUnit = sanitizeBarcodeDetectedQtyUnit(
            it.name || '',
            it.qty,
            it.unit,
          );
          return {
            ...it,
            qty: detectedQtyUnit.qty,
            unit: detectedQtyUnit.unit,
          };
        })
      );
    } catch (e) {
      console.error(e);
      alert(`OCR failed: ${String(e)}`);
    } finally {
      setPending(false);
    }
  }

  async function onChoosePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    await handleFile(f);
    e.target.value = '';
  }

  if (rows) {
    return (
      <div className="space-y-3 mb-4">
        <div className="text-sm text-gray-600 dark:text-gray-400">Confirm detected items</div>
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {rows.map((r, i) => (
            <li key={i} className="py-2 flex items-center gap-2">
              <input
                className="border rounded px-2 py-1 w-56"
                value={r.name}
                onChange={e => setRows(rs => rs!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                type="number"
                className="border rounded px-2 py-1 w-20"
                value={r.qty ?? 1}
                onChange={e => setRows(rs => rs!.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))}
              />
              <UnitSelectSoftMode
                value={(r.unit ?? 'unit') as string}
                nameForSuggestion={r.name}
                onChange={(v) =>
                  setRows((rs) =>
                    rs!.map((x, j) => (j === i ? { ...x, unit: v } : x))
                  )
                }
                className="border rounded px-2 py-1 w-24 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100"
              />
              <span className="text-xs opacity-60">
                {r.confidence ? `~${Math.round((r.confidence || 0) * 100)}%` : ''}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex gap-3">
          <button
            onClick={async () => {
              await onConfirm(
                rows.map((r) => ({
                  name: r.name,
                  qty: r.qty ?? 1,
                  unit: r.unit ?? 'unit',
                }))
              );
              // Clear the detected list once items are added
              setRows(null);
            }}
            className="rounded px-4 py-2 bg-black text-white dark:bg-white dark:text-black"
          >
            Add {rows.length} item(s)
          </button>
          <button onClick={() => setRows(null)} className="text-sm underline">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onChoosePhotoChange}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="rounded px-4 py-2 border border-gray-300 dark:border-gray-700"
      >
        Choose photo
      </button>
      {pending && <span className="text-sm opacity-70">Processing…</span>}
    </div>
  );
}

function BarcodeCapture({ onCommit }: { onCommit: (item: { name: string; qty?: number; unit?: string }) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<DetectedItem | null>(null);

  return (
    <div className="space-y-3 mb-4">
      <BarcodeScanner
        onDetected={async (code: string) => {
          if (pending) return;
          setPending(true);
          try {
            const item = await upcLookup(code);
            const rawName = item?.name ?? '';

            // Use the same idea as normalizeNameForKey: strip brand / "organic" noise,
            // then pretty-case it for display.
            const base = normalizeNameForKey(rawName); // returns lowercased, noise-stripped
            const cleanedName = base ? properCaseName(base) : rawName;

            const detectedQtyUnit = sanitizeBarcodeDetectedQtyUnit(
              cleanedName,
              item?.qty,
              item?.unit,
            );

            setLast({
              ...item,
              name: cleanedName,
              qty: detectedQtyUnit.qty,
              unit: detectedQtyUnit.unit,
            });
          } catch (e) {
            console.error(e);
            alert(`UPC lookup failed: ${String(e)}`);
          } finally {
            setPending(false);
          }
        }}
      />
      {last && (
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3">
          <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">Detected:</div>
          <div className="flex items-center gap-2">
            <input
              className="border rounded px-2 py-1 w-56"
              value={last.name}
              onChange={e => setLast({ ...last!, name: e.target.value })}
            />
            <input
              type="number"
              className="border rounded px-2 py-1 w-20"
              value={last.qty ?? 1}
              onChange={e => setLast({ ...last!, qty: Number(e.target.value) })}
            />
            <UnitSelectSoftMode
              value={(last.unit ?? 'unit') as string}
              nameForSuggestion={last.name}
              onChange={(v) => setLast({ ...last!, unit: v })}
              className="border rounded px-2 py-1 w-24 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100"
            />
            <button
              onClick={async () => {
                await onCommit({
                  name: last.name,
                  qty: last.qty ?? 1,
                  unit: last.unit ?? 'unit',
                });
                // Clear the detected item once it’s been committed
                setLast(null);
              }}
              className="ml-2 rounded px-3 py-1 bg-black text-white dark:bg-white dark:text-black"
            >
              Add to pantry
            </button>
          </div>
        </div>
      )}
      {pending && <span className="text-sm opacity-70">Scanning…</span>}
    </div>
  );
}
const MemoBarcodeCapture = React.memo(BarcodeCapture);