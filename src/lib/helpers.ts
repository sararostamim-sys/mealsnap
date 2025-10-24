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
 * Pantry capture helpers
 * -----------------------------------------------------------------*/

export type DetectedItem = {
  name: string;
  qty?: number;
  unit?: string;
  confidence?: number;
  raw?: unknown; // store opaque payloads as unknown
};

// Bring in the normalization helpers you added earlier.
import {
  brandlessName,
  tidyCase,
  guessQtyUnitFor,
} from '@/lib/normalize';

type OCRResponse = { ok?: boolean; text?: string; error?: string };

/**
 * Normalize a raw name for pantry display:
 *  - strip brands
 *  - tidy case
 *  - infer smart default qty + unit
 */
function toPantryRowNameQtyUnit(rawName: string): { name: string; qty: number; unit: string } {
  const clean = tidyCase(brandlessName(rawName || ''));
  const { qty, unit } = guessQtyUnitFor(clean);
  return { name: clean, qty, unit };
}

/**
 * Call your /api/ocr endpoint with a single image file (field name 'image').
 * Your OCR route returns: { ok: boolean, text: string }.
 * We split the merged text into candidate tokens and normalize each one
 * to a Pantry-ready (brandless) display name with smart qty/unit.
 */
export async function ocrDetectSingle(file: File): Promise<DetectedItem[]> {
  const fd = new FormData();
  fd.append('image', file); // <-- matches your /api/ocr handler

  const res = await fetch('/api/ocr', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());

  const j: unknown = await res.json();
  const json: OCRResponse = (typeof j === 'object' && j !== null) ? (j as OCRResponse) : {};

  const text: string = json.text ?? '';
  // Tokenize
  const tokens = text
    .toLowerCase()
    .split(/\n|,|;|\/|•|·|\s{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = Array.from(
    new Set(tokens.filter((t) => /[a-z]/.test(t) && t.length >= 3 && t.length <= 48))
  ).slice(0, 8);

  // Normalize for pantry
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
 * We normalize brand+name to a Pantry-ready row (brandless + smart qty/unit).
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