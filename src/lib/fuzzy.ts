// src/lib/fuzzy.ts
// Lightweight Jaro–Winkler (0..1) used for brand matching.
export function jaroWinkler(s1: string, s2: string): number {
  const A = (s1 || '').toLowerCase().normalize('NFKD');
  const B = (s2 || '').toLowerCase().normalize('NFKD');
  if (!A || !B) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(A.length, B.length) / 2) - 1);
  const aMatches = new Array(A.length).fill(false);
  const bMatches = new Array(B.length).fill(false);

  let matches = 0;
  for (let i = 0; i < A.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, B.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || A[i] !== B[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let t = 0, k = 0;
  for (let i = 0; i < A.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (A[i] !== B[k]) t++;
    k++;
  }
  t /= 2;

  const jaro =
    (matches / A.length + matches / B.length + (matches - t) / matches) / 3;

  let prefix = 0;
  for (; prefix < Math.min(4, A.length, B.length) && A[prefix] === B[prefix]; prefix++);
  return jaro + prefix * 0.1 * (1 - jaro);
}