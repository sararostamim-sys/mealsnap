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
  raw?: unknown; // <- no 'any'; store opaque payloads as unknown
};

type OCRResponse = { ok?: boolean; text?: string; error?: string };

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

  return candidates.map((t) => ({
    name: t,
    qty: 1,
    unit: 'unit',
    confidence: 0.7,
    raw: { source: 'ocr', token: t } as const,
  }));
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

  const name =
    [p?.brand, p?.name].filter(Boolean).join(' ').toLowerCase() ||
    `item ${codeOrTerm}`;

  return {
    name,
    qty: 1,
    unit: 'unit',
    confidence: 0.99,
    raw: p ?? j, // store the best-known payload, still typed as unknown
  };
}