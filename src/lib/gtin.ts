// /lib/gtin.ts
export function onlyDigits(s: string): string {
  return (s || '').replace(/\D+/g, '');
}

// Mod-10 check digit (GS1) for GTIN-8/12/13/14
export function gs1CheckDigit(body: string): number {
  const digits = onlyDigits(body).split('').map(Number);
  let sum = 0;
  let oddFromRight = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * (oddFromRight ? 3 : 1);
    oddFromRight = !oddFromRight;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

export function upcAToEan13(upc12: string): string {
  const body = '0' + onlyDigits(upc12).slice(0, 12);
  const cd = gs1CheckDigit(body);
  return body + cd.toString();
}

export function normalizeGtin(raw: string): {
  original: string;
  digits: string;
  candidates: string[]; // try in this order with remote APIs
} {
  const digits = onlyDigits(raw);
  const cands = new Set<string>();

  if (digits.length === 12) {
    // UPC-A
    cands.add(digits);               // 12-digit (some APIs accept)
    cands.add(upcAToEan13(digits));  // 13-digit EAN variant (OFF prefers this)
  } else if (digits.length === 13) {
    // EAN-13
    cands.add(digits);
    if (digits.startsWith('0')) {
      const upc = digits.slice(1, 12);
      if (upc.length === 12) cands.add(upc);
    }
  } else if (digits.length === 8 || digits.length === 14) {
    cands.add(digits);
  }

  // Always try the raw digits last (just in case)
  cands.add(digits);

  return { original: raw, digits, candidates: Array.from(cands) };
}