// src/lib/perishables.ts

// 1 = very stable (dry pantry / frozen / canned)
// 2 = somewhat perishable (bread, tortillas, some dairy)
// 3 = perishable (most fresh meat, dairy, many veggies)
// 4 = very perishable (berries, salad greens, herbs, ripe produce)
export type PerishabilityScore = 1 | 2 | 3 | 4;

/**
 * Assign a simple perishability score based on ingredient name.
 * This uses only the ingredient text (no extra user metadata),
 * so it still works even when we don't have detailed info.
 *
 * Unknown items → default to 1 (stable), so we don't accidentally
 * push them early in the week.
 */
export function getPerishabilityScore(ingredientName: string): PerishabilityScore {
  const n = ingredientName.toLowerCase().replace(/\s+/g, ' ').trim();

  if (!n) return 1;

  // If it's explicitly frozen, treat as stable even if it's a vegetable, etc.
  if (/frozen/.test(n)) {
    return 1;
  }

  // Heuristics to avoid over-prioritizing shelf-stable versions
  const looksCannedOrShelfStable = /(canned|tin|tinned|pouch|shelf\s*stable|jarred|in\s+water|in\s+oil)/.test(n);
  const looksFresh = /(fresh|raw)/.test(n);

  // Very perishable: salad greens, berries, herbs, soft fruit, FRESH fish/seafood
  if (
    /\b(arugula|spring mix|mixed greens|spinach|lettuce|romaine|kale|chard)\b/.test(n) ||
    /\b(strawberry|blueberry|raspberry|blackberry|berries?)\b/.test(n) ||
    /\b(cilantro|parsley|basil|mint|dill|chives)\b/.test(n) ||
    /\b(avocado|peach|plum|nectarine)\b/.test(n) ||
    // fish/seafood → treat as most perishable so it’s used early in the week
    // but avoid canned/pouched fish unless explicitly marked fresh.
    ((/\b(salmon|cod|tilapia|trout|halibut|sea ?bass|white fish|fish fillet|shrimp|prawn|scallops?)\b/.test(n)) &&
      (!looksCannedOrShelfStable || looksFresh))
  ) {
    return 4;
  }

  // Perishable: most fresh veg, fresh meat, some dairy
  if (
    /\b(tomato|cucumber|zucchini|squash|mushroom|broccoli|cauliflower|pepper|bell pepper|green beans?|asparagus|cabbage)\b/.test(
      n,
    ) ||
    /\b(chicken breast|chicken thighs?|ground chicken|ground beef|ground turkey|pork chop|steak|pork loin)\b/.test(
      n,
    ) ||
    /\b(fresh mozzarella|ricotta|cream cheese|sour cream|cottage cheese)\b/.test(n) ||
    // tofu/tempeh are refrigerated and typically used within a week
    /\b(tofu|tempeh)\b/.test(n)
  ) {
    return 3;
  }

  // Somewhat perishable: milk/yogurt, bread, tortillas, some cheeses, eggs, hummus
  if (
    /\b(milk|yogurt|yoghurt|cheddar|jack cheese|shredded cheese|feta|parmesan|parmigiano)\b/.test(n) ||
    /\b(bread|buns|tortilla|pita|naan)\b/.test(n) ||
    /\b(hummus|eggs?)\b/.test(n)
  ) {
    return 2;
  }

  // Shelf-stable canned/pouched fish should not be prioritized early
  if (looksCannedOrShelfStable && /\b(tuna|salmon|sardines?|anchov(?:y|ies)|mackerel)\b/.test(n)) {
    return 1;
  }

  // Default: stable pantry (rice, pasta, canned goods, oils, spices, etc.)
  return 1;
}

/**
 * Compute a recipe-level perishability score from its ingredients.
 * We use the maximum score of any ingredient:
 * if a recipe contains berries + rice → it's effectively "very perishable".
 *
 * If the ingredient list is empty or we don't recognize anything,
 * we return 1 (stable) so it naturally falls later in the week.
 */
export function computeRecipePerishability(ingredientNames: string[]): PerishabilityScore {
  if (!ingredientNames || ingredientNames.length === 0) return 1;

  let maxScore: PerishabilityScore = 1;
  for (const name of ingredientNames) {
    const score = getPerishabilityScore(name);
    if (score > maxScore) {
      maxScore = score;
    }
  }
  return maxScore;
}

/**
 * Convert a perish-by date into a perishability score.
 *
 * - 0–1 days (or past due)  → 4 (very urgent)
 * - 2–3 days                → 3
 * - 4–7 days                → 2
 * - >7 days or invalid      → 1 (stable)
 */
export function scoreFromPerishDate(
  perishDate: Date | string | null | undefined,
): PerishabilityScore {
  if (!perishDate) return 1;

  const time =
    perishDate instanceof Date ? perishDate.getTime() : Date.parse(perishDate);
  if (Number.isNaN(time)) return 1;

  const now = Date.now();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const diffMs = time - now;
  const diffDays = Math.ceil(diffMs / MS_PER_DAY);

  if (diffDays <= 1) return 4; // today / tomorrow / overdue → very urgent
  if (diffDays <= 3) return 3;
  if (diffDays <= 7) return 2;
  return 1;
}

/**
 * Pantry-aware perishability score.
 *
 * Priority order:
 * 1) If user explicitly marked the item as `use_soon`, treat as very urgent.
 * 2) If a perish-by date exists, use it.
 * 3) Otherwise fall back to name heuristics.
 */
export function scoreForPantryItem(input: {
  name: string;
  use_soon?: boolean | null;
  perish_by?: Date | string | null | undefined;
}): PerishabilityScore {
  if (input.use_soon) return 4;

  const byDate = scoreFromPerishDate(input.perish_by);
  if (byDate !== 1) return byDate;

  return getPerishabilityScore(input.name);
}