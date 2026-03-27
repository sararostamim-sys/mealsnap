// src/lib/helpers.ts
import { postClean } from './normalize';
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

//type OCRResponse = {
  //ok?: boolean;
  //text?: string;
  //error?: string;
  //result?: {
  //  rawText?: string;
  //  lines?: string[];
  //  engine?: 'vision' | 'tesseract';
  //};
//};

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
  'organic',
].sort((a, b) => b.length - a.length);

const BRAND_RE = new RegExp(
  `^(?:${BRAND_WORDS.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b[\\s,:-]*`,
  'i'
);

/** Remove a single leading brand token + marketing noise. */
function brandlessName(input: string): string {
  let s = (input || '').trim();

  // 1) Strip known brand names at the front
  s = s.replace(BRAND_RE, '').trim();

  // 2) “Brand, Organic Beans” → “Organic Beans”
  s = s.replace(/^[^,]+,\s*(.+)$/i, '$1').trim();

  // 3) Drop leading marketing adjectives / qualifiers we don’t want as pantry item names.
  //    Keep this focused on modifiers rather than ingredient nouns.
  s = s.replace(
    /^(?:\b(organic|gluten[-\s]*free|low\s+sodium|reduced\s+sodium|no\s+salt\s+added|unsalted|salted|natural|all\s+natural|non[-\s]*gmo|plant\s+based|plain)\b[\s,:-]*)+/gi,
    ''
  ).trim();

  // 4) Strip “made with …”, “with sea salt”, etc. at the end
  s = s.replace(/\bmade\s+with\b.*$/i, '').trim();
  s = s.replace(/\bwith\s+sea\s+salt\b.*$/i, '').trim();
    // 4b) Remove trailing qualifiers that are useful on packaging but noisy in pantry names.
  s = s.replace(/\b(organic|gluten[-\s]*free|low\s+sodium|reduced\s+sodium|no\s+salt\s+added|unsalted|salted|plain)\b$/gi, '').trim();

  // 5) General cleanup of spacing / punctuation
  s = s
    .replace(/[–—]/g, '-')
    .replace(/\s*[-,:;]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return s;
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

/* ---------- Pasta shapes detector (for default "box") ---------- */
const PASTA_SHAPES_RE =
  /\b(radiatori|rigatoni|penne|fusilli|farfalle|farfalline|orecchiette|spaghetti|linguine|fettuccine|rotini|shells?|elbows?|macaroni|ziti|bucatini|cavatappi|gemelli|ditalini|campanelle|conchiglie|pappardelle|tagliatelle)\b/i;

/**
 * Decide the best (qty, unit) from detected text (name + optional size/category).
 * Rules:
 *  - Pasta: "box" by default; if size is present -> oz/g (lb converted to oz)
 *  - Beans: default "can", use oz if present
 *  - Tomatoes: count
 *  - Chicken: lb (convert oz to lb when needed)
 *  - Fallback: 1 unit
 */
function inferQtyUnit(
  name: string,
  size?: string | null,
  category?: string | null
): { qty: number; unit: string } {
  const txt = `${name ?? ''} ${size ?? ''} ${category ?? ''}`.toLowerCase();

  // Pull out explicit sizes if they exist
  const mOz = txt.match(/(\d+(?:\.\d+)?)\s*oz\b/);
  const mG  = txt.match(/(\d+(?:\.\d+)?)\s*g\b/);
  const mLb = txt.match(/(\d+(?:\.\d+)?)\s*lb\b/);
  const toNum = (m: RegExpMatchArray | null) => (m ? Number(m[1]) : NaN);

  const hasPasta = /\bpasta\b/.test(txt) || PASTA_SHAPES_RE.test(txt);

    // Pasta (prefer Net WT; ignore tiny "serving size" weights)
  if (hasPasta) {
    const oz = mOz ? toNum(mOz) : NaN;
    const g  = mG  ? toNum(mG)  : NaN;
    const lb = mLb ? toNum(mLb) : NaN;

    // If size is present but likely a "serving" (too small), fall back to a 16 oz box.
    if (!Number.isNaN(oz)) {
      if (oz >= 8) return { qty: oz, unit: 'oz' };     // real box size (e.g., 12–16 oz)
      return { qty: 16, unit: 'oz' };                  // serving size like "2 oz" -> use 16 oz
    }
    if (!Number.isNaN(g)) {
      if (g >= 200) return { qty: g, unit: 'g' };      // real box size in grams
      return { qty: 454, unit: 'g' };                  // ~16 oz in grams
    }
    if (!Number.isNaN(lb)) {
      if (lb >= 0.5) return { qty: Math.round(lb * 16), unit: 'oz' }; // 0.5 lb+ -> keep as oz
      return { qty: 16, unit: 'oz' };
    }

    // No size found at all -> default to a typical US box weight.
    return { qty: 16, unit: 'oz' };
  }

  // Beans (canned pantry)
  if (/\b(beans?|chickpeas?|garbanzo|kidney|black beans?)\b/.test(txt)) {
    if (mOz) return { qty: toNum(mOz), unit: 'oz' };
    return { qty: 1, unit: 'can' };
  }

  // Tomatoes (fresh count)
  if (/\btomatoes?\b|\btomato\b/.test(txt)) {
    return { qty: 1, unit: 'count' };
  }

  // Chicken (weight)
  if (/\bchicken\b/.test(txt)) {
    if (mLb) return { qty: toNum(mLb), unit: 'lb' };
    if (mOz) return { qty: Math.round((toNum(mOz) / 16) * 10) / 10, unit: 'lb' };
    return { qty: 1, unit: 'lb' };
  }

  // Rice: dry weight default (leave as before)
  if (/\b(rice|basmati|jasmine|arborio|sushi)\b/.test(txt)) {
    return { qty: 1, unit: 'lb' };
  }

  // Produce (general) by count
  if (/\b(garlic|onions?|avocados?|lemons?|limes?)\b/.test(txt)) {
    return { qty: 1, unit: 'unit' };
  }

  // Fallback
  return { qty: 1, unit: 'unit' };
}

/** Convert raw product text → Pantry row (brandless + tidy + smart qty/unit). */
function toPantryRow(
  rawName: string,
  size?: string | null,
  category?: string | null
): { name: string; qty: number; unit: string } {
  const base = brandlessName(rawName || '');
  const normalizedBase = brandlessName(base);
  const clean = tidyCase(normalizedBase);
  const finalName = clean || tidyCase(rawName || '') || 'Item';
  const { qty, unit } = inferQtyUnit(finalName, size ?? undefined, category ?? undefined);
  return { name: finalName, qty, unit };
}

// ---- OCR label picker (Vision + Tesseract friendly) ----

// Words that tell us "this is actual food"
const FOOD_WORD_RE =
  /\b(beans?|kidney|black|pinto|chickpeas?|garbanzo|lentils?|pasta|farfalline|farfalle|fusilli|penne|rigatoni|spaghetti|linguine|fettuccine|orecchiette|radiatori|rotini|noodles?|macaroni|rice|quinoa|oats?|cereal|tomato(es)?|sauce|soup|broth|corn|peas|tuna|salmon|chicken)\b/i;

// Stuff we *don't* want to drive the name
const JUNK_RE =
  /\b(gluten\s*free|sodium\s*free|low\s+sodium|reduced\s+sodium|no\s+salt\s+added|usda|net\s*wt|non[-\s]?gmo|made\s+with|sea\s*salt|ingredients?|nutrition\s+facts|serving\s+size|per\s+container|keep\s+refrigerated|perishable|microwave|stovetop|warning|distributed\s+by|best\s+before|best\s+by|use\s+by|sell\s+by|organic)\b/i;

// Common brand-ish words
const BRAND_RE_LINE =
  /\b(trader\s+joe'?s?|kirkland|costco|barilla|rummo|goya|campbell'?s|heinz)\b/i;

const FOOD_HEAD_RE =
  /\b(kidney\s+beans?|black\s+beans?|pinto\s+beans?|cannellini\s+beans?|garbanzo\s+beans?|chickpeas?|lentils?|pasta|spaghetti|penne|rigatoni|fusilli|farfalle|rice|quinoa|oats?|tomato\s+sauce|tomato\s+soup|broth|stock|corn|peas|tuna|salmon|chicken)\b/i;

const SPECIFIC_PRODUCT_RE =
  /\b(farfalline|farfalle|fusilli|rigatoni|penne|spaghetti|linguine|fettuccine|orecchiette|radiatori|rotini|macaroni|basmati|jasmine|arborio|kidney\s+beans?|black\s+beans?|pinto\s+beans?|cannellini\s+beans?|garbanzo\s+beans?|chickpeas?|lentils?|quinoa|broth|stock|tuna|salmon)\b/i;

const HERITAGE_OR_DESCRIPTOR_RE =
  /\b(product\s+of\s+italy|macaroni\s+product|la\s+pasta\s+di\s+gragnano|dal\s+1789|since\s+\d{4}|est\.?\s*\d{4})\b/i;

const GENERIC_PRODUCT_RE =
  /\b(product|food\s+product|macaroni\s+product)\b/i;

const PACKAGE_NOISE_RE =
  /\b(oz|g|lb|ml|fl\s*oz|net\s*wt|serving|nutrition|ingredients?|distributed|keep|refrigerated|microwave|stovetop|warning|best|sell|use)\b/i;

function countWords(text: string): number {
  return (text.match(/[a-zA-Z]+(?:'[a-zA-Z]+)?/g) || []).length;
}

function scoreOcrCandidate(text: string, foodCount: number, junkCount: number, brandCount: number): number {
  const normalized = text.toLowerCase().trim();
  const wordCount = countWords(normalized);

  let score = 0;

  // Core signal: food words matter most.
  score += foodCount * 8;

  // Prefer concise product-name-like phrases.
  if (wordCount >= 1 && wordCount <= 6) score += 6;
  else if (wordCount <= 9) score += 2;
  else score -= 4;

  // Prefer labels that start or strongly center on the ingredient itself.
  if (FOOD_HEAD_RE.test(normalized)) score += 6;

  // Strongly prefer specific product nouns / pantry names (for example pasta shapes).
  const hasSpecificProduct = SPECIFIC_PRODUCT_RE.test(normalized);
  if (hasSpecificProduct) score += 8;

  // If the candidate is basically just the product name, reward it heavily.
  // This helps single-line names like "FARFALLINE" beat descriptor phrases.
  if (hasSpecificProduct && wordCount <= 2) score += 8;
  else if (hasSpecificProduct && wordCount <= 4) score += 4;

  // Short clean names like “kidney beans” or “organic kidney beans” should win.
  if (/^[a-z0-9' -]{4,60}$/i.test(text)) score += 2;

  // Penalize packaging / nutrition / instruction noise.
  score -= junkCount * 3;
  if (PACKAGE_NOISE_RE.test(normalized)) score -= 3;

  // Penalize heritage / descriptor phrases that are not usually the pantry item name.
  if (HERITAGE_OR_DESCRIPTOR_RE.test(normalized)) score -= 6;

  // Penalize generic "product" wording. This is almost never the best pantry label.
  if (GENERIC_PRODUCT_RE.test(normalized)) score -= 6;

  // Penalize brand-heavy phrases a bit, but not too much.
  score -= brandCount * 2;

  // Penalize very long character strings that are unlikely to be the item name.
  const lenChars = text.length;
  if (lenChars >= 8 && lenChars <= 48) score += 4;
  else if (lenChars > 72) score -= 4;

  // Reward exact/simple ingredient-style names.
  if (/^[a-z]+(?:\s+[a-z]+){0,3}$/i.test(text)) score += 3;

  return score;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(new RegExp(re.source, re.flags + 'g')) || [];
  return m.length;
}

/**
 * Build candidates from rawText:
 *  - derive lines from rawText only (ignore result.lines flattening)
 *  - build 1–3 line combos
 *  - score by "foodness" vs junk/brand
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function pickBestOcrLabel(rawText: string, _lines?: string[]): string {
  const raw = (rawText || '').trim();
  if (!raw) return '';

  // 1) Derive lines from rawText
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!lines.length) return raw;

  // 2) Normalize lines a bit
  const cleanLines = lines.map((s) =>
    s.replace(/\s{2,}/g, ' ').replace(/[–—]/g, '-').trim()
  );

  type Cand = { text: string; score: number };

  const cands: Cand[] = [];

  const n = cleanLines.length;

  // Build 1–3 line combos
  for (let i = 0; i < n; i++) {
    for (let len = 1; len <= 3 && i + len <= n; len++) {
      const slice = cleanLines.slice(i, i + len);
      const text = slice.join(' ').replace(/\s{2,}/g, ' ').trim();
      if (!text) continue;

      const foodCount = countMatches(text, FOOD_WORD_RE);
      const junkCount = countMatches(text, JUNK_RE);
      const brandCount = countMatches(text, BRAND_RE_LINE);
      const hasSpecificProduct = SPECIFIC_PRODUCT_RE.test(text);

      // Keep candidates that either contain general food words
      // or match a specific pantry product name like a pasta shape.
      if (foodCount === 0 && !hasSpecificProduct) continue;

      const score = scoreOcrCandidate(text, foodCount, junkCount, brandCount);

      cands.push({ text, score });
    }
  }

  if (!cands.length) {
    // Fallback: just pick the longest line that has any letters
    const fallback = cleanLines
      .slice()
      .sort((a, b) => b.length - a.length)[0];
    return fallback || raw;
  }

  // Dedupe by lowercase text
  const dedupMap = new Map<string, Cand>();
  for (const c of cands) {
    const k = c.text.toLowerCase();
    const prev = dedupMap.get(k);
    if (!prev || c.score > prev.score) dedupMap.set(k, c);
  }
  const dedup = Array.from(dedupMap.values());

  // Sort best-first. On ties, prefer shorter cleaner names.
  dedup.sort((a, b) => b.score - a.score || a.text.length - b.text.length);

  const best = dedup[0];


  return best?.text || raw;
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
  fd.append('image', file); // <-- matches /api/ocr handler

  const res = await fetch('/api/ocr', { method: 'POST', body: fd });
  if (!res.ok) {
    throw new Error(await res.text());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = await res.json();

  const rawText: string =
    j?.result?.rawText ??
    j?.text ??
    '';

  const linesFromRaw = rawText
    ? rawText.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean)
    : [];

  const lines: string[] =
    j?.result?.lines && Array.isArray(j.result.lines) && j.result.lines.length > 0
      ? j.result.lines
      : linesFromRaw;

  const label = pickBestOcrLabel(rawText, lines);


  if (!label) {
    return [];
  }

  const row = toPantryRow(label);


  return [
    {
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      confidence: 0.9,
      raw: {
        source: 'ocr',
        rawText,
        label,
        normalizedName: row.name,
      },
    },
  ];
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

// Infer a sensible qty + unit for barcode-only items based on the product name.
function inferFromBarcodeName(raw: string): { unit: string; qty: number } {
  const n = postClean(raw).toLowerCase();

  // Pasta / noodles / boxed shapes
  if (/\b(pasta|spaghetti|penne|rigatoni|rigate|farfalle|farfalline|fusilli|noodles?)\b/.test(n)) {
    // Typical pantry pasta bag/box
    return { unit: 'oz', qty: 16 };
  }

  // Canned beans / veg / soup
  if (
    /\b(beans?|chickpeas?|garbanzos?|corn|peas|soup|broth|tomato(es)?|tuna|salmon)\b/.test(n) &&
    (/\b(can|canned)\b/.test(n) || /\btrader joe'?s\b/.test(n))
  ) {
    return { unit: 'can', qty: 1 };
  }

  // Rice / grains
  if (/\b(rice|quinoa|bulgur|couscous)\b/.test(n)) {
    return { unit: 'oz', qty: 16 };
  }

  // Fallback – keep old behavior
  return { unit: 'unit', qty: 1 };
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
  const merged =
    [p?.brand, p?.name].filter(Boolean).join(' ').trim() ||
    `item ${codeOrTerm}`;

  const row = toPantryRow(
    merged,
    p?.size as string | undefined,
    p?.category as string | undefined
  );

  // Start from the row your existing logic produced
   const { name } = row;
   let { qty, unit } = row;

  // If we ended up with the generic "1 unit", try to infer something smarter
  if ((!qty || qty === 1) && (!unit || unit === 'unit')) {
    const inferred = inferFromBarcodeName(merged);
    qty = inferred.qty;
    unit = inferred.unit;
  }

  return {
    name,          // brandless, tidy
    qty,           // smart default (e.g. pasta → 16 oz, beans → 1 can)
    unit,
    confidence: 0.99,
    raw: p ?? j,   // keep original payload for debugging if needed
  };
}