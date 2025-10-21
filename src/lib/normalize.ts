// /lib/normalize.ts
// OCR normalization helpers + category/label/type extractors (with fuzzy type recovery)

export const BRAND_HINTS = [
  "Trader Joe's", "Trader Joes", "O Organics", "Barilla", "Rao's", "Annie's",
  "General Mills", "De Cecco", "Whole Foods", "Campbell's", "Heinz",
  "Goya", "Progresso", "Kraft", "365", "Great Value"
];

export const PASTA_TYPES = [
  'fusilli','penne','spaghetti','farfalle','rigatoni','rotini','macaroni',
  'linguine','fettuccine','orecchiette','shells','elbows','capellini','vermicelli',
  'bucatini','ziti','ditalini','campanelle','cavatappi','gemelli','paccheri','radiatori'
];

// --- Common household type lexicons ---

const BEAN_TYPES_2W = ['red kidney','great northern'];
const BEAN_TYPES_1W = ['kidney','black','pinto','garbanzo','chickpea','white','cannellini','navy','lentil','refried'];

const RICE_TYPES_2W = ['long grain','short grain'];
const RICE_TYPES_1W = ['basmati','jasmine','brown','white','arborio','sushi','wild'];

const TOMATO_TYPES_2W = ['whole peeled','fire roasted'];
const TOMATO_TYPES_1W = ['diced','crushed','whole','puree','sauce','paste'];

const BROTH_TYPES = ['chicken','beef','vegetable','bone'];
const FLOUR_TYPES = ['all purpose','whole wheat','bread','cake','self rising','almond','coconut','00'];
const SUGAR_TYPES = ['cane','brown','powdered','confectioners','turbinado','coconut'];
const MILK_TYPES = ['whole','2%','1%','skim','evaporated','condensed','almond','oat','soy','coconut','lactose free','half & half'];
const OIL_TYPES = ['extra virgin', 'olive', 'canola', 'vegetable', 'avocado', 'grapeseed', 'sesame'];
const VINEGAR_TYPES = ['balsamic','apple cider','white','red wine','rice','distilled'];
const FISH_TYPES = ['tuna','salmon','sardines','anchovies','mackerel'];

const CATEGORY_KEYWORDS: Record<string, RegExp[]> = {
  Pasta: [
    /\bpasta\b/i, /\b(fusilli|penne|spaghetti|farfalle|rigatoni|rotini|linguine|fettuccine|macaroni|orecchiette|capellini|vermicelli|shells|elbows)\b/i
  ],
  Beans: [
    /\bbeans?\b/i, /\bkidney\b/i, /\bblack\b/i, /\bgarbanzo|chickpeas?\b/i, /\bpinto\b/i, /\bcannellini\b/i, /\blentils?\b/i, /\brefried\b/i
  ],
  Rice: [/\brice\b/i, /\barborio\b/i, /\bbasmati\b/i, /\bjasmine\b/i],
  Tomatoes: [/\btomato(?:es)?\b/i, /\bpaste\b/i, /\bsauce\b/i, /\bdiced\b/i, /\bcrushed\b/i, /\bwhole\b/i],
  Broth: [/\bbroth\b/i, /\bstock\b/i],
  Flour: [/\bflour\b/i],
  Sugar: [/\bsugar\b/i],
  Milk: [/\bmilk\b/i, /\bevaporated\b/i, /\bcondensed\b/i, /\boat|almond|soy|coconut\b/i],
  Oil: [/\boil\b/i, /\bolive\b/i, /\bextra\s*virgin\b/i],
  Vinegar: [/\bvinegar\b/i],
  Fish: [/\btuna\b/i, /\bsalmon\b/i, /\bsardines?\b/i, /\banchov(?:y|ies)\b/i, /\bmackerel\b/i],
  Cereal: [/\bcereal\b/i, /\boats?\b/i, /\bcheerios?\b/i],
  Sauce: [/\bsauce\b/i, /\bmarinara\b/i, /\bpesto\b/i],
  Soup: [/\bsoup\b/i, /\bchowder\b/i, /\bbisque\b/i],
  Snacks: [/\bchips?\b/i, /\bcrackers?\b/i, /\bpopcorn\b/i],
};

const DESCRIPTOR_HINTS = [
  'organic','brown rice','quinoa','gluten free','sodium free','low sodium','no salt added','extra virgin','unsalted','no sugar added'
];

// ---------- CLEANUP ----------

export function cleanOcrText(text: string): string {
  if (!text) return '';

  let out = text;

  // Unit/number fixes before global cleanup
  const preFixes: Array<[RegExp, string]> = [
    [/\bN[E£]T[\s.]*W[T7I][\s.:;-]*/gi, 'NET WT '],
    [/\bFL[\s.-]*OZ\b/gi, ' FL OZ'],
    [/\b0\s*Z\b/gi, ' OZ'], [/\bO\s*2\b/gi, ' OZ'], [/\bO\s*Z\b/gi, ' OZ'],
    [/\bL\s*B[S]?\b/gi, ' LB'], [/\bI\s*LB\b/gi, ' 1 LB'], [/\b1\s*L[B8]\b/gi, ' 1 LB'],
    [/\b4\s*5\s*4\s*g\b/gi, ' 454 g'], [/\b[gq]r?a?m?s?\b/gi, ' g'],
    [/\b1\s*5\s*\.?\s*5\s*OZ\b/gi, ' 15.5 OZ'],
    [/\b454g\b/gi, ' 454 g'],
  ];
  preFixes.forEach(([re, rep]) => (out = out.replace(re, rep)));

  out = out
    .replace(/[^a-zA-Z0-9&().,'’”“\-\/\s]/g, ' ')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const fixes: Array<[RegExp, string]> = [
    [/\bjoes\b/gi, "joe's"],
    [/\btrader[^a-z0-9]{0,30}joe'?s?\b/gi, "Trader Joe's"],
    [/\b[o0][^a-z0-9]{0,12}organics?\b/gi, "O Organics"],
    [/\bqum?i?noa|qunioa|quuinoa|quinua\b/gi, 'quinoa'],
    [/\bfusil+i+e?\b/gi, 'fusilli'],
    [/\bpen(n)?e\b/gi, 'penne'],
  ];
  fixes.forEach(([re, rep]) => (out = out.replace(re, rep)));

  return out;
}

// ---------- SIZE ----------

export function extractSize(text: string): string {
  if (!text) return '';
  const t = text.replace(/\s{2,}/g, ' ');
  const normNum = (s?: string) => (s || '').replace(/[Il]/g, '1');

  const OZ = t.match(/\b(\d{1,3}(?:\.\d+)?)\s*[O0][Z2]\b/i) || t.match(/\b(\d{1,3}(?:\.\d+)?)\s*[O0]\s*[Z2]\b/i);
  const FLOZ = t.match(/\b(\d{1,3}(?:\.\d+)?)\s*FL\s*OZ\b/i);

  const LB_P = t.match(/\(\s*([1Il](?:\.\d+)?)\s*L[B8]S?\s*\)/i);
  const LB_A = t.match(/\b([1Il](?:\.\d+)?)\s*L[B8]S?\b/i);
  const G = t.match(/\b(4(?:53\.6|54)|\d{2,4})\s*g\b/i);

  const build = (oz?: string, lb?: string, g?: string) => {
    const parts: string[] = [];
    if (oz) parts.push(`${oz} oz`);
    if (lb) parts.push(`(${lb} lb)`);
    if (g && /^(454|453\.6)$/i.test(g)) parts.push('454 g');
    return parts.join(' ').trim();
  };

  if (FLOZ) return `${normNum(FLOZ[1])} fl oz`;

  if (OZ && (LB_P || LB_A)) {
    const ozv = normNum(OZ[1]);
    const lbv = normNum((LB_P?.[1] || LB_A?.[1] || ''));
    const gv  = G?.[1];
    const candidate = build(ozv, lbv, gv);
    if (candidate) return candidate;
  }
  if (OZ) {
    const ozv = normNum(OZ[1]);
    if (G && /^454|453\.6$/i.test(G[1])) return build(ozv, '1', '454');
    return `${ozv} oz`;
  }
  if (LB_P || LB_A) {
    const lbv = normNum((LB_P?.[1] || LB_A?.[1] || '1'));
    if (G && /^454|453\.6$/i.test(G[1])) return `${Number(lbv).toString()} lb (454 g)`;
    return `${Number(lbv).toString()} lb`;
  }
  if (G) {
    const gv = G[1];
    if (/^454|453\.6$/i.test(gv)) return '16 oz (1 lb)';
    return `${gv} g`;
  }
  const near = t.match(/\b(\d{1,3})(?:\s|[^\w]){0,3}[O0][Z2]\b/i);
  if (near) return `${normNum(near[1])} oz`;

  return '';
}

// ---------- BRAND ----------

export function extractBrand(text: string): string {
  const lower = text.toLowerCase();
  const idxTrader = lower.indexOf('trader');
  const idxJoe = lower.indexOf('joe');
  if (idxTrader !== -1 && idxJoe !== -1 && Math.abs(idxJoe - idxTrader) < 30) return "Trader Joe's";
  if (/[o0][^a-z0-9]{0,12}organics?\b/i.test(text)) return 'O Organics';

  const t = ` ${lower} `;
  for (const b of BRAND_HINTS) {
    const needle = ` ${b.toLowerCase().replace(/\s+/g, ' ')} `;
    if (t.includes(needle)) return canonicalizeBrand(b);
  }
  if (/\btrader\s*joes?\b/i.test(text)) return "Trader Joe's";
  return '';
}

// ---------- CATEGORY ----------

export function detectCategory(text: string): string | '' {
  for (const [cat, patterns] of Object.entries(CATEGORY_KEYWORDS)) {
    if (patterns.some((re) => re.test(text))) return cat;
  }
  return '';
}

// ---------- Fuzzy helpers ----------

function tokenize(t: string): string[] {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1, cur = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = cur;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur = Math.min(dp[j] + 1, cur + 1, prev + cost);
      prev = tmp;
      dp[j] = cur;
    }
    dp[0] = i;
  }
  return dp[b.length];
}

function bestFuzzyMatch(target: string, candidates: string[]): { hit: string; dist: number } {
  let best = { hit: '', dist: Infinity };
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d < best.dist) best = { hit: c, dist: d };
  }
  return best;
}

function join2(a?: string, b?: string) {
  return [a, b].filter(Boolean).join(' ');
}

// Generic fuzzy extractor around an anchor word (milk, oil, vinegar, broth, flour, sugar, fish)
function fuzzyTypeNearAnchor(
  text: string,
  anchorRe: RegExp,
  list1w: string[],
  list2w: string[] = [],
  suffixRules: Array<[RegExp,string]> = []
): string {
  const t = text.toLowerCase();

  // Exact first
  const two = list2w.find(tt => new RegExp(`\\b${tt.replace(' ', '\\s+')}\\b`, 'i').test(t));
  if (two) return capitalizeWords(two);
  const one = list1w.find(tt => new RegExp(`\\b${tt}\\b`, 'i').test(t));
  if (one) return capitalizeWords(one);

  // Heuristic suffix nudges
  const suf = t.match(new RegExp(`\\b([a-z]{3,14})[^a-z]{0,3}\\s*${anchorRe.source}`, 'i'));
  if (suf) {
    const raw = suf[1];
    for (const [rx, norm] of suffixRules) {
      if (rx.test(raw)) return capitalizeWords(norm);
    }
  }

  // Fuzzy near anchor
  const toks = tokenize(t);
  for (let i = 0; i < toks.length; i++) {
    if (!anchorRe.test(toks[i])) continue;

    const before2 = join2(toks[i - 2], toks[i - 1]).trim();
    if (before2) {
      let best = { hit: '', dist: Infinity };
      for (const c of list2w) {
        const d = levenshtein(before2, c);
        if (d < best.dist) best = { hit: c, dist: d };
      }
      const max2 = Math.max(2, Math.ceil(before2.length * 0.4));
      if (best.hit && best.dist <= max2) return capitalizeWords(best.hit);
    }

    const before1 = toks[i - 1];
    if (before1) {
      let best = { hit: '', dist: Infinity };
      for (const c of list1w) {
        const d = levenshtein(before1, c);
        if (d < best.dist) best = { hit: c, dist: d };
      }
      const max1 = Math.max(2, Math.ceil(before1.length * 0.5));
      if (best.hit && best.dist <= max1) return capitalizeWords(best.hit);
    }
  }

  // Anywhere "<word> <anchor>"
  const any = t.match(new RegExp(`\\b([a-z]{3,14})[^a-z]{0,3}\\s*${anchorRe.source}`, 'i'));
  if (any) {
    const w = any[1];
    let best = { hit: '', dist: Infinity };
    for (const c of list1w) {
      const d = levenshtein(w, c);
      if (d < best.dist) best = { hit: c, dist: d };
    }
    const max1 = Math.max(2, Math.ceil(w.length * 0.5));
    if (best.hit && best.dist <= max1) return capitalizeWords(best.hit);
  }

  return '';
}

// ---------- Type extractors (exact + fuzzy where applicable) ----------

export function extractPastaType(text: string): string {
  const t = text.toLowerCase();
  for (const p of PASTA_TYPES) {
    const re = new RegExp(`\\b${p}\\b`, 'i');
    if (re.test(t)) return capitalize(p);
  }
  return '';
}

export function extractBeanType(text: string): string {
  const t = text.toLowerCase();

  const twoExact = BEAN_TYPES_2W.find(tt =>
    new RegExp(`\\b${tt.replace(' ', '\\s+')}\\b`, 'i').test(t)
  );
  if (twoExact) return capitalizeWords(twoExact);

  const oneExact = BEAN_TYPES_1W.find(tt =>
    new RegExp(`\\b${tt}\\b`, 'i').test(t)
  );
  if (oneExact) return capitalizeWords(oneExact) + ' Beans';

  const suffixFix = t.match(/\b([a-z]{3,12})[^a-z]{0,3}\s*beans?\b/i);
  if (suffixFix) {
    const raw = suffixFix[1];
    if (/l{1,2}ney$/.test(raw)) return 'Kidney Beans';
    if (/cannellin[i1l]?$/.test(raw)) return 'Cannellini Beans';
  }

  const toks = tokenize(t);
  const tryFuzzySingle = (token?: string) => {
    if (!token) return '';
    const maxDist = Math.max(2, Math.ceil(token.length * 0.5));
    let best = { hit: '', dist: Infinity };
    for (const c of BEAN_TYPES_1W) {
      const d = levenshtein(token, c);
      if (d < best.dist) best = { hit: c, dist: d };
    }
    return best.hit && best.dist <= maxDist
      ? capitalizeWords(best.hit) + ' Beans'
      : '';
  };

  const tryFuzzyDouble = (w1?: string, w2?: string) => {
    const phrase = [w1, w2].filter(Boolean).join(' ').trim();
    if (!phrase) return '';
    const maxDist = Math.max(2, Math.ceil(phrase.length * 0.4));
    let best = { hit: '', dist: Infinity };
    for (const c of BEAN_TYPES_2W) {
      const d = levenshtein(phrase, c);
      if (d < best.dist) best = { hit: c, dist: d };
    }
    return best.hit && best.dist <= maxDist ? capitalizeWords(best.hit) : '';
  };

  for (let i = 0; i < toks.length; i++) {
    if (!/^beans?$/.test(toks[i])) continue;
    const two = tryFuzzyDouble(toks[i - 2], toks[i - 1]);
    if (two) return two;
    const one = tryFuzzySingle(toks[i - 1]);
    if (one) return one;
  }

  const anywhere = t.match(/\b([a-z]{3,12})[^a-z]{0,3}\s*beans?\b/i);
  if (anywhere) {
    const one = tryFuzzySingle(anywhere[1]);
    if (one) return one;
  }

  return '';
}

function extractRiceType(text: string): string {
  const t = text.toLowerCase();
  const two = RICE_TYPES_2W.find(tt => new RegExp(`\\b${tt.replace(' ', '\\s+')}\\b`, 'i').test(t));
  if (two) return capitalizeWords(two);
  const one = RICE_TYPES_1W.find(tt => new RegExp(`\\b${tt}\\b`, 'i').test(t));
  if (one) return capitalizeWords(one);

  const toks = tokenize(t);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'rice') continue;
    const prev1 = toks[i - 1];
    const prev2 = toks[i - 2];
    const bigram = join2(prev2, prev1).trim();

    if (bigram) {
      const { hit, dist } = bestFuzzyMatch(bigram, RICE_TYPES_2W);
      if (hit && dist <= 2) return capitalizeWords(hit);
    }
    if (prev1) {
      const { hit, dist } = bestFuzzyMatch(prev1, RICE_TYPES_1W);
      if (hit && dist <= 1) return capitalizeWords(hit);
    }
  }
  return '';
}

function extractTomatoType(text: string): string {
  const t = text.toLowerCase();
  const two = TOMATO_TYPES_2W.find(tt => new RegExp(`\\b${tt.replace(' ', '\\s+')}\\b`, 'i').test(t));
  if (two) return capitalizeWords(two);
  const one = TOMATO_TYPES_1W.find(tt => new RegExp(`\\b${tt}\\b`, 'i').test(t));
  if (one) return capitalizeWords(one);

  const toks = tokenize(t);
  for (let i = 0; i < toks.length; i++) {
    if (!/^tomato(?:es)?$/.test(toks[i])) continue;
    const prev1 = toks[i - 1];
    const prev2 = toks[i - 2];
    const bigram = join2(prev2, prev1).trim();

    if (bigram) {
      const { hit, dist } = bestFuzzyMatch(bigram, TOMATO_TYPES_2W);
      if (hit && dist <= 2) return capitalizeWords(hit);
    }
    if (prev1) {
      const { hit, dist } = bestFuzzyMatch(prev1, TOMATO_TYPES_1W);
      if (hit && dist <= 1) return capitalizeWords(hit);
    }
  }
  return '';
}

// --- Now the rest use generic fuzzy near-anchor ---

function extractBrothType(text: string): string {
  return fuzzyTypeNearAnchor(text, /\b(broth|stock)\b/i, BROTH_TYPES);
}

function extractFlourType(text: string): string {
  return fuzzyTypeNearAnchor(text, /\bflour\b/i, FLOUR_TYPES);
}

function extractSugarType(text: string): string {
  return fuzzyTypeNearAnchor(text, /\bsugar\b/i, SUGAR_TYPES);
}

function extractMilkType(text: string): string {
  const suffixRules: Array<[RegExp,string]> = [[/wh0le|whale|whol[e]?/,'whole']];
  return fuzzyTypeNearAnchor(text, /\bmilk\b/i, MILK_TYPES, [], suffixRules);
}

function extractOilType(text: string): string {
  return fuzzyTypeNearAnchor(text, /\boil\b/i, OIL_TYPES, ['extra virgin']);
}

function extractVinegarType(text: string): string {
  return fuzzyTypeNearAnchor(text, /\bvinegar\b/i, VINEGAR_TYPES, ['apple cider','red wine','white wine']);
}

function extractFishType(text: string): string {
  return fuzzyTypeNearAnchor(text, /\b(tuna|salmon|sardines?|anchovies|mackerel)\b/i, FISH_TYPES);
}

// Unified type extractor by category
export function extractTypeByCategory(text: string, category?: string | ''): { type: string; normalizedCategoryWord: string } {
  const cat = category || detectCategory(text);
  switch (cat) {
    case 'Beans':     return { type: extractBeanType(text)    || 'Beans',     normalizedCategoryWord: 'Beans' };
    case 'Pasta':     return { type: extractPastaType(text)   || 'Pasta',     normalizedCategoryWord: 'Pasta' };
    case 'Rice':      return { type: extractRiceType(text)    || 'Rice',      normalizedCategoryWord: 'Rice' };
    case 'Tomatoes':  return { type: extractTomatoType(text)  || 'Tomatoes',  normalizedCategoryWord: 'Tomatoes' };
    case 'Broth':     return { type: extractBrothType(text)   || 'Broth',     normalizedCategoryWord: 'Broth' };
    case 'Flour':     return { type: extractFlourType(text)   || 'Flour',     normalizedCategoryWord: 'Flour' };
    case 'Sugar':     return { type: extractSugarType(text)   || 'Sugar',     normalizedCategoryWord: 'Sugar' };
    case 'Milk':      return { type: extractMilkType(text)    || 'Milk',      normalizedCategoryWord: 'Milk' };
    case 'Oil':       return { type: extractOilType(text)     || 'Oil',       normalizedCategoryWord: 'Oil' };
    case 'Vinegar':   return { type: extractVinegarType(text) || 'Vinegar',   normalizedCategoryWord: 'Vinegar' };
    case 'Fish':      return { type: extractFishType(text)    || 'Fish',      normalizedCategoryWord: 'Fish' };
    default:          return { type: '', normalizedCategoryWord: cat || '' };
  }
}

// ---------- Descriptors, Allergens, Name builder ----------

export function extractDescriptors(text: string): string[] {
  const t = text.toLowerCase();
  const found = new Set<string>();
  for (const d of DESCRIPTOR_HINTS) if (t.includes(d)) found.add(capitalizeWords(d));
  return Array.from(found);
}

// Post-processing helpers for final names
export function properCaseName(s: string): string {
  if (!s) return '';
  const origTokens = s.trim().replace(/\s+/g, ' ').split(' ');
  const lc = s.trim().replace(/\s+/g, ' ').toLowerCase();
  const keepLower = new Set(['of','and','a','an','the','in','on','with','for','to','from','by','or']);

  const out = lc
    .split(' ')
    .map((w, i) => {
      const orig = origTokens[i] || w;
      if (/^[A-Z0-9]{2,}$/.test(orig)) return orig; // preserve all-caps tokens (USDA/BPA/etc.)
      if (i > 0 && keepLower.has(w)) return w;
      return w.split('-').map(p => p ? p[0].toUpperCase() + p.slice(1) : p).join('-');
    })
    .join(' ')
    .replace(/\bUsda\b/g, 'USDA')
    .replace(/\bBpa\b/g, 'BPA');

  return out;
}

export function stripBrandFromName(name: string, brand?: string): string {
  if (!name) return '';
  let out = name.trim();
  if (brand) {
    const b = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`^\\s*${b}\\s*[,:-]?\\s*`, 'i');
    out = out.replace(rx, '');
  }
  out = out.replace(/^\s*trader\s*joe'?s\s*[,:-]?\s*/i, '');
  return out.trim();
}

export function buildName(opts: {
  text: string;
  category?: string;
  descriptors: string[];
}): string {
  const { text, category, descriptors } = opts;

  const tokens = [...descriptors];
  const organicIdx = tokens.findIndex(t => t.toLowerCase() === 'organic');
  if (organicIdx > -1) { tokens.splice(organicIdx, 1); tokens.unshift('Organic'); }

  const { type, normalizedCategoryWord } = extractTypeByCategory(text, category);

  const pieces: string[] = [];
  if (tokens.length) pieces.push(tokens.join(' '));

  if (type) {
    if (normalizedCategoryWord && !new RegExp(`\\b${normalizedCategoryWord}\\b`, 'i').test(type)) {
      pieces.push(type);
      if (
        !/\b(Beans|Pasta|Rice|Tomatoes|Broth|Flour|Sugar|Milk|Oil|Vinegar|Fish)\b/i.test(type) &&
        normalizedCategoryWord
      ) {
        pieces.push(normalizedCategoryWord);
      }
    } else {
      pieces.push(type);
    }
  } else if (normalizedCategoryWord) {
    pieces.push(normalizedCategoryWord);
  }

  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

export function normalizeOcr(raw: string): {
  cleanedText: string;
  brandHint: string;
  descriptors: string[];
  size: string;
  category: string | '';
} {
  const cleanedText = cleanOcrText(raw);
  const brandHint = extractBrand(cleanedText);
  const descriptors = extractDescriptors(cleanedText);
  const size = extractSize(cleanedText);
  const category = detectCategory(cleanedText);
  return { cleanedText, brandHint, descriptors, size, category };
}

export function scanAllergens(text: string): string[] {
  const t = text.toLowerCase();
  const hits: string[] = [];
  const AL = ['gluten','wheat','egg','soy','milk','tree nuts','peanut','sesame'];
  AL.forEach(a => { if (t.includes(a)) hits.push(capitalizeWords(a)); });
  return Array.from(new Set(hits));
}

// ---------- utils ----------
function capitalize(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function capitalizeWords(s: string) { return s.replace(/\b\w/g, c => c.toUpperCase()); }
function canonicalizeBrand(b: string) {
  if (/trader\s*joe/i.test(b)) return "Trader Joe's";
  if (/rao/i.test(b)) return "Rao's";
  if (/annies/i.test(b)) return "Annie's";
  if (/^o\s*organics$/i.test(b)) return "O Organics";
  return b.replace(/\s+/g, ' ').trim();
}

// Re-export so older pages can import from "@/lib/normalize"
export { draftProductFromOcrSmart as draftProductFromOcr } from './normalize_smart';