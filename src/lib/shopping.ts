// src/lib/shopping.ts

import { autoCategoryFromName, type PantryCategory } from '@/lib/pantryCategorizer';

export type RawNeed = {
  name: string;
  qty: number | null;
  unit: string | null;
};

export type ShoppingItem = {
  name: string;   // normalized name (lowercase, singular-ish)
  qty: number;    // merged quantity
  unit: string;   // normalized unit
  category?: PantryCategory; // auto-categorized store section
};

/** ---------- Name normalization ---------- */

export function normalizeIngredientName(raw: string): string {
  let s = (raw || '').toLowerCase().trim();

  // Drop stuff in parentheses and after commas: "onion, chopped" → "onion"
  s = s.replace(/\(.*?\)/g, '');
  s = s.replace(/,.*$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();

  if (!s) return s;

  // Words that should NOT have the trailing "s" stripped
  const NO_PLURAL_TRIM = new Set([
    'couscous',
    'spinach',
    'lettuce',
    'rice',
    'pasta',
    'cheese',
    'milk',
    'yogurt',
    'bread',
  ]);

  if (NO_PLURAL_TRIM.has(s)) {
    return s;
  }

  // Very light plural handling
  if (s.endsWith('ies')) {
    // berries → berry
    s = s.slice(0, -3) + 'y';
  } else if (s.endsWith('es')) {
    // tomatoes → tomato, potatoes → potato (but avoid "couscous" due to NO_PLURAL_TRIM above)
    const stem = s.slice(0, -2);
    // avoid chopping off very short stems
    if (stem.length > 2) {
      s = stem;
    }
  } else if (s.endsWith('s') && s.length > 3) {
    // eggs → egg, carrots → carrot (but avoid words ending with "ss"/"us")
    if (!s.endsWith('ss') && !s.endsWith('us')) {
      s = s.slice(0, -1);
    }
  }

  return s.trim();
}

/** ---------- Unit normalization & groups ---------- */

const UNIT_ALIASES: Record<string, string> = {
  // volume (imperial small)
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  't.': 'tsp',
  tbsp: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  'tbs': 'tbsp',
  'tbsp.': 'tbsp',
  cup: 'cup',
  cups: 'cup',

  // mass (metric)
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',

  // volume (metric)
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',

  // common pantry units
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  can: 'can',
  cans: 'can',
};

type UnitGroup = 'vol_small' | 'mass_g' | 'vol_ml' | 'count' | 'mass_lb' | 'other';

function normalizeUnit(raw: string | null): string {
  const s = (raw || '').toLowerCase().trim();
  if (!s) return 'unit';
  return UNIT_ALIASES[s] || s;
}

function getUnitGroup(unit: string): UnitGroup {
  switch (unit) {
    case 'tsp':
    case 'tbsp':
    case 'cup':
      return 'vol_small';
    case 'g':
    case 'kg':
      return 'mass_g';
    case 'ml':
    case 'l':
      return 'vol_ml';
    case 'lb':
      return 'mass_lb';
    case 'can':
    case 'unit':
      return 'count';
    default:
      return 'other';
  }
}

/** Convert qty to a base unit inside each group */
function toBaseQty(qty: number, unit: string): { group: UnitGroup; base: number; unit: string } {
  const u = normalizeUnit(unit);
  const group = getUnitGroup(u);

  if (!Number.isFinite(qty) || qty <= 0) {
    return { group, base: 1, unit: u || 'unit' };
  }

  switch (group) {
    case 'vol_small': {
      // base = teaspoon
      if (u === 'tsp') return { group, base: qty, unit: 'tsp' };
      if (u === 'tbsp') return { group, base: qty * 3, unit: 'tsp' };   // 1 tbsp = 3 tsp
      if (u === 'cup') return { group, base: qty * 48, unit: 'tsp' };   // 1 cup = 16 tbsp = 48 tsp
      return { group, base: qty, unit: u };
    }
    case 'mass_g': {
      // base = grams
      if (u === 'g') return { group, base: qty, unit: 'g' };
      if (u === 'kg') return { group, base: qty * 1000, unit: 'g' };
      return { group, base: qty, unit: u };
    }
    case 'vol_ml': {
      // base = ml
      if (u === 'ml') return { group, base: qty, unit: 'ml' };
      if (u === 'l') return { group, base: qty * 1000, unit: 'ml' };
      return { group, base: qty, unit: u };
    }
    default:
      return { group, base: qty, unit: u || 'unit' };
  }
}

/** Convert back from base qty to a nice display unit */
function fromBase(group: UnitGroup, base: number): { qty: number; unit: string } {
  if (!Number.isFinite(base) || base <= 0) {
    return { qty: 1, unit: 'unit' };
  }

  switch (group) {
    case 'vol_small': {
      // Prefer cups > tbsp > tsp
      if (base >= 48) {
        const cups = base / 48;
        return { qty: round1(cups), unit: 'cup' };
      }
      if (base >= 3) {
        const tbsp = base / 3;
        return { qty: round1(tbsp), unit: 'tbsp' };
      }
      return { qty: round1(base), unit: 'tsp' };
    }
    case 'mass_g': {
      if (base >= 1000) {
        const kg = base / 1000;
        return { qty: round1(kg), unit: 'kg' };
      }
      return { qty: round1(base), unit: 'g' };
    }
    case 'vol_ml': {
      if (base >= 1000) {
        const l = base / 1000;
        return { qty: round1(l), unit: 'l' };
      }
      return { qty: round1(base), unit: 'ml' };
    }
    case 'mass_lb': {
      return { qty: round1(base), unit: 'lb' };
    }
    case 'count': {
      // 👇 NEW: always round up to whole items for things like onion, lemon, peppers
      const whole = Math.ceil(base);
      return { qty: whole, unit: 'unit' };
    }
    default:
      return { qty: round1(base), unit: 'unit' };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** ---------- Public: merge & normalize ---------- */

export function smartMergeNeeds(needs: RawNeed[]): ShoppingItem[] {
  const agg = new Map<string, { name: string; group: UnitGroup; base: number }>();

  for (const n of needs) {
    const rawName = (n.name || '').trim();
    if (!rawName) continue;

    const name = normalizeIngredientName(rawName);
    const unitNorm = normalizeUnit(n.unit ?? '');
    const qtyNum = Number(n.qty ?? 1) || 1;

    const { group, base } = toBaseQty(qtyNum, unitNorm);

    const key = `${name}|${group}`;
    const cur = agg.get(key);
    if (cur) {
      cur.base += base;
    } else {
      agg.set(key, { name, group, base });
    }
  }

  const out: ShoppingItem[] = [];
   for (const { name, group, base } of agg.values()) {
    const { qty, unit } = fromBase(group, base);
    const category = autoCategoryFromName(name);
    out.push({ name, qty, unit, category });
   }

  // Sort alphabetically by name
  out.sort((a, b) => a.name.localeCompare(b.name));

  return out;
}