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
  note?: string; // optional UI hint (e.g., substitution suggestion)
};

export type PantryAmount = {
  name: string;
  qty: number | null;
  unit: string | null;
};

// --------- Substitution types & helpers ---------
export type SubstitutionUsed = {
  missing: string;      // the ingredient the recipe asked for (normalized)
  substitute: string;   // pantry ingredient we can use instead (normalized)
  note: string;         // short user-facing message
};

type SubRule = {
  // If a recipe asks for `from`, and pantry has `to`, we can recommend substituting.
  from: string;
  to: string;
  note: string;
  // Optional hard block tags you can enforce at call sites (e.g., allergies) via `blocked`.
  tags?: Array<'dairy' | 'gluten' | 'soy' | 'egg' | 'sesame' | 'peanut' | 'tree_nut' | 'fish' | 'shellfish'>;
};

type IngredientFamilyRule = {
  family: string;
  members: string[];
};

const INGREDIENT_FAMILY_RULES: IngredientFamilyRule[] = [
  {
    family: 'pasta',
    members: [
      'pasta',
      'whole wheat pasta',
      'whole-wheat pasta',
      'spaghetti',
      'penne',
      'rigatoni',
      'fusilli',
      'farfalle',
      'farfalline',
      'macaroni',
      'rotini',
    ],
  },
  {
    family: 'rice',
    members: ['rice', 'white rice', 'brown rice', 'jasmine rice', 'basmati rice'],
  },
  {
    family: 'quinoa',
    members: ['quinoa', 'white quinoa', 'red quinoa'],
  },
  {
    family: 'beans',
    members: [
      'bean',
      'black bean',
      'kidney bean',
      'pinto bean',
      'cannellini bean',
      'chickpea',
      'garbanzo',
    ],
  },
  {
    family: 'ground meat',
    members: ['ground turkey', 'ground chicken', 'ground beef', 'ground lamb', 'ground pork'],
  },
  {
    family: 'broth',
    members: ['chicken broth', 'chicken stock', 'vegetable broth', 'vegetable stock'],
  },
];

// Phase A+B: small, high-ROI substitution set (pantry-staple swaps).
// These are *common* substitutions cited in mainstream cooking references.
// IMPORTANT: We do NOT apply a rule if either side is blocked by caller-provided constraints.
const SUB_RULES: SubRule[] = [
  // Dairy / creamy
  { from: 'sour cream', to: 'greek yogurt', note: 'You can use Greek yogurt instead of sour cream.', tags: ['dairy'] },
  { from: 'greek yogurt', to: 'sour cream', note: 'You can use sour cream instead of Greek yogurt.', tags: ['dairy'] },

  // Soy sauces
  { from: 'soy sauce', to: 'tamari', note: 'You can use tamari instead of soy sauce.', tags: ['soy'] },
  { from: 'tamari', to: 'soy sauce', note: 'You can use soy sauce instead of tamari.', tags: ['soy'] },

  // Acid swaps
  { from: 'rice vinegar', to: 'apple cider vinegar', note: 'Apple cider vinegar works well instead of rice vinegar.' },
  { from: 'rice vinegar', to: 'white vinegar', note: 'White vinegar works well instead of rice vinegar.' },
  { from: 'lemon juice', to: 'lime juice', note: 'Lime juice is a good substitute for lemon juice.' },
  { from: 'lime juice', to: 'lemon juice', note: 'Lemon juice is a good substitute for lime juice.' },

  // Stocks / broths
  { from: 'chicken broth', to: 'vegetable broth', note: 'Vegetable broth can substitute for chicken broth (flavor will be a bit different).' },
  { from: 'chicken stock', to: 'vegetable broth', note: 'Vegetable broth can substitute for chicken stock (flavor will be a bit different).' },

  // Herbs
  { from: 'parsley', to: 'cilantro', note: 'Cilantro can work instead of parsley (different flavor profile).' },
  { from: 'cilantro', to: 'parsley', note: 'Parsley can work instead of cilantro (different flavor profile).' },

  // Proteins (ground)
  { from: 'ground turkey', to: 'ground chicken', note: 'Ground chicken works instead of ground turkey.' },
  { from: 'ground chicken', to: 'ground turkey', note: 'Ground turkey works instead of ground chicken.' },
];

function normalizeForSub(raw: string): string {
  // Reuse the same normalization as the shopping merge key.
  return normalizeIngredientName(raw);
}

function pantryHas(pantryNorm: Set<string>, name: string): boolean {
  return pantryNorm.has(name);
}

function findIngredientFamily(nameNorm: string): IngredientFamilyRule | null {
  for (const rule of INGREDIENT_FAMILY_RULES) {
    const membersNorm = rule.members.map((m) => normalizeForSub(m));
    if (membersNorm.includes(nameNorm)) return rule;
  }
  return null;
}

function buildFamilySubstitutionNote(missing: string, pantryMatch: string): string {
  return `You already have ${pantryMatch} in your pantry, which may work instead of ${missing}.`;
}

function collectFamilySubstitutionHints(
  needs: RawNeed[],
  pantry: Iterable<string>,
  opts?: { blocked?: Set<string> },
): SubstitutionUsed[] {
  const blocked = opts?.blocked ?? new Set<string>();

  const pantryNorm = new Set<string>();
  for (const p of pantry) {
    const n = normalizeForSub(p);
    if (n) pantryNorm.add(n);
  }

  const hints: SubstitutionUsed[] = [];
  const seen = new Set<string>();

  for (const n of needs) {
    const rawName = (n.name || '').trim();
    if (!rawName) continue;

    const needNorm = normalizeForSub(rawName);
    if (!needNorm) continue;
    if (blocked.has(needNorm)) continue;

    const family = findIngredientFamily(needNorm);
    if (!family) continue;

    const membersNorm = family.members
      .map((m) => normalizeForSub(m))
      .filter(Boolean)
      .filter((m) => m !== needNorm && !blocked.has(m));

    // Only allow substitution if pantry has it AND it is not also needed
    const pantryMatch = membersNorm.find((m) => {
      if (!pantryHas(pantryNorm, m)) return false;

      // If the substitute is ALSO needed in the shopping list,
      // we should not show a substitution hint.
      const alsoNeeded = needs.some((n) => normalizeForSub(n.name) === m);
      return !alsoNeeded;
    });

    if (!pantryMatch) continue;

    const key = `${needNorm}|${pantryMatch}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hints.push({
      missing: needNorm,
      substitute: pantryMatch,
      note: buildFamilySubstitutionNote(needNorm, pantryMatch),
    });
  }

  return hints;
}

export function applySubstitutionsToNeeds(
  needs: RawNeed[],
  pantry: Iterable<string>,
  opts?: {
    blocked?: Set<string>; // normalized ingredient names that must not be suggested/used
    // if true, we will still keep the original shopping item but attach a note;
    // otherwise we remove the original need from the shopping list when a pantry substitute exists.
    keepOriginalInList?: boolean;
  },
): { needsOut: RawNeed[]; substitutionsUsed: SubstitutionUsed[] } {
  const blocked = opts?.blocked ?? new Set<string>();
  const keepOriginal = !!opts?.keepOriginalInList;

  const pantryNorm = new Set<string>();
  for (const p of pantry) {
    const n = normalizeForSub(p);
    if (n) pantryNorm.add(n);
  }

  const substitutionsUsed: SubstitutionUsed[] = [];
  const needsOut: RawNeed[] = [];

  for (const n of needs) {
    const rawName = (n.name || '').trim();
    if (!rawName) continue;

    const needNorm = normalizeForSub(rawName);
    if (!needNorm) continue;

    // If the needed ingredient is blocked, we do not attempt substitutions.
    if (blocked.has(needNorm)) {
      needsOut.push(n);
      continue;
    }

    // Find first applicable substitution where pantry has `to`.
    const rule = SUB_RULES.find((r) => {
      const from = normalizeForSub(r.from);
      const to = normalizeForSub(r.to);
      if (from !== needNorm) return false;
      if (!to) return false;
      if (blocked.has(to)) return false;
      return pantryHas(pantryNorm, to);
    });

    if (!rule) {
      needsOut.push(n);
      continue;
    }

    const toNorm = normalizeForSub(rule.to);

    substitutionsUsed.push({
      missing: needNorm,
      substitute: toNorm,
      note: rule.note,
    });

    if (keepOriginal) {
      // Keep the original line but we’ll attach a note downstream.
      needsOut.push(n);
    } else {
      // Drop the need from shopping list (because user has a pantry substitute).
      // NOTE: Phase C can later adjust quantities precisely.
    }
  }

  return { needsOut, substitutionsUsed };
}

export function attachSubstitutionNotes(
  items: ShoppingItem[],
  substitutionsUsed: SubstitutionUsed[],
): ShoppingItem[] {
  if (!substitutionsUsed.length) return items;

  const notesByMissing = new Map<string, string[]>();
  for (const s of substitutionsUsed) {
    const arr = notesByMissing.get(s.missing) ?? [];
    if (!arr.includes(s.note)) arr.push(s.note);
    notesByMissing.set(s.missing, arr);
  }

  return items.map((it) => {
    const subNotes = notesByMissing.get(it.name);
    if (!subNotes?.length) return it;

    const combined = [it.note, ...subNotes].filter(Boolean).join(' ');
    return { ...it, note: combined };
  });
}

export function smartMergeNeedsWithSubstitutions(
  needs: RawNeed[],
  pantry: Iterable<string>,
  opts?: {
    blocked?: Set<string>;
    keepOriginalInList?: boolean;
  },
): { items: ShoppingItem[]; substitutionsUsed: SubstitutionUsed[] } {
  const { needsOut, substitutionsUsed } = applySubstitutionsToNeeds(needs, pantry, opts);
  const familyHintsUsed = collectFamilySubstitutionHints(needsOut, pantry, {
    blocked: opts?.blocked,
  });

  const items = smartMergeNeeds(needsOut);

  const allNotes = [...substitutionsUsed, ...familyHintsUsed];
  const itemsWithNotes = opts?.keepOriginalInList
    ? attachSubstitutionNotes(items, allNotes)
    : items;

  return { items: itemsWithNotes, substitutionsUsed: allNotes };
}

/** ---------- Helpers: parse "(about 2 oz)" etc in parentheses ---------- */
function parseParenAmount(raw: string): { cleaned: string; qty?: number; unit?: string } {
  const s = (raw || '').trim();
  if (!s) return { cleaned: s };

  // Match "(about 2 oz)", "(2 fl oz)", "(approx: 1 carton)", "(1.5 lb)" etc.
  // Capture unit as loose token -> normalize it.
  const m = s.match(/\(\s*(?:about|approx\.?|approximately)?\s*:?\s*([\d.]+)\s*([a-zA-Z.\s]+?)\s*\)/i);
  if (!m) return { cleaned: s };

  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return { cleaned: s };

  let unitToken = (m[2] || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Normalize common fluid patterns
  if (unitToken === 'fl oz' || unitToken === 'fluid ounce' || unitToken === 'fluid ounces') unitToken = 'oz';

  // Handle multi-token units from LLMs, e.g. "oz can", "can oz", "carton oz"
  // Prefer the true measurement unit if present.
  const parts = unitToken.split(' ').filter(Boolean);

  const has = (x: string) => parts.includes(x);
  const measurementPreferred =
    has('oz') ? 'oz' :
    has('lb') ? 'lb' :
    has('g') ? 'g' :
    has('kg') ? 'kg' :
    has('ml') ? 'ml' :
    has('l') ? 'l' :
    null;

  // If no measurement token, prefer container tokens if present.
  const containerPreferred =
    has('carton') || has('cartons') ? 'carton' :
    has('bottle') || has('bottles') ? 'bottle' :
    has('can') || has('cans') ? 'can' :
    null;

  if (measurementPreferred) unitToken = measurementPreferred;
  else if (containerPreferred) unitToken = containerPreferred;

  // Reuse your existing unit normalizer
  const unit = normalizeUnit(unitToken);

  // Only accept units we actually know how to handle downstream
    const ALLOWED = new Set([
    'oz',
    'lb',
    'g',
    'kg',
    'ml',
    'l',
    'can',
    'bottle',
    'carton',
    'head',
    'unit',
    'bunch',
    'clove',
    'block',
  ]);
  if (!ALLOWED.has(unit)) {
    return { cleaned: s }; // don't strip parentheses if we couldn't interpret the unit
  }

  // Remove the whole parenthetical from the original string
  const cleaned = s.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();

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

  // Canonicalize common variants to improve shopping-list merging
  // Keep this BEFORE plural trimming.
  const CANON_RULES: Array<[RegExp, string]> = [
    // Produce variants
    [/\bbroccoli\b.*\bfloret(s)?\b/, 'broccoli'],
    [/\bgreen onion(s)?\b/, 'scallion'],
    [/\bspring onion(s)?\b/, 'scallion'],
    [/\bscallion(s)?\b/, 'scallion'],

    // Tomatoes variants (optional)
    [/\broma tomato(es)?\b/, 'tomato'],
    [/\bgrape tomato(es)?\b/, 'cherry tomato'],

    // Greens variants
    [/\bbaby spinach\b/, 'spinach'],

    // Bok choy variants
    [/\bbok\s*choy\b/, 'bok choy'],
    [/\bpak\s*choy\b/, 'bok choy'],
    [/\bpac\s*choy\b/, 'bok choy'],
  ];

  for (const [re, canonical] of CANON_RULES) {
    if (re.test(s)) {
      s = canonical;
      break;
    }
  }

  // Strip very common cut/format descriptors at the end of names
  // (keeps things like "ground cumin" intact because it’s not at the end)
  s = s.replace(
    /\s+(floret(s)?|spear(s)?|slice(d)?|diced|chopped|minced|shredded|grated|crumbled)\b$/i,
    '',
  ).trim();

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
    'bok choy',
    'scallion',
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

  head: 'head',
  heads: 'head',
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
    case 'head':
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

function subtractCoverageKey(name: string, unitNorm: string, group: UnitGroup): string {
  // For mass / volume groups we can safely compare within the same measurement family.
  // For count-ish units (can, bunch, bottle, carton, unit, etc.) require exact unit match.
  if (group === 'mass_g' || group === 'mass_oz' || group === 'vol_ml' || group === 'vol_small') {
    return `${name}|${group}`;
  }
  return `${name}|${unitNorm}`;
}

function almostZero(x: number): boolean {
  return Math.abs(x) < 0.0001;
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

  // Consistent constants
  const OZ_PER_CAN = 15.5;
  const OZ_PER_BROTH_CARTON = 32;
  const OZ_PER_COCONUT_MILK_CAN = 14;

  // IMPORTANT: exclude lentils so we don't split dry lentils into can vs oz lines.
  const CANNED_LEGUME_HINT = /\b(bean|beans|chickpea|garbanzo)\b/;

  const isBroth = /\b(broth|stock)\b/.test(n) && !/\b(powder|granules|bouillon)\b/.test(n);
  const isSoyOrTeriyaki = /\b(soy sauce|tamari|teriyaki)\b/.test(n);
  const isCoconutMilk = /\bcoconut milk\b/.test(n);

  // Defensive: if categorizer ever mislabels meat as spices, don't tsp-ify it.
  const looksLikeProtein = /\b(beef|turkey|chicken|pork|lamb|veal|shrimp|fish|salmon|tuna)\b/.test(n);

  // Helpers: convert cooking units to “shopping oz” for sauces/liquids.
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

  const metricToOz = (qty0: number, u0: string): number | null => {
    if (!Number.isFinite(qty0) || qty0 <= 0) return null;
    if (u0 === 'g') return qty0 * 0.035274;
    if (u0 === 'kg') return qty0 * 1000 * 0.035274;
    return null;
  };

  // -----------------------------
  // A) Special cases FIRST
  // -----------------------------

  // 0) If it looks like protein, prefer protein behavior regardless of category (defensive)
  if (looksLikeProtein) {
    // If already lb -> keep; if oz -> lb; if cooking units -> rough lb fallback
    if (u === 'lb') return { qty: r1(qty), unit: 'lb' };
    if (u === 'oz') return { qty: roundToHalfLb(qty / 16), unit: 'lb' };

    const oz = cookingToOz(qty, u) ?? metricToOz(qty, u);
    if (oz != null) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };

    // Default: assume qty is lb-ish if it’s not tiny; else 0.5 lb min
    return { qty: roundToHalfLb(Math.max(0.5, qty)), unit: 'lb' };
  }

  // 1) Broth/stock → show cartons (32 oz per carton)
  if (isBroth) {
    const oz = cookingToOz(qty, u) ?? metricToOz(qty, u);
    if (oz != null) return { qty: whole(oz / OZ_PER_BROTH_CARTON), unit: 'carton' };
    if (u === 'carton') return { qty: whole(qty), unit: 'carton' };
    if (u === 'unit') return { qty: whole(qty), unit: 'carton' };
  }

  // 2) Soy / tamari / teriyaki → ALWAYS show oz in columns
  if (isSoyOrTeriyaki) {
    const oz = cookingToOz(qty, u) ?? metricToOz(qty, u);
    if (oz != null) {
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: Math.max(1, Math.ceil(oz)), unit: 'oz' };
    }
  }

  // 3) Coconut milk → ALWAYS show cans (shopping UX)
  if (isCoconutMilk) {
    if (u === 'can') return { qty: whole(qty), unit: 'can' };

    // If unit is missing and qty is small-ish, treat as cans
    if (u === 'unit' && qty >= 1 && qty <= 6) return { qty: whole(qty), unit: 'can' };

    // Otherwise estimate oz and convert to cans
    const oz = cookingToOz(qty, u) ?? metricToOz(qty, u);
    if (oz != null) return { qty: whole(oz / OZ_PER_COCONUT_MILK_CAN), unit: 'can' };

    // Last resort: assume qty is cans
    return { qty: whole(qty), unit: 'can' };
  }

  // 4) Legumes: normalize canned-style beans/chickpeas to cans
  if (category === 'legumes' && u === 'unit' && Number.isFinite(qty)) {
    // If qty is small-ish, assume it’s “cans”
    if (qty >= 1 && qty <= 6 && CANNED_LEGUME_HINT.test(n)) {
      return { qty: whole(qty), unit: 'can' };
    }

    // If qty is large, treat as oz, and for canned-style legumes convert to cans
    if (qty >= 8) {
      if (CANNED_LEGUME_HINT.test(n)) return { qty: whole(qty / OZ_PER_CAN), unit: 'can' };

      const oz = qty;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
  }

  if (category === 'legumes' && CANNED_LEGUME_HINT.test(n)) {
    if (u === 'oz') return { qty: whole(qty / OZ_PER_CAN), unit: 'can' };
    if (u === 'lb') return { qty: whole((qty * 16) / OZ_PER_CAN), unit: 'can' };
  }

  // 5) Garlic: prefer cloves when unit is missing
  if (n === 'garlic') {
    if (u === 'oz' || u === 'lb') return { qty: r1(qty), unit: u };
    return { qty: whole(qty), unit: 'clove' };
  }

  // 6) Tofu: show as blocks (assume ~14 oz per block)
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

  // 7) Diced tomatoes: bare count often means oz
  if (n === 'diced tomato' || n === 'diced tomatoes') {
    if (u === 'unit' && qty >= 4) {
      const oz = qty;
      if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
      return { qty: whole(oz), unit: 'oz' };
    }
  }

  // 8) Broccoli: if it ever arrives as a bare count, treat as weight so it merges cleanly (lb)
  // Place this BEFORE the generic produce "unit qty>=8" conversion.
  if (category === 'produce' && /\bbroccoli\b/.test(n) && u === 'unit') {
    // assume 1 "unit" broccoli ≈ 1 lb (rough but stable)
    return { qty: roundToHalfLb(qty), unit: 'lb' };
  }

  // 9) Produce: if it comes through as unit with a huge number, interpret as ounces
  if (category === 'produce' && u === 'unit' && qty >= 8) {
    const oz = qty;
    if (oz >= 16) return { qty: roundToHalfLb(oz / 16), unit: 'lb' };
    return { qty: whole(oz), unit: 'oz' };
  }

  // 10) Spices: if unit missing, default to tsp (never "unit")
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
    u === 'carton' ||
    u === 'head'
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

    // Legumes (canned-style): if recipes specify cups/tbsp/tsp, still roll up to cans
    if (category === 'legumes' && CANNED_LEGUME_HINT.test(n)) {
      const ozPerCup = 6;
      const oz = cups * ozPerCup;
      return { qty: whole(oz / OZ_PER_CAN), unit: 'can' };
    }

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

export function subtractPantryFromNeeds(
  needs: RawNeed[],
  pantry: PantryAmount[],
): RawNeed[] {
  const pantryAvail = new Map<string, { group: UnitGroup; base: number; preferredUnit: string }>();

  for (const p of pantry) {
    const rawName = (p.name || '').trim();
    if (!rawName) continue;

    const name = normalizeIngredientName(rawName);
    if (!name) continue;

    const unitNorm = normalizeUnit(p.unit ?? 'unit');
    const qtyNum = Number(p.qty ?? 1) || 1;
    const { group, base } = toBaseQty(qtyNum, unitNorm);
    const key = subtractCoverageKey(name, unitNorm, group);

    const cur = pantryAvail.get(key);
    if (cur) {
      cur.base += base;
    } else {
      pantryAvail.set(key, {
        group,
        base,
        preferredUnit: unitNorm || 'unit',
      });
    }
  }

  const remaining: RawNeed[] = [];

  for (const n of needs) {
    const parsed = parseParenAmount(n.name || '');
    const rawName = (parsed.cleaned || '').trim();
    if (!rawName) continue;

    const name = normalizeIngredientName(rawName);
    if (!name) continue;

    const effectiveUnit = (parsed.unit ?? n.unit ?? 'unit') as string;
    const effectiveQty = (parsed.qty ?? n.qty ?? 1) as number | null;

    const unitNorm = normalizeUnit(effectiveUnit);
    const qtyNum = Number(effectiveQty ?? 1) || 1;
    const { group, base } = toBaseQty(qtyNum, unitNorm);
    const key = subtractCoverageKey(name, unitNorm, group);

    const avail = pantryAvail.get(key);
    if (!avail || avail.group !== group || avail.base <= 0) {
      remaining.push({
        name: rawName,
        qty: qtyNum,
        unit: unitNorm,
      });
      continue;
    }

    const used = Math.min(base, avail.base);
    const left = base - used;
    avail.base -= used;

    if (almostZero(left) || left <= 0) {
      continue;
    }

    const out = fromBase(group, left, unitNorm);
    remaining.push({
      name: rawName,
      qty: out.qty,
      unit: out.unit,
    });
  }

  return remaining;
}

/** ---------- Public: merge & normalize ---------- */
export function smartMergeNeeds(needs: RawNeed[]): ShoppingItem[] {
  const agg = new Map<string, { name: string; group: UnitGroup; base: number; preferredUnit: string }>();

  for (const n of needs) {
    const parsed = parseParenAmount(n.name || '');
    const rawName = (parsed.cleaned || '').trim();
    if (!rawName) continue;

    const name = normalizeIngredientName(rawName);

    // If we successfully parsed "(about 2 oz)", prefer that over recipe-provided defaults
    const effectiveUnit = (parsed.unit ?? n.unit ?? '') as string;
    const effectiveQty = (parsed.qty ?? n.qty ?? null) as number | null;

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

  // 2) Merge again AFTER conversion (same unit + category)
  const merged2 = new Map<string, ShoppingItem>();
  for (const it of converted) {
    const key = `${it.name}|${it.unit}|${it.category ?? 'other'}`;
    const cur = merged2.get(key);
    if (cur) cur.qty = round1(cur.qty + it.qty);
    else merged2.set(key, { ...it });
  }

  // 3) General merge for oz/lb into one line per name+category (prevents split lines)
  // Keep legumes excluded because you normalize canned legumes to 'can'.
  const merged3 = new Map<string, ShoppingItem>();
  const massTotals = new Map<string, number>(); // key => totalOz

  for (const it of merged2.values()) {
    const cat = it.category ?? 'other';
    const keyNC = `${it.name}|${cat}`;

    if (cat !== 'legumes' && (it.unit === 'oz' || it.unit === 'lb')) {
      const oz = it.unit === 'lb' ? it.qty * 16 : it.qty;
      massTotals.set(keyNC, (massTotals.get(keyNC) ?? 0) + oz);
      continue;
    }

    // keep everything else as-is
    const key = `${it.name}|${it.unit}|${cat}`;
    const cur = merged3.get(key);
    if (cur) cur.qty = round1(cur.qty + it.qty);
    else merged3.set(key, { ...it });
  }

  for (const [keyNC, totalOz] of massTotals.entries()) {
    const [name, cat] = keyNC.split('|');
    const out = fromBase('mass_oz', totalOz, 'oz'); // picks lb if >=16
    const item: ShoppingItem = { name, qty: out.qty, unit: out.unit, category: cat as PantryCategory };
    const key = `${item.name}|${item.unit}|${item.category ?? 'other'}`;
    const cur = merged3.get(key);
    if (cur) cur.qty = round1(cur.qty + item.qty);
    else merged3.set(key, item);
  }

  // 4) Lentils safety merge (keeps prior behavior; often already handled by step 3)
  const LENTIL_HINT = /\blentil(s)?\b/i;

  const out: ShoppingItem[] = [];
  let lentilOzTotal = 0;

  for (const it of merged3.values()) {
    const isLentil = it.category === 'legumes' && LENTIL_HINT.test(it.name);

    if (isLentil && (it.unit === 'oz' || it.unit === 'lb')) {
      const oz = it.unit === 'lb' ? it.qty * 16 : it.qty;
      lentilOzTotal += oz;
      continue;
    }

    out.push(it);
  }

  if (lentilOzTotal > 0) {
    const outMass = fromBase('mass_oz', lentilOzTotal, 'oz');
    out.push({
      name: 'lentil',
      qty: outMass.qty,
      unit: outMass.unit,
      category: 'legumes',
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}