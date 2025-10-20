// /lib/match.ts
// Field-weighted fuzzy matching with alias support

type Product = {
  id: string;
  brand: string;
  name: string;
  aliases?: string[];
  category?: string;
};

type Draft = {
  brand: string;
  name: string;
  size: string;
  candidates: string[];
  labels?: string[];
};

export type CanonicalMatch = {
  id: string;
  brand: string;
  name: string;
  category?: string;
  score: number;
};

export function matchCanonical(draft: Draft, products: Product[], opts?: {
  topK?: number;
}): CanonicalMatch[] {
  const topK = opts?.topK ?? 5;

  return products
    .map((p) => {
      const nameSim = maxSim(draft.name, [p.name, ...(p.aliases ?? [])]);
      const brandSim = sim(draft.brand, p.brand);
      const labelSim = Array.isArray(draft.labels)
        ? sim(draft.labels.join(' '), p.category || '')
        : 0;

      // weights tuned for your use case
      const score = 0.58 * nameSim + 0.32 * brandSim + 0.10 * labelSim;

      return {
        id: p.id,
        brand: p.brand,
        name: p.name,
        category: p.category,
        score: round(score, 3),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// -------- fuzzy helpers (token-based) --------

function normalize(s: string) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

// token Jaccard with soft partials (n-gram)
function sim(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size && !tb.size) return 0;
  let inter = 0;
  ta.forEach(t => {
    if (tb.has(t)) inter += 1;
    else {
      // soft partial using 3-gram overlap
      tb.forEach(u => { if (triOverlap(t, u) >= 0.5) inter += 0.5; });
    }
  });
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

function maxSim(a: string, candidates: string[]): number {
  return candidates.reduce((m, c) => Math.max(m, sim(a, c)), 0);
}

function triOverlap(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter += 1; });
  return inter / new Set([...A, ...B]).size;
}

function trigrams(s: string): Set<string> {
  const n = normalize(s);
  const out = new Set<string>();
  for (let i = 0; i < n.length - 2; i++) {
    out.add(n.slice(i, i + 3));
  }
  return out;
}

function round(n: number, d: number) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
