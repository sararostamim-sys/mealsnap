// src/lib/shopping.ts

import { autoCategoryFromName, type PantryCategory } from '@/lib/pantryCategorizer';

export type RawNeed = {
  name: string;
  qty: number | null;
  unit: string | null;
};

export type ShoppingItem = {
  name: string; // normalized name (lowercase, singular-ish)
  qty: number; // merged quantity
  unit: string; // normalized unit
  category?: PantryCategory; // auto-categorized store section
};

/** ---------- Helpers: parse "(about 2 oz)" etc in parentheses ---------- */
function parseParenAmount(raw: string): { cleaned: string; qty?: number; unit?: string } {
  const s = (raw || '').trim();
  if (!s) return { cleaned: s };

  // Supports: (about 2 oz), (2 oz), (approx 1.5 lb), (approximately 250 g),
  // AND count-style units: (about 2 can), (about 1 bottle), (about 1 carton)
  const m = s.match(
    /\((?:about|approx\.?|approximately)?\s*([\d.]+)\s*(oz|lb|g|kg|ml|l|can|cans|bottle|bottles|carton|cartons)\s*\)/i,
  );
  if (!m) return { cleaned: s };

  const qty = Number(m[1]);
  const unit = m[2].toLowerCase();
  const cleaned = s.replace(m[0], '').trim();

  if (!Number.isFinite(qty) || qty <= 0) return { cleaned };
  return { cleaned, qty, unit };
}

/** ---------- Name normalization ---------- */
export function normalizeIngredientName(raw: string): string {
  let s = (raw || '').toLowerCase().trim();

  // Drop stuff in parentheses and after commas: "onion, chopped" → "onion"
  s = s.replace(/\(.*?\)/g, '');
  s = s.replace(/,.*$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();

  if (!s) return s;

  // Known plural forms that should NOT use the generic trimming.
  const EXCEPT_PLURALS: Record<string, string> = {
    vegetables: 'vegetable',
    'mixed vegetables': 'mixed vegetable',
    olives: 'olive',
    spices: 'spice',
    herbs: 'herb',
  };

  const mapped = EXCEPT_PLURALS[s];
  if (mapped) return mapped;

  // Words that should NOT have trailing "s" stripped
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

  if (NO_PLURAL_TRIM.has(s)) return s;

  // Very light plural handling (safe version)
  if (s.endsWith('ies')) {
    s = s.slice(0, -3) + 'y';
  } else if (s.endsWith('oes')) {
    s = s.slice(0, -2);
  } else if (s.endsWith('s') && s.length > 3) {
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
  tbs: 'tbsp',
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

  bottle: 'bottle',
  bottles: 'bottle',

  carton: 'carton',
  cartons: 'carton',

  unit: 'unit',

  // shopping-friendly count units
  bunch: 'bunch',
  bunches: 'bunch',
  clove: 'clove',
  cloves: 'clove',
  block: 'block',
  blocks: 'block',
};

type UnitGroup = 'vol_small' | 'mass_g' | 'vol_ml' | 'mass_oz' | 'count' | 'other';

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
    case 'oz':
    case 'lb':
      return 'mass_oz';
    case 'can':
    case 'unit':
    case 'bunch':
    case 'clove':
    case 'block':
    case 'bottle':
    case 'carton':
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
      if (u === 'tsp') return { group, base: qty, unit: 'tsp' };
      if (u === 'tbsp') return { group, base: qty * 3, unit: 'tsp' };
      if (u === 'cup') return { group, base: qty * 48, unit: 'tsp' };
      return { group, base: qty, unit: u };
    }
    case 'mass_g': {
      if (u === 'g') return { group, base: qty, unit: 'g' };
      if (u === 'kg') return { group, base: qty * 1000, unit: 'g' };
      return { group, base: qty, unit: u };
    }
    case 'vol_ml': {
      if (u === 'ml') return { group, base: qty, unit: 'ml' };
      if (u === 'l') return { group, base: qty * 1000, unit: 'ml' };
      return { group, base: qty, unit: u };
    }
    case 'mass_oz': {
      // base = oz
      if (u === 'oz') return { group, base: qty, unit: 'oz' };
      if (u === 'lb') return { group, base: qty * 16, unit: 'oz' };
      return { group, base: qty, unit: u };
    }
    default:
      return { group, base: qty, unit: u || 'unit' };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function roundToHalfLb(lb: number): number {
  return Math.max(0.5, Math.round(lb * 2) / 2);
}

/** Convert back from base qty to a nice display unit */
function fromBase(group: UnitGroup, base: number, preferredUnit?: string): { qty: number; unit: string } {
  if (!Number.isFinite(base) || base <= 0) {
    return { qty: 1, unit: 'unit' };
  }

  switch (group) {
    case 'vol_small': {
      if (base >= 48) return { qty: round1(base / 48), unit: 'cup' };
      if (base >= 3) return { qty: round1(base / 3), unit: 'tbsp' };
      return { qty: round1(base), unit: 'tsp' };
    }
    case 'mass_g': {
      if (base >= 1000) return { qty: round1(base / 1000), unit: 'kg' };
      return { qty: round1(base), unit: 'g' };
    }
    case 'vol_ml': {
      if (base >= 1000) return { qty: round1(base / 1000), unit: 'l' };
      return { qty: round1(base), unit: 'ml' };
    }
    case 'mass_oz': {
      // display oz or lb
      if (base >= 16) return { qty: roundToHalfLb(base / 16), unit: 'lb' };
      return { qty: Math.max(1, Math.ceil(base)), unit: 'oz' };
    }
    case 'count': {
      const whole = Math.ceil(base);
      const u = preferredUnit === 'can' ? 'can' : preferredUnit || 'unit';
      return { qty: whole, unit: u };
    }
    default:
      return { qty: round1(base), unit: preferredUnit || 'unit' };
  }
}

function toShoppingUnit(
  name: string,
  qty: number,
  unit: string,
  category?: PantryCategory,
): { qty: number; unit: string } {
  const n = (name || '').toLowerCase().trim();
  const u = (unit || '').toLowerCase().trim();

  const whole = (x: number) => Math.max(1, Math.ceil(x));
  const r1 = (x: number) => Math.round(x * 10) / 10;

  // IMPORTANT: exclude lentils so we don't split dry lentils into can vs oz lines.
  const CANNED_LEGUME_HINT = /\b(bean|beans|chickpea|garbanzo)\b/;

  const isBroth =
    /\b(broth|stock)\b/.test(n) && !/\b(powder|granules|bouillon)\b/.test(n);

  const isSoyOrTeriyaki =
    /\b(soy sauce|tamari|teriyaki)\b/.test(n);

  const isCoconutMilk = /\bcoconut milk\b/.test(n);

  // Helpers: convert cooking units to “shopping oz” for sauces.
  const cookingToOz = (qty0: number, u0: string): number | null => {
    if (!Number.isFinite(qty0) || qty0 <= 0) return null;
    if (u0 === 'oz') return qty0;
    if (u0 === 'lb') return qty0 * 16;

    // Approx fluid conversion, good enough for “how much to buy”
    if (u0 === 'tsp') return qty0 / 6; // 6 tsp = 1 fl oz
    if (u0 === 'tbsp') return qty0 / 2; // 2 tbsp = 1 fl oz
    if (u0 === 'cup') return qty0 * 8; // 1 cup = 8 fl oz

    // If it's a bare number, we treat it as oz (your existing behavior)
    if (u0 === 'unit') return qty0;

    return null;
  };

  // -----------------------------
  // A) Special cases FIRST (because many arrive as unit="unit")
  // -----------------------------

  // 1) Broth/stock → show cartons (32 oz per carton)
  // Remove "(about 1 lb)" by converting the qty/unit columns.
  if (isBroth) {
    const oz = cookingToOz(qty, u) ?? (u === 'g' ? qty * 0.035274 : null) ?? (u === 'kg' ? qty * 1000 * 0.035274 : null);
    if (oz != null) {
      return { qty: whole(oz / 32), unit: 'carton' };
    }
    if (u === 'carton') return { qty: whole(qty), unit: 'carton' };
    if (u === 'unit') return { qty: whole(qty), unit: 'carton' };
  }

  // 2) Soy / tamari / teriyaki → ALWAYS show oz in columns (no blank unit)
  if (isSoyOrTeriyaki) {
    const oz = cookingToOz(qty, u);
    if (oz != null) {
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: Math.max(1, Math.ceil(oz)), unit: 'oz' };
    }
  }

  // 3) Coconut milk → show oz in columns (assume ~14 oz per can if unit is can)
  if (isCoconutMilk) {
    if (u === 'can') {
      const oz = qty * 14;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
    if (u === 'oz') return { qty: whole(qty), unit: 'oz' };
    if (u === 'lb') return { qty: roundToHalfLb(qty), unit: 'lb' };
    if (u === 'unit') {
      // treat bare number as oz if it's big; otherwise assume 1 can ≈ 14 oz
      if (qty >= 8) return { qty: whole(qty), unit: 'oz' };
      const oz = qty * 14;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
  }

  // 4) Legumes: if unit is missing ("unit"), decide whether it means cans vs oz/lb
  if (category === 'legumes' && u === 'unit' && Number.isFinite(qty)) {
    // If qty is small-ish, assume it’s “cans” (1–6 cans is common) for BEANS/CHICKPEAS
    if (qty >= 1 && qty <= 6 && CANNED_LEGUME_HINT.test(n)) {
      return { qty: whole(qty), unit: 'can' };
    }

    // If qty is large, assume it’s ounces (fixes "23" meaning ~23 oz)
    if (qty >= 8) {
      const oz = qty;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
  }

  // 5) Legumes: if we already have explicit oz/lb, still prefer "can" for canned-style beans/chickpeas
  // (helps merge "chickpeas 14 oz" with "chickpeas 1 can")
  if (category === 'legumes' && CANNED_LEGUME_HINT.test(n)) {
    if (u === 'oz') return { qty: whole(qty / 15), unit: 'can' };
    if (u === 'lb') return { qty: whole((qty * 16) / 15), unit: 'can' };
  }

  // Garlic: prefer cloves when unit is missing
  if (n === 'garlic') {
    if (u === 'oz' || u === 'lb') return { qty: r1(qty), unit: u };
    return { qty: whole(qty), unit: 'clove' };
  }

  // Tofu: show as blocks (assume ~14 oz per block)
  if (n.includes('tofu')) {
    if (u === 'block') return { qty: whole(qty), unit: 'block' };

    if (u === 'unit' && qty >= 8) {
      return { qty: whole(qty / 14), unit: 'block' }; // interpret qty as oz
    }

    if (u === 'oz') return { qty: whole(qty / 14), unit: 'block' };
    if (u === 'lb') return { qty: whole((qty * 16) / 14), unit: 'block' };

    if (u === 'unit') return { qty: whole(qty), unit: 'block' };
    return { qty: whole(qty), unit: 'block' };
  }

  // Diced tomatoes: if it comes through as a bare count (often meaning oz),
  // treat it as oz and convert to lb if big.
  if (n === 'diced tomato' || n === 'diced tomatoes') {
    if (u === 'unit' && qty >= 4) {
      const oz = qty;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
  }

  // If produce comes through as unit with a huge number (18),
  // interpret as ounces for better UX (requires categorizer => produce).
  if (category === 'produce' && u === 'unit' && qty >= 8) {
    const oz = qty;
    if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
    return { qty: whole(oz), unit: 'oz' };
  }

  // Spices: if unit missing, default to tsp (never "unit")
  if (category === 'spices' && (u === '' || u === 'unit')) {
    return { qty: r1(qty), unit: 'tsp' };
  }

  // -----------------------------
  // Generic interpretation for large bare counts:
  // If something arrives as unit="unit" with a large number,
  // treat it as ounces EXCEPT for produce and legumes (handled above).
  // -----------------------------
  if (u === 'unit' && qty >= 8) {
    if (category !== 'produce' && category !== 'legumes') {
      const oz = qty;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
  }

  // -----------------------------
  // B) Respect explicit count units
  // -----------------------------
  if (
    u === 'can' ||
    u === 'bunch' ||
    u === 'unit' ||
    u === 'clove' ||
    u === 'block' ||
    u === 'bottle' ||
    u === 'carton'
  ) {
    if (u === 'unit') return { qty: whole(qty), unit: 'unit' };
    return { qty: whole(qty), unit: u };
  }

  // -----------------------------
  // 1) Meat/fish: always lb
  // -----------------------------
  if (category === 'protein') {
    if (u === 'lb') return { qty: r1(qty), unit: 'lb' };
    if (u === 'oz') return { qty: roundToHalfLb(qty / 16), unit: 'lb' };

    const cups = u === 'cup' ? qty : u === 'tbsp' ? qty / 16 : u === 'tsp' ? qty / 48 : null;
    if (cups != null) {
      const oz = cups * 5; // rough fallback
      return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
    }

    return { qty, unit: u || unit };
  }

  // -----------------------------
  // 2) Standardize oz/lb
  // -----------------------------
  if (u === 'oz') {
    if (qty >= 16) return { qty: roundToHalfLb(qty / 16), unit: 'lb' };
    return { qty: whole(qty), unit: 'oz' };
  }
  if (u === 'lb') return { qty: r1(qty), unit: 'lb' };

  // -----------------------------
  // 3) Cooking units -> shopper units
  // -----------------------------
  const isCookingUnit = u === 'tsp' || u === 'tbsp' || u === 'cup';
  if (isCookingUnit) {
    // If it's spices, keep tsp/tbsp/cup rather than turning into oz/lb
    if (category === 'spices') {
      if (u === 'cup') return { qty: r1(qty * 16), unit: 'tbsp' }; // 1 cup = 16 tbsp
      if (u === 'tbsp') return { qty: r1(qty), unit: 'tbsp' };
      return { qty: r1(qty), unit: 'tsp' };
    }

    const cups = u === 'cup' ? qty : u === 'tbsp' ? qty / 16 : qty / 48;

    // Herbs -> bunch
    if (['parsley', 'cilantro', 'dill', 'mint', 'basil'].includes(n)) {
      return { qty: whole(cups / 1), unit: 'bunch' };
    }

    // Produce that shops by each
    if (n === 'bell pepper' || n === 'zucchini') return { qty: whole(cups), unit: 'unit' };
    if (n === 'cucumber') return { qty: whole(cups / 2), unit: 'unit' };
    if (n === 'carrot') return { qty: whole(cups / 0.5), unit: 'unit' };

    // Default: convert cup-ish to oz, then lb at 16+
    const ozPerCup = n === 'cherry tomato' ? 5 : 6;
    const oz = cups * ozPerCup;

    if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
    return { qty: whole(oz), unit: 'oz' };
  }

  // -----------------------------
  // 4) Metric -> oz/lb
  // -----------------------------
  if (u === 'g') {
    const oz = qty * 0.035274;
    if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
    return { qty: whole(oz), unit: 'oz' };
  }
  if (u === 'kg') {
    const oz = qty * 1000 * 0.035274;
    if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
    return { qty: whole(oz), unit: 'oz' };
  }

  // -----------------------------
  // 5) Produce fallback
  // -----------------------------
  if (category === 'produce') {
    return { qty: whole(qty), unit: 'unit' };
  }

  return { qty, unit: u || unit };
}

/** ---------- Public: merge & normalize ---------- */
export function smartMergeNeeds(needs: RawNeed[]): ShoppingItem[] {
  const agg = new Map<string, { name: string; group: UnitGroup; base: number; preferredUnit: string }>();

  for (const n of needs) {
    const parsed = parseParenAmount(n.name || '');
    const rawName = (parsed.cleaned || '').trim();
    if (!rawName) continue;

    const name = normalizeIngredientName(rawName);

    const effectiveUnit = (n.unit ?? '') || (parsed.unit ?? '');
    const effectiveQty = (n.qty ?? null) ?? (parsed.qty ?? null);

    const unitNorm = normalizeUnit(effectiveUnit);
    const qtyNum = Number(effectiveQty ?? 1) || 1;

    const { group, base } = toBaseQty(qtyNum, unitNorm);

    const key = `${name}|${group}`;

    const preferredUnit =
      group === 'count'
        ? unitNorm === 'can'
          ? 'can'
          : unitNorm || 'unit'
        : unitNorm;

    const cur = agg.get(key);

    if (cur) {
      cur.base += base;
      if (group === 'count' && preferredUnit === 'can') cur.preferredUnit = 'can';
    } else {
      agg.set(key, { name, group, base, preferredUnit });
    }
  }

  // 1) Convert to shopping-friendly units
  const converted: ShoppingItem[] = [];
  for (const { name, group, base, preferredUnit } of agg.values()) {
    const baseOut = fromBase(group, base, preferredUnit);
    const category = autoCategoryFromName(name);
    const shopOut = toShoppingUnit(name, baseOut.qty, baseOut.unit, category);

    converted.push({
      name,
      qty: shopOut.qty,
      unit: shopOut.unit,
      category,
    });
  }

  // 2) Merge again AFTER conversion (fixes duplicates like cucumber/lentil)
  const merged2 = new Map<string, ShoppingItem>();
  for (const it of converted) {
    const key = `${it.name}|${it.unit}|${it.category ?? 'other'}`;
    const cur = merged2.get(key);
    if (cur) {
      cur.qty = round1(cur.qty + it.qty);
    } else {
      merged2.set(key, { ...it });
    }
  }

  const out = Array.from(merged2.values());
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}