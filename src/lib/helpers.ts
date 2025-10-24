// src/lib/helpers.ts

/** ------------------------------------------------------------------
 * Mobile UA detection (keeps your existing behavior, no ts-ignore)
 * -----------------------------------------------------------------*/

// Optional Chromium-only field; not present in all browsers.
type NavigatorUA = Navigator & {
  userAgentData?: { mobile?: boolean };
};

/** Detect (roughly) if we're on a mobile user agent. */
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
 * Pantry capture helpers (kept, with stricter types)
 * -----------------------------------------------------------------*/

export type DetectedItem = {
  name: string;
  qty?: number;
  unit?: string;
  confidence?: number;
  raw?: unknown; // opaque payloads as unknown
};

type OCRResponse = { ok?: boolean; text?: string; error?: string };

/* ------------------------------------------------------------------
 * Local normalization utilities (brandless names + tidy case + qty/unit)
 * -----------------------------------------------------------------*/

/** Common retail brands we want to strip from the front of names. */
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

/** Remove a single leading brand token (and “Brand, product” pattern). */
function brandlessName(input: string): string {
  let s = (input || '').trim();
  s = s.replace(BRAND_RE, '').trim();
  s = s.replace(/^[^,]+,\s*(.+)$/i, '$1').trim(); // “Brand, Organic Beans” → “Organic Beans”
  // Normalize whitespace/punct
  s = s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\s*[-,:;]\s*/g, ' ');
  return s.trim();
}

/** Title Case but leave small connector words lower after the first token. */
function tidyCase(s: string): string {
  const lower = (s || '').toLowerCase();
  const SMALL = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'with', 'in']);
  return lower
    .split(' ')
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/^\w/, (c) => c.toUpperCase())))
    .join(' ')
    .trim();
}

/** Heuristic default qty/unit based on common recipe conventions. */
function guessQtyUnitFor(name: string): { qty: number; unit: string } {
  const n = name.toLowerCase();

  // Canned beans & similar (by can)
  if (/\b(beans?|chickpeas?|garbanzo|kidney|black beans?)\b/.test(n)) {
    return { qty: 1, unit: 'can' };
  }

  // Pasta (dry weight oz; most boxes are 16 oz)
  if (/\b(pasta|spaghetti|penne|farfalle|fusilli|rigatoni|macaroni|linguine|fettuccine|noodles?)\b/.test(n)) {
    return { qty: 16, unit: 'oz' };
  }

  // Rice (dry weight)
  if (/\b(rice|basmati|jasmine|arborio|sushi)\b/.test(n)) {
    return { qty: 1, unit: 'lb' };
  }

  // Meat/Chicken in pounds
  if (/\b(chicken|beef|pork|steak|breast|thighs?)\b/.test(n)) {
    return { qty: 1, unit: 'lb' };
  }

  // Produce typically by count
  if (/\b(garlic|onions?|avocados?|lemons?|limes?)\b/.test(n)) {
    return { qty: 1, unit: 'unit' };
  }

  // Tomatoes: if not clearly canned from above, default by count
  if (/\btomatoes?\b/.test(n)) {
    return { qty: 1, unit: 'unit' };
  }

  // Fallback
  return { qty: 1, unit: 'unit' };
}

/** Convert raw product text → Pantry row (brandless + tidy + smart qty/unit). */
function toPantryRow(rawName: string): { name: string; qty: number; unit: string } {
  const base = brandlessName(rawName || '');
  const clean = tidyCase(base);
  const { qty, unit } = guessQtyUnitFor(clean);
  return { name: clean, qty, unit };
}

/* ------------------------------------------------------------------
 * OCR flow
 * -----------------------------------------------------------------*/

/**
 * Call your /api/ocr endpoint with a single image file (field name 'image').
 * Your OCR route returns: { ok: boolean, text: string }.
 * We split the merged text into candidate tokens so the user can confirm/edit.
 */
export async function ocrDetectSingle(file: File): Promise<DetectedItem[]> {
  const fd = new FormData();
  fd.append('image', file); // <-- matches your /api/ocr handler

  const res = await fetch('/api/ocr', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());

  const j: unknown = await res.json();
  const json: OCRResponse = (typeof j === 'object' && j !== null) ? (j as OCRResponse) : {};

  const text: string = json.text ?? '';
  // Turn the big merged text into a small list of candidate item names
  const tokens = text
    .toLowerCase()
    .split(/\n|,|;|\/|•|·|\s{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = Array.from(
    new Set(tokens.filter((t) => /[a-z]/.test(t) && t.length >= 3 && t.length <= 48))
  ).slice(0, 8);

  return candidates.map((t) => {
    const row = toPantryRow(t);
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
  // allow extra fields without using 'any'
  [k: string]: unknown;
};

function pickUPCProduct(x: unknown): UPCProduct | null {
  if (!x || typeof x !== 'object') return null;
  const obj = x as Record<string, unknown>;
  // Try nested product/item first
  if (obj.product && typeof obj.product === 'object') return obj.product as UPCProduct;
  if (obj.item && typeof obj.item === 'object') return obj.item as UPCProduct;
  // Or treat the object itself as the product shape
  const maybe = obj as UPCProduct;
  if ('brand' in maybe || 'name' in maybe || 'size' in maybe || 'category' in maybe) return maybe;
  return null;
}

/**
 * Call your /api/upc endpoint.
 * It accepts POST { code: "<digits or term>" } and returns:
 *   { ok, found, product }  (product has brand/name/size/category)
 * We map that to a DetectedItem the pantry UI can use.
 */
export async function upcLookup(codeOrTerm: string): Promise<DetectedItem> {
  const res = await fetch('/api/upc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codeOrTerm }),
  });
  if (!res.ok) throw new Error(await res.text());

  const j: unknown = await res.json();
  const p = pickUPCProduct(j);

  // Combine brand + name only to help recognition, then strip brand for display
  const merged = [p?.brand, p?.name].filter(Boolean).join(' ').trim() || `item ${codeOrTerm}`;
  const row = toPantryRow(merged);

  return {
    name: row.name,       // brandless, tidy
    qty: row.qty,         // smart default (e.g., beans -> 1 can, pasta -> 16 oz)
    unit: row.unit,
    confidence: 0.99,
    raw: p ?? j,          // keep original payload
  };
}