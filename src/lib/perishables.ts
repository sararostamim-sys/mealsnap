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
  const n = ingredientName.toLowerCase().trim();

  if (!n) return 1;

  // If it's explicitly frozen, treat as stable even if it's a vegetable, etc.
  if (/frozen/.test(n)) {
    return 1;
  }

    // Very perishable: salad greens, berries, herbs, soft fruit, FRESH FISH/SEAFOOD
  if (
    /(arugula|spring mix|mixed greens|spinach|lettuce|romaine|kale|chard)/.test(n) ||
    /(strawberry|blueberry|raspberry|blackberry|berry)/.test(n) ||
    /(cilantro|parsley|basil|mint|dill|chives)/.test(n) ||
    /(avocado|peach|plum|nectarine)/.test(n) ||
    // fish/seafood → treat as most perishable so it’s used early in the week
    /(salmon|cod|tilapia|trout|halibut|sea ?bass|white fish|fish fillet|shrimp|prawn|scallops?)/.test(n)
  ) {
    return 4;
  }

  // Perishable: most fresh veg, fresh meat, some dairy
  if (
    /(tomato|cucumber|zucchini|squash|mushroom|broccoli|cauliflower|pepper|bell pepper|green bean|asparagus|cabbage)/.test(
      n,
    ) ||
    /(chicken breast|chicken thighs?|ground chicken|ground beef|ground turkey|pork chop|steak|pork loin)/.test(
      n,
    ) ||
    /(fresh mozzarella|ricotta|cream cheese|sour cream)/.test(n) ||
    /(strawberries|berries)/.test(n)
  ) {
    return 3;
  }

  // Somewhat perishable: milk/yogurt, bread, tortillas, some cheeses
  if (
    /(milk|yogurt|yoghurt|cheddar|jack cheese|shredded cheese|feta|parmesan|parmigiano)/.test(n) ||
    /(bread|buns|tortilla|pita|naan)/.test(n) ||
    /(hummus)/.test(n)
  ) {
    return 2;
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
  const diffDays = Math.floor((time - now) / (1000 * 60 * 60 * 24));

  if (diffDays <= 1) return 4; // today / tomorrow / overdue → very urgent
  if (diffDays <= 3) return 3;
  if (diffDays <= 7) return 2;
  return 1;
}