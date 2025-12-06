// src/lib/pantryCategorizer.ts

export type PantryCategory =
  | 'produce'
  | 'protein'
  | 'grains'
  | 'dairy'
  | 'frozen'
  | 'canned'
  | 'snacks'
  | 'condiments'
  | 'baking'
  | 'beverages'
  | 'other';

/**
 * Very lightweight name-based categorization.
 *
 * - Uses only the item name (e.g. "chicken breast", "brown rice").
 * - Safe even when we know nothing else about the item.
 * - Unknown items fall back to "other" so we never mislabel badly.
 */
export function autoCategoryFromName(name: string): PantryCategory {
  const n = name.toLowerCase().trim();

  if (!n) return 'other';

  // Fresh fruit & veg
  if (
    /(apple|banana|orange|pear|grape|berry|strawberry|blueberry|raspberry)/.test(n) ||
    /(tomato|onion|garlic|pepper|bell pepper|cucumber|zucchini|squash|broccoli|cauliflower|carrot|spinach|lettuce|kale|greens|avocado|potato|sweet potato|lime|lemon|herb|cilantro|parsley|basil|mint|dill)/.test(
      n,
    )
  ) {
    return 'produce';
  }

    // Proteins (meat, fish, tofu, eggs)
  if (
    /(chicken|beef|pork|ham|bacon|sausage|turkey|salmon|cod|fish|shrimp|tuna|tofu|tempeh|seitan|egg\b|eggs\b)/.test(
      n,
    )
  ) {
    return 'protein';
  }

    // Grains, pasta, beans/lentils, bread, tortillas
  if (
    /(rice|quinoa|farro|barley|oats|oatmeal|couscous|pasta|spaghetti|penne|fusilli|macaroni|noodle|lentil|chickpea|garbanzo|black bean|kidney bean|pinto bean|beans)/.test(
      n,
    ) ||
    /(bread|bagel|pita|naan|tortilla|wrap)/.test(n)
  ) {
    return 'grains';
  }

  // Dairy & dairy-like
  if (
    /(milk|yogurt|yoghurt|cheese|mozzarella|cheddar|parmesan|feta|butter|cream|half[- ]and[- ]half|sour cream)/.test(
      n,
    )
  ) {
    return 'dairy';
  }

  // Frozen items
  if (/frozen/.test(n)) {
    return 'frozen';
  }

  // Canned / jarred basics
  if (/(canned|can\b|tin\b|tomato sauce|tomato paste|canned tomato|soup)/.test(n)) {
    return 'canned';
  }

  // Snacks & sweets
  if (
    /(chip|cracker|cookie|biscuit|candy|chocolate|granola bar|protein bar|snack|pretzel)/.test(
      n,
    )
  ) {
    return 'snacks';
  }

  // Condiments, oils, sauces, dressings
  if (
    /(ketchup|mustard|mayo|mayonnaise|soy sauce|tamari|salsa|hot sauce|bbq sauce|barbecue sauce|vinegar|balsamic|olive oil|canola oil|vegetable oil|sesame oil|dressing|pesto)/.test(
      n,
    )
  ) {
    return 'condiments';
  }

  // Baking supplies
  if (
    /(flour|sugar|brown sugar|baking powder|baking soda|yeast|cocoa powder|chocolate chips|cornstarch|vanilla extract)/.test(
      n,
    )
  ) {
    return 'baking';
  }

  // Drinks
  if (
    /(coffee|espresso|tea|juice|soda|sparkling water|mineral water|seltzer|coconut water)/.test(
      n,
    )
  ) {
    return 'beverages';
  }

  return 'other';
}

export function prettyCategoryLabel(cat: PantryCategory): string {
  switch (cat) {
    case 'produce':
      return 'Produce';
    case 'protein':
      return 'Meat & Protein';
    case 'grains':
      return 'Grains';
    case 'dairy':
      return 'Dairy';
    case 'frozen':
      return 'Frozen';
    case 'canned':
      return 'Canned';
    case 'snacks':
      return 'Snacks';
    case 'condiments':
      return 'Condiments';
    case 'baking':
      return 'Baking';
    case 'beverages':
      return 'Beverages';
    default:
      return 'Other';
  }
}