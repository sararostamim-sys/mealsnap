// src/app/api/ocr/route.ts
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { detectTextFromBuffer } from '@/lib/vision';

// Ensure we run in Node (not edge). Tesseract requires Node.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Debug only in dev, or when you explicitly opt-in
const OCR_DEBUG =
  process.env.NODE_ENV !== 'production' || process.env.OCR_DEBUG === '1';

// tiny helper to make calls short
const dbg = (...args: any[]) => { if (OCR_DEBUG) console.log(...args); };

// High-resolution-ish clock that works in Node and edge alike
const nowMs = () => {
  const p: any = (globalThis as any).performance;
  return p?.now ? p.now() : Date.now();
};

// Fast mode: keep OCR lighter in production to avoid timeouts.
// - In production: FAST_MODE = true
// - In dev:        FAST_MODE = false (unless you override with OCR_FAST=1)
const FAST_MODE =
  process.env.NODE_ENV === 'production' ||
  process.env.OCR_FAST === '1';

console.log('[OCR] FAST_MODE =', FAST_MODE, 'NODE_ENV =', process.env.NODE_ENV);

const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 45_000);

/** ---------- Per-attempt OCR timeouts (ms) ---------- */
const STEP_MS_FAST = Number(process.env.OCR_STEP_MS_FAST ?? 2500); // used in FAST mode
const STEP_MS_SLOW = Number(process.env.OCR_STEP_MS_SLOW ?? 5000); // used otherwise

// --- Per-stage fast timeouts (ms). Overridable via env. ---
const STEP_MS_GENERAL_FAST = Number(process.env.OCR_STEP_MS_GENERAL_FAST ?? 900);
const STEP_MS_GENERAL_SLOW = Number(process.env.OCR_STEP_MS_GENERAL_SLOW ?? 1200);

// Safe number parse with default
const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const STEP_MS_BRAND_FAST = num(process.env.OCR_STEP_MS_BRAND_FAST, 450);
const STEP_MS_BRAND_SLOW = num(process.env.OCR_STEP_MS_BRAND_SLOW, 650);
const STEP_MS_SIZE_FAST  = num(process.env.OCR_STEP_MS_SIZE_FAST,  700);
const STEP_MS_SIZE_SLOW  = num(process.env.OCR_STEP_MS_SIZE_SLOW,  900);

dbg('[OCR] timeouts', {
  STEP_MS_FAST, STEP_MS_SLOW,
  STEP_MS_BRAND_FAST, STEP_MS_BRAND_SLOW,
  STEP_MS_SIZE_FAST, STEP_MS_SIZE_SLOW,
});

// NEW: softer per-recognition timeout (brand/size should not block)
const OCR_SOFT_TIMEOUT_MS = Number(process.env.OCR_SOFT_TIMEOUT_MS ?? 6_000);

// NEW: if general text score crosses this, skip brand/size entirely
const GOOD_GENERAL_SCORE = Number(process.env.OCR_GOOD_GENERAL_SCORE ?? 1200);

/** ---------- Resolve absolute Tesseract asset paths (GENERAL & PORTABLE) ---------- */
const require = createRequire(import.meta.url);

// Strip Next’s virtual “(rsc)” segment that can appear in dev paths
function stripRsc(p: string) {
  return p.replace(/[\\/]\(rsc\)(?=[\\/]|$)/g, '');
}

/**
 * Resolve worker/core paths in a bundler-safe way.
 * In Next’s webpack, require.resolve() can return a numeric module id (e.g. 87069),
 * so we must guard on typeof === 'string' before using path.dirname().
 */
let WORKER_RESOLVED: string | null = null;
let CORE_RESOLVED: string | null = null;

try {
  const r = require.resolve('tesseract.js/package.json');
  if (typeof r === 'string') {
    const dir = path.dirname(r);
    WORKER_RESOLVED = stripRsc(
      path.join(dir, 'src/worker-script/node/index.js'),
    );
  }
} catch {
  // best-effort; tesseract.js can fall back to its own defaults
}

try {
  const r = require.resolve('tesseract.js-core/package.json');
  if (typeof r === 'string') {
    const dir = path.dirname(r);
    CORE_RESOLVED = stripRsc(path.join(dir, 'tesseract-core.wasm.js'));
  }
} catch {
  // best-effort
}

/**
 * Build a lang config.
 * IMPORTANT: when local files exist, return a **plain absolute filesystem path** (no file://)
 * and DO NOT set gzip (let tesseract.js decide). Only set gzip when using a CDN.
 */

function ensureTrailingSlash(p: string): string {
  // For HTTP use '/', for FS use path.sep
  if (/^https?:\/\//i.test(p)) return p.endsWith('/') ? p : p + '/';
  return p.endsWith(path.sep) ? p : p + path.sep;
}

function looksHttp(p: string): boolean {
  return /^https?:\/\//i.test(p);
}

function resolveLangConfig(_req: NextRequest): { langPath: string; gzip?: boolean } {
  // 1) Explicit env override (works for FS or HTTP)
  const envPath = process.env.OCR_LANG_PATH;
  if (envPath && envPath.trim()) {
    const langPath = ensureTrailingSlash(envPath.trim());
    // If caller doesn’t specify OCR_LANG_GZIP, make a safe default:
    // - GitHub Raw serves plain .traineddata → gzip=false
    // - Other CDNs (ProjectNaptha) often serve .gz → set OCR_LANG_GZIP=1
    const explicitGzip = process.env.OCR_LANG_GZIP === '1';
    const defaultGzip = looksHttp(langPath) && /raw\.githubusercontent\.com/i.test(langPath) ? false : undefined;

    const gzip = explicitGzip ? true : defaultGzip;
    dbg('[OCR] lang via env', { langPath, gzip: gzip ?? '(unspecified)' });
    return { langPath, gzip };
  }

  // 2) Local FS: public/tessdata
  const dir = path.resolve(process.cwd(), 'public', 'tessdata');
  const gz  = path.join(dir, 'eng.traineddata.gz');
  const raw = path.join(dir, 'eng.traineddata');

  if (fs.existsSync(raw) || fs.existsSync(gz)) {
    const langPath = ensureTrailingSlash(dir);
    const gzip = fs.existsSync(gz); // prefer gz if present
    dbg('[OCR] lang via FS', { langPath, gzip });
    return { langPath, gzip };
  }

  // 3) HTTP fallback: choose best|fast; GitHub Raw (no gzip)
  const variant = (process.env.OCR_LANG_VARIANT || 'best').toLowerCase(); // 'best' | 'fast'
  const base =
    variant === 'fast'
      ? 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/'
      : 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/';

  dbg('[OCR] lang via HTTP fallback', { langPath: base, gzip: false, variant });
  return { langPath: base, gzip: false };
}

/**
 * Normalize any input (URL object, file:// string, relative id, or absolute path)
 * into a plain absolute filesystem path string.
 */
function normalizeFsPath(input: unknown): string {
  if (input && typeof input === 'object' && (input as any).href) {
    return stripRsc(fileURLToPath(input as unknown as URL));
  }
  const s = String(input ?? '');
  if (s.startsWith('file://')) return stripRsc(fileURLToPath(s));
  if (path.isAbsolute(s)) return stripRsc(s);
  try {
    return stripRsc(require.resolve(s));
  } catch {
    return stripRsc(path.resolve(process.cwd(), s));
  }
}

type TessBaseOpts = {
  workerPath?: string;
  corePath?: string;
  cachePath: string;
};

const TESS_OPTS_BASE: TessBaseOpts = {
  // langPath is per-request; see getWorker(req)
  cachePath: '/tmp',
};

if (WORKER_RESOLVED) {
  TESS_OPTS_BASE.workerPath = normalizeFsPath(WORKER_RESOLVED);
}
if (CORE_RESOLVED) {
  TESS_OPTS_BASE.corePath = normalizeFsPath(CORE_RESOLVED);
}

// Dev-only debug to confirm what the server is using
if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] workerPath (string):', TESS_OPTS_BASE.workerPath ?? '(default)');
  dbg('[OCR] corePath   (string):', TESS_OPTS_BASE.corePath ?? '(default)');
}

/** ---------- Helpers ---------- */
function withTimeout<T>(p: Promise<T>, ms = OCR_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('ocr-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

function withTimeoutL<T>(p: Promise<T>, label: string, ms = OCR_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`ocr-timeout at ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

function withTimeoutSoft<T>(p: Promise<T>, label: string, ms = OCR_SOFT_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      console.warn(`[OCR] soft-fail ${label} timed out at ${ms}ms`);
      resolve(null);
    }, ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); console.warn(`[OCR] soft-fail ${label}`, e?.message ?? e); resolve(null); },
    );
  });
}

// Soft-try a single recognize call. On timeout/error, log and return null so callers can continue.
async function tryRecognize(
  worker: TWorker,
  img: Buffer | Uint8Array | string,
  options: Record<string, any>,
  label: string,
  ms?: number
): Promise<string | null> {
  try {
    const { data }: any = await withTimeoutL(
      recognizeSafe(worker, img, cfg({ oem: 1, ...options })),
      label,
      ms ?? (FAST_MODE ? STEP_MS_FAST : STEP_MS_SLOW),
    );
    if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] got text', label, '→', (data?.text || '').split(/\n/).slice(0, 6));
}
    const t = clean(data?.text || '');
    return t || null;
  } catch (e: any) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[OCR] soft-fail', label, e?.message ?? e);
    }
    return null;
  }
}

// Write a JPEG to /tmp and return its absolute path
async function writeTempJpeg(buf: Buffer): Promise<string> {
  const fname = `ocr-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const fpath = path.join(os.tmpdir(), fname);
  await fs.promises.writeFile(fpath, buf);
  return fpath;
}

// Best-effort cleanup
async function safeUnlink(p?: string) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* ignore */ }
}

// quick HEIC sniffers to avoid sharp “heif plugin not built” errors
function looksHeicByNameOrType(name?: string | null, type?: string | null) {
  const n = (name || '').toLowerCase();
  const t = (type || '').toLowerCase();
  return n.endsWith('.heic') || n.endsWith('.heif') || t.includes('heic') || t.includes('heif');
}
function looksHeicByMagic(buf: Buffer) {
  const head = buf.subarray(0, 64).toString('latin1');
  return head.includes('ftypheic') || head.includes('ftypheif');
}

/** ---------------- Worker lifecycle (per request) ---------------- */
type TWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

/** ---------- SAFE HELPERS ---------- */
const LANG = 'eng';

function cfg<T extends Record<string, any>>(o: T) { return o as any; }

const detectSafe = (w: TWorker, img: Buffer | Uint8Array | string) =>
  (w as any).detect ? (w as any).detect(img) : Promise.resolve({ data: { orientation: { degrees: 0 } } });

// IMPORTANT: do NOT pass { lang: ... } here.
const recognizeSafe = (
  w: TWorker,
  img: Buffer | Uint8Array | string,
  options?: Record<string, any>
) => (w as any).recognize(img, { ...(options || {}) });

// --- Brand helpers: pre-shrink + short step budgets (do not place inside a function) ---
async function downscaleIfNeeded(buf: Buffer, maxW = 900): Promise<Buffer> {
  try {
    const m = await sharp(buf).metadata();
    if ((m.width || 0) <= maxW) return buf;
    return await sharp(buf).resize({ width: maxW, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
  } catch {
    return buf;
  }
}

// Return 2 quick, cheap variants of a crop to help hard labels:
//  - thresholded
//  - thresholded + inverted
async function lineVariants(buf: Buffer, thr = 170): Promise<{thresh: Buffer; invert: Buffer}> {
  const base = await sharp(buf).grayscale().normalise().jpeg({ quality: 90 }).toBuffer();
  const thresh = await sharp(base).threshold(thr).jpeg({ quality: 90 }).toBuffer();
  const invert = await sharp(thresh).negate().jpeg({ quality: 90 }).toBuffer();
  return { thresh, invert };
}

// Crop a horizontal band by percentage (e.g., 0.35–0.72 ~ middle of the label)
async function cropBandPct(buf: Buffer, topPct: number, bottomPct: number): Promise<Buffer> {
  try {
    const m = await sharp(buf).metadata();
    const W = m.width ?? 0, H = m.height ?? 0;
    if (W <= 0 || H <= 0) return buf;
    const top = Math.max(0, Math.floor(H * topPct));
    const bottom = Math.max(top + 1, Math.floor(H * bottomPct));
    const height = Math.max(1, bottom - top);
    return await sharp(buf).extract({ left: 0, top, width: W, height }).toBuffer();
  } catch {
    return buf;
  }
}

// Binarize for "white text on colored background" (general and cheap)
async function binarizeWhiteOnColor(buf: Buffer): Promise<Buffer> {
  try {
    // Grayscale, normalize contrast, slight sharpen, then threshold
    return await sharp(buf)
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(170)          // pushes colored background down, keeps white letters
      .toFormat('png')
      .toBuffer();
  } catch {
    return buf;
  }
}

/* ====================================== */

// ===== helpers stay above this (LANG, cfg, detectSafe, recognizeSafe, writeTempJpeg, safeUnlink) =====

async function getWorker(req: NextRequest): Promise<TWorker> {
  const { createWorker } = await import('tesseract.js');

  // Log exact versions (optional)
  try {
    const tjsPkg = require('tesseract.js/package.json');
    const corePkg = require('tesseract.js-core/package.json');
    dbg('[OCR] tesseract.js version =', tjsPkg.version, '| core =', corePkg.version);
  } catch {}

  const { langPath, gzip } = resolveLangConfig(req);
  const isFs = path.isAbsolute(langPath);

  if (process.env.NODE_ENV !== 'production') {
    dbg(
      `[OCR] langPath (${isFs ? 'fs' : 'http'}): "${langPath}" | endsWithSlash=${langPath.endsWith(path.sep)}${isFs ? '' : ` | gzip=${String(gzip)}`}`
    );
  }

  // Guard: FS path must end with slash
  if (isFs && !langPath.endsWith(path.sep)) {
    throw new Error(`langPath for FS must end with "${path.sep}". Got: ${langPath}`);
  }

// Build Tesseract options without passing undefined paths
const baseOpts: any = {
  langPath,                            // normalized with trailing slash
  cachePath: TESS_OPTS_BASE.cachePath,
  ...(typeof gzip === 'boolean' ? { gzip } : {}), // only set if we actually know true/false
};

// Only include worker/core paths if they’re actually defined.
// On Vercel these may be undefined, and that would break new Worker(...)
if (TESS_OPTS_BASE.workerPath) {
  baseOpts.workerPath = TESS_OPTS_BASE.workerPath;
}
if (TESS_OPTS_BASE.corePath) {
  baseOpts.corePath = TESS_OPTS_BASE.corePath;
}

dbg('[OCR] createWorker opts =', baseOpts);

// Set gzip explicitly based on resolveLangConfig()
// (works for both FS and HTTP; true -> use .gz, false -> use raw file)
if (typeof gzip === 'boolean') {
  baseOpts.gzip = gzip;
}

  if (process.env.NODE_ENV !== 'production') {
    dbg('[OCR] createWorker opts = {',
      `\n  workerPath: '${baseOpts.workerPath}',`,
      `\n  corePath: '${baseOpts.corePath}',`,
      `\n  langPath: '${baseOpts.langPath}',`,
      `\n  gzip: ${baseOpts.gzip ?? '(unset)'},`,
      `\n  cachePath: '${baseOpts.cachePath}'\n}`,
    );
  }

  const worker: any = await createWorker(baseOpts);

  // Shim: coerce language args to array
  const _load = worker.loadLanguage?.bind(worker);
  const _init = worker.initialize?.bind(worker);
  worker.loadLanguage = (langs: any) => {
    const coerced = Array.isArray(langs) ? langs : [langs];
    if (process.env.NODE_ENV !== 'production') {
      dbg('[OCR] loadLanguage coerced ->', coerced, '| typeof=', typeof langs, '| isArray=', Array.isArray(langs));
    }
    return _load(coerced);
  };
  worker.initialize = (langs: any) => {
    const coerced = Array.isArray(langs) ? langs : [langs];
    if (process.env.NODE_ENV !== 'production') {
      dbg('[OCR] initialize coerced ->', coerced, '| typeof=', typeof langs, '| isArray=', Array.isArray(langs));
    }
    return _init(coerced);
  };

  // Initialize once – no { lang: ... } anywhere else
  await worker.loadLanguage(['eng']);
  await worker.initialize(['eng']);

  return worker as TWorker;
}

async function withWorker<T>(req: NextRequest, fn: (w: TWorker) => Promise<T>): Promise<T> {
  const w = await getWorker(req);
  try {
    return await fn(w);
  } finally {
    await (w as any).terminate().catch(() => {});
  }
}

/** ---------------- Tesseract configs (unchanged) ---------------- */
type TessWord = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
};
type TessData = { text?: string; words?: TessWord[]; orientation?: { degrees?: number } };

type Box = { left: number; top: number; width: number; height: number };
const clamp = (b: Box, W: number, H: number): Box => ({
  left: Math.max(0, Math.min(b.left, W - 1)),
  top: Math.max(0, Math.min(b.top, H - 1)),
  width: Math.max(40, Math.min(b.width, W - b.left)),
  height: Math.max(40, Math.min(b.height, H - b.top)),
});
const clean = (t: string) => (t || '').replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

// Drop a trailing 1–2 char junk token (common OCR tail like "lu", "iu")
function stripGarbageTail(s: string): string {
  // keep legit two-char words if they’re food/units; otherwise drop
  const KEEP = /^(oz|lb|ml|gm|kg)$/i;
  const parts = s.trim().split(/\s+/);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1];
    if (tail.length <= 2 && !KEEP.test(tail)) {
      parts.pop();
      return parts.join(' ');
    }
  }
  return s;
}

// ---- improved normalizer: edge cleanup → collapse → tail trim → OCR fixes → fuzzy fix ----
function postClean(s: string) {
  if (!s) return '';
  let t = s.trim();

  // Remove a single wrapping pair of parentheses, if present
  t = t.replace(/^\((.+)\)$/, '$1');

  // Strip non-alphanumeric chars at the edges only (ASCII-safe)
  t = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

  // Collapse multiple spaces
  t = t.replace(/\s{2,}/g, ' ').trim();

  // Drop tiny garbage tails like "iu"/"lu" that cling to good lines
  t = stripGarbageTail(t);

  // === OCR pattern fixes (whole-line) ===
  t = t
    // “0rganic” / “organic” near misses
    .replace(/\b0rganic\b/gi, 'Organic')
    .replace(/\borgani[cg]\b/gi, 'Organic')
    // 0 vs O only in acronym-looking contexts (avoid touching sizes)
    .replace(/\b0(?=[A-Z]{2,}\b)/g, 'O')
    // 1 at word start → l (e.g., “1b” → “lb”)
    .replace(/(^|\b)1([a-z])/g, (_, p, c) => p + 'l' + c)
    // 5 between letters → S
    .replace(/([A-Za-z])5([A-Za-z])/g, '$1S$2')
    // Drop stray 1–2 letter tails like “lu”, “iu”, “sx”
    .replace(/[^\p{L}\p{N}][A-Za-z]{1,2}$/u, '')
    // Normalize spaces again after edits
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Tiny fuzzy post-correction (e.g., "Trader Joese lu" → "Trader Joe's")
  t = fuzzyFixLine(t);

  // Final trim
  return t.trim();
}

function stripBrandOnce(name: string, brand: string) {
  if (!name || !brand) return name;
  const rx = new RegExp('\\b' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return name.replace(rx, '').replace(/\s{2,}/g, ' ').trim();
}

// --- Tiny fuzzy post-correction helpers (generic, safe) ---
// Extend as you like; keep items lowercase except brand with apostrophe.
const FUZZY_TOKENS = [
  'organic','kidney','beans','bean','made','with','sea','salt','brown','rice','fusilli',
  'pasta','tomato','sauce','broth','chicken','beef','oats','cereal','olive','oil','black',
  'trader', "joe's", "trader joe's",
];

function normApos(s: string) {
  return s.replace(/[’‘]/g, "'").toLowerCase();
}

function editDist(a: string, b: string): number {
  a = normApos(a); b = normApos(b);
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;            // cheap cutoff
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const keep = prev + (a[i - 1] === b[j - 1] ? 0 : 1);
      const ins  = dp[j] + 1;
      const del  = dp[j - 1] + 1;
      prev = dp[j];
      dp[j] = Math.min(keep, ins, del);
    }
  }
  return dp[n];
}

function fuzzyFixLine(s: string): string {
  const toks = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of toks) {
    const bare = tok.replace(/[^A-Za-z']/g, '');
    if (bare.length < 3) { out.push(tok); continue; }

    let best = bare, bestD = 3;
    for (const cand of FUZZY_TOKENS) {
      const d = editDist(bare, cand);
      if (d <= 2 && d < bestD) { bestD = d; best = cand; if (d === 0) break; }
    }

    // Brand casing; otherwise simple title case.
    const fixed = best === "trader joe's" ? "Trader Joe's"
                 : best.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    out.push(fixed);
  }
  return out.join(' ');
}

// Words that indicate the actual food (reuse the one you already declared)
const FOODISH = /\b(beans?|kidney|black|pinto|pasta|fusilli|noodles?|rice|quinoa|tomato|sauce|lentils?|soup|chickpeas?|corn|peas|broth|olive|oil|tuna|salmon|peanut|butter)\b/i;

// Final touch-ups for common label artifacts
function polishFoodLine(s: string): string {
  let t = s;

  // 1) "AN"/"A N" at the start is a common OCR fracture of "ORGANIC"
  //    Only do this when the line actually looks like food
  if (!/\borganic\b/i.test(t) && FOODISH.test(t)) {
    t = t.replace(/^(?:\bA\s*N\b|\bAN\b)\s+/i, 'Organic ');
  }

  // 2) Drop a trailing single-letter token like "L" or "S" that leaks from next line
  t = t.replace(/\b[A-Za-z]\)?$/g, '').trim();

  // Tidy spaces
  t = t.replace(/\s{2,}/g, ' ').trim();

  return t;
}

// after postClean(...) and before score(...)

// Map common OCR confusions and tidy spacing
function denoiseLine(s: string): string {
  return (s || '')
    .replace(/[\\\/]+/g, ' ')
    .replace(/(?<=\p{L})0(?=\p{L})/gu, 'O')
    .replace(/(?<=\p{L})1(?=\p{L})/gu, 'I')
    .replace(/(?<=\p{L})5(?=\p{L})/gu, 'S')
    .replace(/(?<=\p{L})6(?=\p{L})/gu, 'G')
    .replace(/(?<=\p{L})8(?=\p{L})/gu, 'B')
    .replace(/(?<=\p{L})4(?=\p{L})/gu, 'A')
    .replace(/\|/g, 'I')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Gate: keep only lines that look like real words
function looksLikeWordy(s: string): boolean {
  const t = (s || '').trim();
  if (!t) return false;

  // Unicode-aware counts
  const letters = (t.match(/\p{L}/gu) || []).length;
  const digits  = (t.match(/\p{N}/gu) || []).length;

  // Bad chars = not letter/number/dash/space/apostrophe/&
  const bad = (t.match(/[^\p{L}\p{N}\-\s'&]/gu) || []).length;

  const len = t.length;
  if (len < 4) return false;
  if (letters / Math.max(1, len) < 0.55) return false;
  if (digits  / Math.max(1, len) > 0.25) return false;
  if (bad     / Math.max(1, len) > 0.15) return false;

  // Reject "spaced letters" like "N s a S i" / "Ns a Si"
  if (/^(?:\p{L}{1,2}\s+){1,6}\p{L}{1,2}$/u.test(t)) return false;

  return true;
}

function score(t: string) {
  const s = (t || '').toLowerCase().trim();
  if (!s) return -1_000_000;

  // Keep your original unigram/bigram signals (slightly expanded)
  const uni =
    (s.match(
      /\b(trader|joe'?s|brown|rice|quinoa|fusilli|pasta|organic|bean[s]?|kidney|black|pinto|organics|tomato|sauce|can|canned)\b/g
    ) || []).length;

  const big = [
    /brown\s+rice/i,
    /gluten[-\s]+free/i,
    /quinoa\s+fusilli/i,
    /net\s*wt/i,
    /red\s+kidney\s+beans?/i,
    /o\s*organics/i,
    /trader\s+joe'?s/i,
  ].reduce((n, rx) => n + (rx.test(s) ? 1 : 0), 0);

  // Character-level signals
  const letters = (s.match(/[a-z]/gi) || []).length;
  const digits  = (s.match(/\d/gi) || []).length;
  const vowels  = (s.match(/[aeiou]/gi) || []).length;
  const garbage = (s.match(/[^a-z0-9&' \-\/,.\n():]/gi) || []).length;

  // Base score (your original weighting)
  let score = big * 500 + uni * 120 + letters - garbage * 30;

  // --- General penalties to suppress noisy/junky lines ---

  // Too numeric? (e.g., “NET WT 15 OZ” style lines)
  const alphaNum = letters + digits;
  if (alphaNum > 0 && digits / alphaNum > 0.25) score -= 120;

  // Low vowel ratio: OCR junk like “Ns a Si S an Yo Sx” gets penalized
  if (letters > 0 && vowels / letters < 0.28) score -= 200;

  // Trailing 1–2 char garbage token (unless it's a legit unit)
  const tokens = s.split(/\s+/);
  const last   = tokens[tokens.length - 1] || '';
  const KEEP_UNITS = /^(oz|lb|ml|gm|kg|g)$/i;
  if (tokens.length > 1 && last.length <= 2 && !KEEP_UNITS.test(last)) {
    score -= 180;
  }

  // --- Soft bonuses for good food-y phrases ---
  if (/kidney\s+beans?/i.test(s)) score += 200;
  if (/organic\s+beans?/i.test(s)) score += 150;
  if (/organic\s+kidney/i.test(s)) score += 250;

  return score;
}

function extractBestLine(raw: string): string {
  if (!raw) return '';

  const SIZE_LIKE   = /\b(net\s*wt|net\s*weight|ounce|oz|lb|g|gram|grams|ml|serving|calories|% daily value)\b/i;
  const BOILER      = /\b(made\s+with(?:\s+\w+){0,3}|sea\s*salt|ingredients?|nutrition|per\s+serv(?:ing)?)\b/i;

  // NEW: food words + “inner boilerplate” we strip instead of dropping the line
  const FOODISH       = /\b(beans?|kidney|black|pinto|pasta|fusilli|noodles?|rice|quinoa|tomato|sauce|lentils?|soup|chickpeas?|corn|peas|broth|olive|oil|tuna|salmon|peanut|butter)\b/i;
  const BOILER_INNER  = /\b(made\s+with(?:\s+\w+){0,3}|sea\s*salt)\b/gi;

  const lines = raw
    .split(/\n+/)
    .map(s => postClean(clean(denoiseLine(s))))
    .map(s => s.replace(BOILER_INNER, '').replace(/\s{2,}/g, ' ').trim())  // <- strip inner boilerplate
    .map(s => s.trim())
    .filter(Boolean)
    .filter(looksLikeWordy)
    .filter(s => !SIZE_LIKE.test(s) && !BOILER.test(s));

  if (!lines.length) return '';

  // bias slightly toward lines that contain foodish words
  lines.sort((a, b) => {
    const fa = FOODISH.test(a) ? 1 : 0;
    const fb = FOODISH.test(b) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return score(b) - score(a) || b.length - a.length;
  });
  return lines[0];
}

// Merge "Organic" + a food line that might be on the next line
function maybeMergeFoodPair(lines: string[]): string {
  const organicIdx = lines.findIndex((s) => /\borganic\b/i.test(s));
  const foodIdx = lines.findIndex((s) =>
    /\b(beans?|pasta|rice|sauce|tomato|soup|lentils?|chickpeas?|corn|peas|broth|oats?)\b/i.test(s)
  );

  if (organicIdx !== -1 && foodIdx !== -1 && organicIdx !== foodIdx) {
    return postClean(`${lines[organicIdx]} ${lines[foodIdx]}`);
  }
  return '';
}

const CFGS_GENERAL: Array<Record<string, string | number>> = [
  {
    tessedit_pageseg_mode: '6',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&' -/,.%()",
  },
  {
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&' -/,.%()",
  },
];
const CFGS_SIZE_ONLY: Array<Record<string, string | number>> = [
  {
    tessedit_pageseg_mode: '6',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: 'NETWT0123456789OZFLLBGS() ./:kgmlKGMLozlb',
  },
  {
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: '0123456789OZFL LBGS() ./:kgmlKGMLozlb',
  },
];
const CFGS_BRAND_ONLY: Array<Record<string, string | number>> = [
  {
    tessedit_pageseg_mode: '7',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
  },
  {
    tessedit_pageseg_mode: '11',
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
  },
];

/** ---------------- image variant builder ---------------- */
async function buildVariants(input: Buffer, worker: TWorker, _req: NextRequest) {
  // smaller = faster; EXIF rotate
  const baseBuf = await sharp(input)
  .rotate()
  .removeAlpha()
  .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: false })
  .jpeg({ quality: 90 })
  .toBuffer();

  let img = sharp(baseBuf);
  if (!FAST_MODE) {
  try {
    const det: any = await withTimeoutL(detectSafe(worker, baseBuf), 'detect:orientation');
    const deg = Math.round(((det?.data?.orientation?.degrees ?? 0) / 90) * 90);
    img = img.rotate(deg);
  } catch { /* best effort */ }
}

  const meta = await img.metadata();
  const W = meta.width || 1200;
  const H = meta.height || 1600;

  const top = clamp({ left: 0, top: Math.round(H * 0.06), width: W, height: Math.round(H * 0.26) }, W, H);
  const mid = clamp({ left: 0, top: Math.round(H * 0.42), width: W, height: Math.round(H * 0.22) }, W, H);
  const low = clamp({ left: 0, top: Math.round(H * 0.62), width: W, height: Math.round(H * 0.18) }, W, H);
  const center = clamp(
    { left: Math.round(W * 0.15), top: Math.round(H * 0.15), width: Math.round(W * 0.7), height: Math.round(H * 0.7) },
    W,
    H,
  );
  const sizeBox = clamp(
    { left: Math.round(W * 0.6), top: Math.round(H * 0.7), width: Math.round(W * 0.36), height: Math.round(H * 0.25) },
    W,
    H,
  );
  const brandBox = clamp({ left: Math.round(W * 0.15), top: 0, width: Math.round(W * 0.7), height: Math.round(H * 0.3) }, W, H);

  const mk = (s: sharp.Sharp) => s.jpeg({ quality: 94 }).toBuffer();
  const general: Buffer[] = [],
    sizeOnly: Buffer[] = [],
    brandOnly: Buffer[] = [];

  const add = async (
    which: 'general' | 'size' | 'brand',
    b: Box,
    opts: { thresh?: number; negate?: boolean; sharpen?: number; gray?: boolean } = {},
  ) => {
    let s = img.clone().extract(b);
    if (opts.gray !== false) s = s.grayscale();
    s = s.normalise();
    if (opts.thresh) s = s.threshold(opts.thresh);
    if (opts.negate) s = s.negate();
    if (opts.sharpen) s = s.sharpen(opts.sharpen);
    const buf = await mk(s);
    (which === 'general' ? general : which === 'size' ? sizeOnly : brandOnly).push(buf);
  };

  // GENERAL
await add('general', { left: 0, top: 0, width: W, height: H }, { sharpen: 1 });
// In FAST mode, stop here (single pass). Non-FAST keeps your existing extras.
if (!FAST_MODE) {
  await add('general', top, { sharpen: 1.2 });
  await add('general', mid, { sharpen: 1.2 });
  await add('general', low, { sharpen: 1.2 });
  await add('general', center, { sharpen: 1 });
  await add('general', mid, { thresh: 170 });
  await add('general', low, { thresh: 170 });
  await add('general', { left: 0, top: 0, width: W, height: H }, { thresh: 170 });
}

// SIZE
await add('size', sizeBox, { thresh: 160 });
if (!FAST_MODE) await add('size', sizeBox, { thresh: 180, negate: true });

// BRAND
await add('brand', brandBox, { sharpen: 1.3 });
if (!FAST_MODE) {
  await add('brand', brandBox, { thresh: 170 });
  await add('brand', brandBox, { thresh: 180, negate: true });
}

  const orientedFull = await mk(img.clone());
  return { general, sizeOnly, brandOnly, orientedFull, W, H };
}

/** ---------------- ROI helpers (use worker) ---------------- */
async function findSizeROIs(fullJpeg: Buffer, W: number, H: number, worker: TWorker) {
  const { data }: any = await withTimeout(
    recognizeSafe(worker, fullJpeg, cfg({
      oem: 1,
      tessedit_pageseg_mode: '6',
      user_defined_dpi: '300',
      preserve_interword_spaces: '1',
    })),
  );
  const words: TessWord[] = (data?.words || []) as TessWord[];

  const anchors = words
    .map((w): TessWord & { score: number } => {
      const t = (w.text || '').toLowerCase();
      const isNum = /^\d{1,4}(\.\d+)?$/.test(t);
      const unit = /\b(fl|net|wt|oz|lb|g|gram|grams|ml)\b/.test(t) || /oz|lb|g|ml/.test(t);
      const bonus =
        (/\bnet\b/.test(t) ? 3 : 0) +
        (/\bwt\b/.test(t) ? 3 : 0) +
        (/\boz\b/.test(t) ? 2 : 0) +
        (/\blb\b/.test(t) ? 2 : 0) +
        (/\bg\b/.test(t) ? 1 : 0) +
        (/\bfl\b/.test(t) ? 1 : 0);
      const sc = (isNum ? 1 : 0) + (unit ? 1 : 0) + bonus + (w.confidence || 0) / 50;
      return { ...w, score: sc };
    })
    .filter((w) => w.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const boxes: Box[] = [];
  for (const a of anchors) {
    const x0 = Math.max(0, a.bbox.x0 - 40);
    const y0 = Math.max(0, a.bbox.y0 - 40);
    const x1 = Math.min(W, a.bbox.x1 + 220);
    const y1 = Math.min(H, a.bbox.y1 + 160);
    boxes.push(clamp({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }, W, H));
    if (boxes.length >= 3) break;
  }
  return boxes;
}

async function makeSizeROIVariants(base: Buffer, rois: Box[]) {
  const out: Buffer[] = [];
  for (const b of rois) {
    const crop = sharp(base)
      .extract(b)
      .grayscale()
      .normalise()
      .resize({
        width: Math.min(1200, b.width * 2),
        height: Math.min(800, b.height * 2),
        fit: 'inside',
        withoutEnlargement: false,
      });
    const baseBuf = await crop.jpeg({ quality: 96 }).toBuffer();
    out.push(baseBuf);
    out.push(await sharp(baseBuf).threshold(160).jpeg({ quality: 96 }).toBuffer());
    if (!FAST_MODE) {
      out.push(await sharp(baseBuf).threshold(180).negate().jpeg({ quality: 96 }).toBuffer());
      for (const deg of [-6, -3, 3, 6]) {
        out.push(await sharp(baseBuf).rotate(deg).jpeg({ quality: 96 }).toBuffer());
        out.push(await sharp(baseBuf).rotate(deg).threshold(170).jpeg({ quality: 96 }).toBuffer());
      }
    }
  }
  return FAST_MODE ? out.slice(0, 4) : out.slice(0, 24);
}

/** ---------------- recognizers (use worker) ---------------- */
async function recognizeGeneral(bufs: Buffer[], worker: TWorker) {
  if (!bufs.length) return [];

  if (FAST_MODE) {
  // Lightly normalize and bound
  const b0 = await downscaleIfNeeded(bufs[0], 900);

  // First shot: PSM 6
  let raw = await tryRecognize(
    worker,
    b0,
    {
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -",
    },
    'recognize:general:fast-psm6',
    STEP_MS_SIZE_FAST
  );

  // Second shot (still short): PSM 7 single-line
  if (!raw) {
    raw = await tryRecognize(
      worker,
      b0,
      {
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -",
      },
      'recognize:general:fast-psm7',
      STEP_MS_SIZE_FAST
    );
  }

  // If both shots failed, give up fast.
  if (!raw) return [];

  // Split the paragraph into *lines*, normalize, score and keep the top few.
  const seen = new Set<string>();
  const lines = raw
    .split(/\n+/)
    .map((s) => postClean(clean(denoiseLine(s)))) // includes fuzzy fixes
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(looksLikeWordy)                        // drop junky lines
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
    .sort((a, b) => score(b) - score(a) || b.length - a.length)
    .slice(0, 5);

    if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] FAST general raw→lines', {
    rawFirst6: (raw || '').split('\n').slice(0, 6),
    linesTop5: lines.slice(0, 5),
  });
}

  return lines;
}

  const out: string[] = [];
  for (const [i, b] of bufs.slice(0, 3).entries()) {
    for (const [j, cfgItem] of CFGS_GENERAL.slice(0, 2).entries()) {
      const t = await tryRecognize(
        worker,
        b,
        { ...cfgItem, oem: 1 },
        `recognize:general:${i}:${j}`
      );
      if (t) out.push(t);
    }
  }

  // Clean → gate → dedupe → sort by score (then length) → top 5
  const cleaned = Array.from(
    new Set(
      out
        .map((x) => postClean(clean(denoiseLine(x))))
        .filter(looksLikeWordy)
    )
  );

  const sorted = cleaned.sort((a, b) => score(b) - score(a) || b.length - a.length);
  return sorted.slice(0, 5);
}

// Accept Buffer **or** file path for variants
async function recognizeBrand(bufs: Buffer[], worker: TWorker) {
  if (!bufs.length) return '';

  // Use only the first brand crop; keep work bounded.
  let b0 = bufs[0];

  // Pre-shrink to keep Tesseract snappy on high-res images
  b0 = await downscaleIfNeeded(b0, 900);

  // 1) Quick single-line read (PSM 7), plain → thresh → invert
const psm7Plain = await tryRecognize(
  worker, b0,
  {
    tessedit_pageseg_mode: '7',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
    user_defined_dpi: '300',
  },
  'recognize:brand:psm7-plain',
  STEP_MS_BRAND_FAST
);

if (psm7Plain) return postClean(psm7Plain);

const { thresh: b7, invert: b7i } = await lineVariants(b0, 170);

const psm7Thresh = await tryRecognize(
  worker, b7,
  {
    tessedit_pageseg_mode: '7',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
    user_defined_dpi: '300',
  },
  'recognize:brand:psm7-thresh',
  STEP_MS_BRAND_FAST
) ?? await tryRecognize(
  worker, b7i,
  {
    tessedit_pageseg_mode: '7',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
    user_defined_dpi: '300',
  },
  'recognize:brand:psm7-invert',
  STEP_MS_BRAND_FAST
);

if (psm7Thresh) return postClean(psm7Thresh);

  // 2) Sparse fallback (PSM 11) on a smaller buffer; still tightly bounded
  const small = await sharp(b0).resize({ width: 700, fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  const psm11 = await tryRecognize(
    worker,
    small,
    {
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz&' -",
      user_defined_dpi: '300',
    },
    'recognize:brand:psm11-fallback',
    STEP_MS_BRAND_SLOW
  );

  return postClean(psm11 || '');
}

async function recognizeSize(bufs: Buffer[], worker: TWorker) {
  if (!bufs.length) return '';

  // FAST: one bounded attempt
  // FAST: one bounded attempt
if (FAST_MODE) {
  const t = await tryRecognize(
    worker,
    bufs[0],
    { tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' },
    'recognize:size:fast-psm6',
    STEP_MS_SIZE_FAST
  );
  return t ?? '';
}

  // Non-FAST: at most 2 bufs × 2 cfgs; early-exit once we have 2 hits.
  const texts = new Set<string>();
  const bufsToTry = bufs.slice(0, 2);
  const cfgsToTry = CFGS_SIZE_ONLY.slice(0, 2);

  for (const [i, b] of bufsToTry.entries()) {
    for (const [j, cfgItem] of cfgsToTry.entries()) {
      const t = await tryRecognize(
        worker,
        b,
        { ...cfgItem, oem: 1 },
        `recognize:size:${i}:${j}`,
        STEP_MS_SIZE_SLOW
      );
      if (t) {
        texts.add(t);
        if (texts.size >= 2) return Array.from(texts).join('\n'); // early-exit
      }
    }
  }

  return Array.from(texts).join('\n');
}

/** ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const mark = (label: string) => {
    console.log(`[OCR] ${label} @`, Date.now() - t0, 'ms');
  };
  try {
    const form = await req.formData();
    const file = form.get('image') as File | null;
    if (!file) {
      return NextResponse.json({ ok: false, error: 'No file provided' }, { status: 400 });
    }

    const fileBuf = Buffer.from(await file.arrayBuffer());

    // Gracefully reject HEIC/HEIF to avoid libvips/heif runtime issues
    if (looksHeicByNameOrType(file.name, (file as any)?.type) || looksHeicByMagic(fileBuf)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'unsupported_image_type',
        },
        { status: 415 },
      );
    }

    const text = await withWorker(req, async (worker) => {
      const { general, sizeOnly, brandOnly, orientedFull, W, H } = await buildVariants(fileBuf, worker, req);

      // ROI pass only in non-FAST mode
      let roiVariants: Buffer[] = [];
if (false && !FAST_MODE) {  // TEMP: disable ROI seed pass to avoid timeouts
  try {
    const rois = await findSizeROIs(orientedFull, W, H, worker);
    if (rois.length) roiVariants = await makeSizeROIVariants(orientedFull, rois);
  } catch {
    /* best-effort */
  }
}

     // If we're in FAST mode, feed tesseract a FILE PATH for the first general image.
// This avoids occasional WASM stalls on Buffer decoding in node.
// ----- Prepare FAST-mode inputs as file paths for first variants -----
// ----- Prepare FAST-mode inputs as file paths for first variants -----
let tmpGeneralPath: string | undefined;
let tmpBrandPath:   string | undefined;
let tmpSizePath:    string | undefined;

let generalInput: Array<Buffer | string> = general;
let brandInput:   Array<Buffer | string> = brandOnly;
let sizeInput:    Array<Buffer | string> = sizeOnly;

if (FAST_MODE) {
  if (general.length > 0 && Buffer.isBuffer(general[0])) {
    try { tmpGeneralPath = await writeTempJpeg(general[0]); generalInput = [tmpGeneralPath]; } catch {}
  }
  if (brandOnly.length > 0 && Buffer.isBuffer(brandOnly[0])) {
    try { tmpBrandPath = await writeTempJpeg(brandOnly[0]); brandInput = [tmpBrandPath]; } catch {}
  }
  if (sizeOnly.length > 0 && Buffer.isBuffer(sizeOnly[0])) {
    try { tmpSizePath = await writeTempJpeg(sizeOnly[0]); sizeInput = [tmpSizePath]; } catch {}
  }
}

// ----- OCR in parallel -----
// Do general first; if strong, skip brand/size to return fast
const generalTextTop5 = await recognizeGeneral(general, worker);
mark('recognizeGeneral done');
const bestGeneral = generalTextTop5?.[0] ?? '';
const generalScore = score(bestGeneral);

let brandText = '';
if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] assembly inputs', {
    generalTop5: generalTextTop5,
    brandText,
  });
}
let sizeGuessText = '';
let sizeRoiText = '';

if (generalScore < GOOD_GENERAL_SCORE) {
  const [b, s1, s2] = await Promise.all([
    recognizeBrand(brandOnly, worker),
    recognizeSize(sizeOnly, worker),
    roiVariants.length ? recognizeSize(roiVariants, worker) : Promise.resolve(''),
  ]);
  brandText    = postClean(b || '');
  sizeGuessText = s1 || '';
  sizeRoiText   = s2 || '';
  mark('brand/size recognitions done');
}

// ----- Cleanup temp files -----
await safeUnlink(tmpGeneralPath);
await safeUnlink(tmpBrandPath);
await safeUnlink(tmpSizePath);

// Build one blob for ranking, then pick the single best line.
const blobForName = [
  ...(generalTextTop5 || []),
  brandText,
].filter(Boolean).join('\n');

let best = extractBestLine(blobForName);

// Optional: if brand is present, strip it once from the chosen line.
if (brandText && best) {
  best = postClean(stripBrandOnce(best, brandText));
}

// Build the candidate lines for the "name" blob.
// IMPORTANT: exclude size lines from the blob so they don't hijack the product name.
const parts = [
  ...(generalTextTop5 || []),
  brandText,
  // sizeGuessText, // excluded from blob
  // sizeRoiText,   // excluded from blob
];


// Lines we consider "size-like" or boilerplate that should not name the product.
const SIZE_LIKE = /\b(net\s*wt|net\s*weight|oz|ounce|lb|g|gram|grams|ml|made\s*with|sea\s*salt|serving|calories)\b/i;
const BOILER    = /\b(made\s*w[i1]th(?:\s+\w+){0,3}|sea\s*s?alt|ingredients?|nutrition|per\s+serv(?:ing)?|serv(?:ing|es)|calories?)\b/i;

// NEW:
const FOODISH      = /\b(beans?|kidney|black|pinto|pasta|fusilli|noodles?|rice|quinoa|tomato|sauce|lentils?|soup|chickpeas?|corn|peas|broth|olive|oil|tuna|salmon|peanut|butter)\b/i;
const BOILER_INNER = /\b(made\s+with(?:\s+\w+){0,3}|sea\s*salt)\b/gi;

const seen = new Set<string>();
let candidates: string[] = clean(parts.filter(Boolean).join('\n'))
  .split(/\n+/)
  .map(s => postClean(s))                                  // normalize + fuzzy
  .map(s => s.replace(BOILER_INNER, '').replace(/\s{2,}/g, ' ').trim())  // <- strip inner boilerplate
  .map(s => s.trim())
  .filter(s => s && looksLikeWordy(s) && !SIZE_LIKE.test(s) && !BOILER.test(s))
  .filter(s => (seen.has(s) ? false : (seen.add(s), true)));

candidates.sort((a, b) => {
  const fa = FOODISH.test(a) ? 1 : 0;
  const fb = FOODISH.test(b) ? 1 : 0;
  if (fa !== fb) return fb - fa;             // prefer food-ish lines
  return score(b) - score(a) || b.length - a.length;
});

if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] candidates(before guards)', candidates.slice(0, 8));
}

// 3) (Optional but effective) Merge "Organic" + food line from the top few
const merged = maybeMergeFoodPair(candidates.slice(0, 5));
if (merged) {
  // Put merged at the front, then stable-dedupe and re-rank
  candidates.unshift(merged);

  // stable-dedupe again
  const seen2 = new Set<string>();
  candidates = candidates.filter((x) => (seen2.has(x) ? false : (seen2.add(x), true)));

  // re-rank using your scorer
  candidates.sort((a, b) => score(b) - score(a) || b.length - a.length);

  if (process.env.NODE_ENV !== 'production') {
    dbg('[OCR] after merge', candidates.slice(0, 5));
  }
}

// ---- Label-band guard: try a couple of short, focused band reads if top looks brand-only ----
// In FAST_MODE (production), skip this extra work to avoid timeouts.
if (!FAST_MODE && candidates.length) {
  const FOODISH = /\b(beans?|pasta|rice|sauce|tomato|lentils?|soup|chickpeas?|corn|peas|broth|noodles?|olive|oil|tuna|salmon|apple|peach|peanut|butter)\b/i;
  const brandNorm = brandText ? postClean(brandText).toLowerCase() : '';
  const topNorm   = postClean(candidates[0]).toLowerCase();
  const topLooksBrandOnly =
    brandNorm &&
    (topNorm === brandNorm || topNorm.startsWith(brandNorm + ' ')) &&
    !FOODISH.test(candidates[0]);

  if (topLooksBrandOnly && generalInput?.length && Buffer.isBuffer(generalInput[0])) {
    try {
      // 2 quick crops: mid band and lower band
      const base = await downscaleIfNeeded(generalInput[0] as Buffer, 1100); // a tad larger than 900
      const mid  = await cropBandPct(base, 0.35, 0.72);   // middle of label
      const low  = await cropBandPct(base, 0.60, 0.92);   // lower band (often the food name)

      // Try raw + binarized for each band (each attempt is short)
      const attempts: Buffer[] = [];
      attempts.push(mid, await binarizeWhiteOnColor(mid));
      attempts.push(low, await binarizeWhiteOnColor(low));

      for (const [k, img] of attempts.entries()) {
  // pass 1: normal
  const txt = await tryRecognize(
    worker,
    img,
    {
      tessedit_pageseg_mode: k % 2 === 0 ? '7' : '11',   // 7: single-line, 11: sparse
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -",
    },
    `recognize:labelband:${k}`,
    STEP_MS_SIZE_FAST
  );

  // pass 2: inverted (helps white-on-red/white-on-dark banners)
  const txtInv = await tryRecognize(
    worker,
    img,
    {
      tessedit_pageseg_mode: '7',
      preserve_interword_spaces: '1',
      tessedit_do_invert: '1',
      user_defined_dpi: '300',
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -",
    },
    `recognize:labelband:invert:${k}`,
    STEP_MS_SIZE_FAST
  );

  // handle a result (shared helper)
  const handle = (raw: string | null) => {
    if (!raw) return false;
    const best = extractBestLine(raw) || postClean(clean(raw));
    if (!best) return false;

    candidates.push(best);

    // stable-dedupe + re-rank
    const seenLB = new Set<string>();
    candidates = candidates.filter(x => (seenLB.has(x) ? false : (seenLB.add(x), true)));
    candidates.sort((a, b) => score(b) - score(a) || b.length - a.length);

    // stop early if we now have a food-ish top line
    return FOODISH.test(candidates[0]);
  };

  if (handle(txt)) break;
  if (handle(txtInv)) break;
}
    } catch {
      /* best effort */
    }
  }
}

// If top line is just the brand, try a cheap extra sparse read to pull food words.
if (brandText && candidates.length) {
  const brandNorm = postClean(brandText).toLowerCase();
  const topNorm   = postClean(candidates[0]).toLowerCase();
  const topIsBrand = topNorm === brandNorm || topNorm.startsWith(brandNorm + ' ');

  const src0: Buffer | string | undefined = generalInput?.[0]; // may be Buffer OR string path
  if (topIsBrand && src0) {
    try {
      // If we have a Buffer, lightly downscale; if it's a path, pass it through directly.
      const img: Buffer | string = Buffer.isBuffer(src0)
        ? await downscaleIfNeeded(src0 as Buffer, 900)
        : (src0 as string);

      const extra = await tryRecognize(
        worker,
        img,
        {
          tessedit_pageseg_mode: '11',            // sparse
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -",
        },
        'recognize:general:guard-psm11',
        STEP_MS_SIZE_FAST                         // keep it short
      );

      if (extra) {
        // Prefer the best food-ish line from the blob, fall back to cleaned whole text.
        const best = extractBestLine(extra) || postClean(clean(extra));
        if (best) {
          candidates.push(best);

          // stable-dedupe + re-rank
          const seenX = new Set<string>();
          candidates = candidates.filter(x => (seenX.has(x) ? false : (seenX.add(x), true)));
          candidates.sort((a, b) => score(b) - score(a) || b.length - a.length);
        }
      }
    } catch {
      /* best effort; ignore */
    }
  }
  if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] after band-guard', candidates.slice(0, 5));
}
  // end of band-guard block
}

// If we recognized a brand, gently demote a pure-brand line below food-ish lines.
if (brandText && candidates.length > 1) {
  const brandNorm = postClean(brandText).toLowerCase();

  // words that indicate the *food* (tune as you like)
  const FOODISH = /\b(beans?|pasta|rice|sauce|tomato|lentils?|soup|chickpeas?|corn|peas|broth|noodles?|olive|oil|tuna|salmon|apple|peach|peanut|butter)\b/i;

  function isBrandOnly(s: string) {
    const n = postClean(s).toLowerCase();
    // treat "trader joe's", "trader joe's organic" etc. as brand-only
    const starts = n.startsWith(brandNorm);
    const hasFood = FOODISH.test(s);
    return starts && !hasFood && n.replace(brandNorm, '').trim().length <= 10; // short tail like "organic"
  }

  // Stable re-order: keep food-ish lines above a brand-only line
  candidates.sort((a, b) => {
    const aBrandOnly = isBrandOnly(a);
    const bBrandOnly = isBrandOnly(b);
    if (aBrandOnly && !bBrandOnly) return 1;   // push brand-only down
    if (!aBrandOnly && bBrandOnly) return -1;  // keep food up
    // otherwise keep your existing ranking
    return score(b) - score(a) || b.length - a.length;
  });

  if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] after brand-demote', candidates.slice(0, 5));
}
}

// (debug) inputs to the band-guard
if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] guard inputs', {
    top: candidates[0],
    brandText,
    hasGeneralInput: !!(generalInput?.length),
  });
}

// Backstop: if top is still just the brand, try one sparse read on the full oriented image.
if (brandText && candidates.length) {
  const brandNorm = postClean(brandText).toLowerCase();
  const topNorm   = postClean(candidates[0]).toLowerCase();
  const topIsBrand = topNorm === brandNorm || topNorm.startsWith(brandNorm + ' ');

  if (topIsBrand && orientedFull) {
    try {
      const extra2 = await tryRecognize(
        worker,
        orientedFull,                             // full image Buffer
        {
          tessedit_pageseg_mode: '11',
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -",
        },
        'recognize:general:guard-psm11-full',
        STEP_MS_SIZE_SLOW                         // a touch looser than FAST; still bounded
      );

      const best2 = extra2 ? extractBestLine(extra2) : '';
      if (best2) {
        candidates.push(best2);
        const seenY = new Set<string>();
        candidates = candidates.filter(x => (seenY.has(x) ? false : (seenY.add(x), true)));
        candidates.sort((a, b) => score(b) - score(a) || b.length - a.length);
      }
    } catch { /* best effort */ }
  }
}

// If we recognized a brand, gently demote a pure-brand line below food-ish lines.
if (brandText && candidates.length) {
  const brandNorm = postClean(brandText).toLowerCase();
  candidates.sort((a, b) => {
    const an = a.toLowerCase();
    const bn = b.toLowerCase();
    const aIsBrand = an === brandNorm || an.startsWith(brandNorm + ' ');
    const bIsBrand = bn === brandNorm || bn.startsWith(brandNorm + ' ');
    if (aIsBrand && !bIsBrand) return 1;   // push brand down
    if (!aIsBrand && bIsBrand) return -1;  // keep food up
    return 0;
  });
}

// (Optional) when both brand & name present, drop the brand once from the top line
if (brandText && candidates.length) {
  candidates[0] = postClean(stripBrandOnce(candidates[0], brandText));
}

// After your existing candidates.sort(...) that ranks best-first:
candidates.sort((a, b) => score(b) - score(a) || b.length - a.length);

// >>> POLISH + re-dedupe + re-rank <<<
candidates = candidates.map(polishFoodLine);

// stable-dedupe again after polish (polish can make two lines equal)
{
  const seen = new Set<string>();
  candidates = candidates.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
}

// Prefer FOODISH lines first (you already have a sorter; reuse or inline)
candidates.sort((a, b) => {
  const fa = FOODISH.test(a) ? 1 : 0;
  const fb = FOODISH.test(b) ? 1 : 0;
  if (fa !== fb) return fb - fa;               // food-ish above non-food
  return score(b) - score(a) || b.length - a.length;
});

// (Optional) tiny guard: if top is brand-only and #2 is food-ish, swap
if (candidates.length > 1) {
  const topIsFood = FOODISH.test(candidates[0]);
  const secondIsFood = FOODISH.test(candidates[1]);
  if (!topIsFood && secondIsFood) {
    [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
  }
}

// If the top line is clearly a food name, prune non-food (brand-only) lines below it.
if (candidates.length > 1 && FOODISH.test(candidates[0])) {
  // Keep the top; drop any non-FOODISH lines that follow (brands, slogans, etc.)
  candidates = [candidates[0], ...candidates.slice(1).filter(s => FOODISH.test(s))];

  // (Optional) If you want to be slightly stricter about known brand words:
  // const BRANDISH = /\b(trader\s+joe'?s?|kirkland|whole\s+foods|barilla|goya|heinz|campbell'?s)\b/i;
  // candidates = [candidates[0], ...candidates.slice(1).filter(s => FOODISH.test(s) && !BRANDISH.test(s))];
}

// If top is food-ish, drop any pure brand-only tails from the remainder
if (candidates.length) {
  const topIsFood = FOODISH.test(candidates[0]);
  if (topIsFood && brandText) {
    const brandNorm = postClean(brandText).toLowerCase();
    candidates = candidates.filter((s, i) => {
      if (i === 0) return true;
      const n = postClean(s).toLowerCase();
      const isBrandOnly = n === brandNorm || n.startsWith(brandNorm + ' ');
      return !isBrandOnly;
    });
  }
}

dbg('[OCR] trace', {
  generalTop5: generalTextTop5,   // <-- use the variable you actually have
  brandText,
  candidatesTop5: candidates.slice(0, 5),
});

// --- Google Vision backstop (only if our picks look weak) ---
if (!FAST_MODE) {
try {
  const MIN_LEN   = Number(process.env.OCR_VISION_TRIGGER_MINLEN  ?? 10);
  const MIN_SCORE = Number(process.env.OCR_VISION_TRIGGER_MINSCORE ?? 180);

  const top = candidates[0] ?? '';

  // Trigger Vision if:
  // - Tesseract found nothing, OR
  // - the top line doesn't look like food AND (it's very short OR low score)
  const looksWeak =
    candidates.length === 0 ||
    (!FOODISH.test(top) &&
      (
        top.replace(/[^A-Za-z]/g, '').length < MIN_LEN ||
        score(top) < MIN_SCORE
      )
    );

  dbg('[OCR] trigger check', {
    top,
    len: top.replace(/[^A-Za-z]/g, '').length,
    score: score(top),
    MIN_LEN, MIN_SCORE,
    looksWeak,
  });

  // Prefer the main input buffer
  const src: Buffer | undefined = generalInput?.[0] as Buffer | undefined;

  if (looksWeak && src && Buffer.isBuffer(src)) {
    // --- timing start ---
    const t0 = nowMs && typeof nowMs === 'function' ? nowMs() : Date.now();

    const vt = await detectTextFromBuffer(src);

    const elapsed = Math.round(
      (nowMs && typeof nowMs === 'function' ? nowMs() : Date.now()) - t0
    );
    dbg('[OCR] vision.fallback.ms', elapsed);
    // --- timing end ---

    if (vt) {
      // Normalize Vision text the same way as Tesseract lines
      const visCands = vt
        .split(/\r?\n+/)
        .map((s) => postClean(clean(denoiseLine(s))))
        .map((s) => polishFoodLine(s))
        .map((s) => s.trim())
        .filter(Boolean);

      if (visCands.length) {
        // Merge → stable-dedupe (Vision first so a good food line can bubble up)
        const merged = [...visCands, ...candidates];
        const uniq: string[] = [];
        const seen = new Set<string>();
        for (const s of merged) if (!seen.has(s)) { seen.add(s); uniq.push(s); }

        // Prefer food-ish, then your score, then length
        uniq.sort((a, b) => {
          const fa = FOODISH.test(a) ? 1 : 0;
          const fb = FOODISH.test(b) ? 1 : 0;
          if (fa !== fb) return fb - fa;
          return score(b) - score(a) || b.length - a.length;
        });

        candidates = uniq;
        dbg('[OCR] vision backstop merged top:', candidates.slice(0, 5));
      }
    } else {
      dbg('[OCR] vision backstop returned empty text');
    }
  }
} catch (e) {
  dbg('[OCR] vision backstop error:', (e as Error)?.message ?? e);
}
}   

// Return a newline-joined blob (top line first)
let finalText = candidates.join('\n');

// Fallback: if ranking ended up empty, show the first general line (cleaned)
if (!finalText && (generalTextTop5?.length ?? 0) > 0) {
  finalText = postClean(clean(generalTextTop5[0]));
  if (process.env.NODE_ENV !== 'production') {
    dbg('[OCR] fallback → first general line:', finalText);
  }
}

// --- FINAL nudge: if #1 looks like a pure brand but #2 looks like food, prefer food ---
if (candidates.length > 1) {
  const topIsFood    = FOODISH.test(candidates[0]);
  const secondIsFood = FOODISH.test(candidates[1]);
  if (!topIsFood && secondIsFood) {
    [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
    if (process.env.NODE_ENV !== 'production') {
      dbg('[OCR] nudged top two (prefer food-ish):', candidates.slice(0, 3));
    }
  }
}

if (process.env.NODE_ENV !== 'production') {
  dbg('[OCR] final candidates (top→):', candidates.slice(0, 5));
}

mark('finalText built');

return finalText;
    });

mark('about to return response');

return NextResponse.json({ ok: true, text });
  } catch (e) {
    console.error('[OCR] route error:', e);

    const msg = (e as Error)?.message || String(e);
    const status = msg === 'ocr-timeout' ? 504 : 500;

    return NextResponse.json(
      {
        ok: false,
        // In dev, surface the real message; in prod, keep a generic one
        error: process.env.NODE_ENV === 'production' ? 'OCR failed' : msg,
        devError: process.env.NODE_ENV !== 'production' ? msg : undefined,
      },
      { status },
    );
  }
}