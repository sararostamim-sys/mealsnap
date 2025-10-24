// src/lib/helpers.ts

/** ------------------------------------------------------------------
 * Mobile UA detection (keeps your existing behavior)
 * -----------------------------------------------------------------*/

type NavigatorUA = Navigator & {
  userAgentData?: { mobile?: boolean };
};

export function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorUA;
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent || '';
  return /iphone|ipod|ipad|android|mobile/i.test(ua);
}

/** Safely coerce a value into an array (undefined/null -> []) */
export function asArray<T>(x: T | T[] | null | undefined): T[] {
  if (Array.isArray(x)) return x;
  if (x === null || x === undefined) return [];
  return [x as T];
}

/* ------------------------------------------------------------------
 * Pantry capture helpers
 * -----------------------------------------------------------------*/

export type DetectedItem = {
  name: string;
  qty?: number;
  unit?: string;
  confidence?: number;
  raw?: unknown;
};

/** Minimal brand list to strip from front of names */
const BRAND_WORDS = [
  "trader joe's",
  'trader joes',
  'barilla',
  'rummo',
  'de cecco',
  'garofalo',
  'colavita',
  'rustichella',
  'buitoni',
  'eataly',
  "rao's",
  'kellogg',
  'general mills',
  "annie’s",
  "annie's",
  'bertolli',
  'classico',
  'heinz',
  'nestle',
  'goya',
  'progresso',
  "campbell's",
  'o organics',
].sort((a, b) => b.length - a.length);

const BRAND_RE = new RegExp(
  `^(?:${BRAND_WORDS.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b[\\s,:-]*`,
  'i'
);

/** Remove leading brand tokens and collapse punctuation/space */
function brandlessName(input: string): string {
  let s = (input || '').trim();
  s = s.replace(BRAND_RE, '').trim();
  // common “Brand, product” → “product”
  s = s.replace(/^[^,]+,\s*(.+)$/i, '$1').trim();
  // collapse repeated brand mentions
  s = s.replace(/\b(?:trader joe'?s)\b\s*\1?/gi, "trader joe's");
  // remove stray punctuation and extra spaces
  s = s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\s*[-,:;]\s*/g, ' ');
  return s.trim();
}

/** Title Case but keep all-caps acronyms short and small words lower */
function tidyCase(s: string): string {
  const lower = (s || '').toLowerCase();
  const SMALL = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'with', 'in']);
  return lower
    .split(' ')
    .map((w, i) => {
      if (i > 0 && SMALL.has(w)) return w;
      return w.replace(/^\w/, (c) => c.toUpperCase());
    })
    .join(' ')
    .trim();
}

/** Very small heuristic map for default qty/unit by item keywords */
function guessQtyUnitFor(name: string): { qty: number; unit: string } {
  const n = name.toLowerCase();

  // Canned goods
  if (/\b(beans?|chickpeas?|garbanzo|kidney|black beans?)\b/.test(n)) {
    return { qty: 1, unit: 'can' };
  }

  // Pasta (dry ounces)
  if (/\b(pasta|spaghetti|penne|farfalle|fusilli|rigatoni|macaroni|linguine|fettuccine|noodles?)\b/.test(n)) {
    return { qty: 16, unit: 'oz' }; // common 1 lb box
  }

  // Rice (dry weight)
  if (/\b(rice|basmati|jasmine|arborio|sushi)\b/.test(n)) {
    return { qty: 1, unit: 'lb' };
  }

  // Meat/Chicken
  if (/\b(chicken|beef|pork|steak|breast|thighs?)\b/.test(n)) {
    return { qty: 1, unit: 'lb' };
  }

  // Produce by count
  if (/\b(garlic|onions?|avocados?|lemons?|limes?|eggs?)\b/.test(n)) {
    return { qty: 1, unit: 'unit' };
  }

  // Tomatoes (if canned, earlier rule covers; fresh by count)
  if (/\btomatoes?\b/.test(n)) {
    return { qty: 1, unit: 'unit' };
  }

  return { qty: 1, unit: 'unit' };
}

/** Convert raw product text → Pantry row (brandless + tidy + smart qty/unit) */
function toPantryRowNameQtyUnit(rawName: string): { name: string; qty: number; unit: string } {
  const clean = tidyCase(brandlessName(rawName || ''));
  const { qty, unit } = guessQtyUnitFor(clean);
  return { name: clean, qty, unit };
}

type OCRResponse = { ok?: boolean; text?: string; error?: string };

/**
 * OCR: POST /api/ocr (field 'image') → { ok, text }
 * Returns pantry-ready detected items.
 */
export async function ocrDetectSingle(file: File): Promise<DetectedItem[]> {
  const fd = new FormData();
  fd.append('image', file);

  const res = await fetch('/api/ocr', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());

  const j: unknown = await res.json();
  const json: OCRResponse = (typeof j === 'object' && j !== null) ? (j as OCRResponse) : {};

  const text: string = json.text ?? '';

  const tokens = text
    .toLowerCase()
    .split(/\n|,|;|\/|•|·|\s{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = Array.from(
    new Set(tokens.filter((t) => /[a-z]/.test(t) && t.length >= 3 && t.length <= 48))
  ).slice(0, 8);

  return candidates.map((t) => {
    const row = toPantryRowNameQtyUnit(t);
    return {
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      confidence: 0.7,
      raw: { source: 'ocr', token: t } as const,
    };
  });
}

/* ------------------- UPC lookup helper ------------------- */

type UPCProduct = {
  brand?: string;
  name?: string;
  size?: string;
  category?: string;
  [k: string]: unknown;
};

type UPCReturn =
  | { ok?: boolean; found?: boolean; product?: UPCProduct; item?: UPCProduct }
  | UPCProduct;

function pickUPCProduct(x: unknown): UPCProduct | null {
  if (!x || typeof x !== 'object') return null;
  const obj = x as Record<string, unknown>;
  if (obj.product && typeof obj.product === 'object') return obj.product as UPCProduct;
  if (obj.item && typeof obj.item === 'object') return obj.item as UPCProduct;
  const maybe = obj as UPCProduct;
  if ('brand' in maybe || 'name' in maybe || 'size' in maybe || 'category' in maybe) return maybe;
  return null;
}

/**
 * UPC: POST /api/upc { code } → { ok, found, product }
 * Returns pantry-ready detected item.
 */
export async function upcLookup(codeOrTerm: string): Promise<DetectedItem> {
  const res = await fetch('/api/upc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codeOrTerm }),
  });
  if (!res.ok) throw new Error(await res.text());

  const j: UPCReturn = await res.json();
  const p = pickUPCProduct(j);

  // Merge brand + name then strip brand for display
  const merged = [p?.brand, p?.name].filter(Boolean).join(' ').trim() || `item ${codeOrTerm}`;
  const row = toPantryRowNameQtyUnit(merged);

  return {
    name: row.name,
    qty: row.qty,
    unit: row.unit,
    confidence: 0.99,
    raw: p ?? j,
  };
}