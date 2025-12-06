// src/lib/healthyProfile.ts

// Describes the knobs we can use to steer the planner toward
// healthy, whole-food, family-friendly meals.
// All fields are optional so we can merge/override safely later.
export type HealthyProfile = {
  // Existing knobs
  wholeFoodFocus?: boolean;               // true = prioritize whole, minimally processed foods
  maxUltraProcessedMealsPerWeek?: number; // e.g. 0–2
  maxAddedSugarPerDay?: 'low' | 'medium' | 'no-limit';
  maxPrepTimePerMeal?: number | null;     // in minutes, null = no limit
  vegetarianMealsPerWeek?: number | null; // target number of vegetarian dinners
  kidFriendly?: boolean;                  // true = softer textures, simpler flavors
  budgetLevel?: 'tight' | 'normal' | 'flexible';

  // NEW: micro-survey knobs (all optional; only set when healthy mode is on)
  /** Main focus the user cares about most right now */
  primaryGoal?: 'feel_better' | 'weight' | 'metabolic';

  /** How they prefer to get protein across the week */
  proteinPreference?: 'mixed' | 'lean_animal' | 'plant_forward';

  /** How cautious they are with carbs */
  carbBias?: 'more_whole_grains' | 'lower_carb' | 'no_preference';
};

// Default profile we'll use when the user says
// "give me a healthy, whole-food focused plan".
export const DEFAULT_HEALTHY_WHOLE_FOOD_PROFILE: HealthyProfile = {
  wholeFoodFocus: true,
  maxUltraProcessedMealsPerWeek: 1,
  maxAddedSugarPerDay: 'low',
  maxPrepTimePerMeal: 40,
  vegetarianMealsPerWeek: 3,
  kidFriendly: false,     // we’ll override this when the user chooses kid-friendly
  budgetLevel: 'normal',
};