/** Service categories (must match the database check in Migration 4). */
export const SERVICE_CATEGORIES = [
  { value: "engine", label: "Engine" },
  { value: "drivetrain", label: "Drivetrain (clutches, belt, chaincase)" },
  { value: "track_suspension", label: "Track & suspension" },
  { value: "fuel_oil", label: "Fuel & oil" },
  { value: "cooling", label: "Cooling" },
  { value: "electrical", label: "Electrical" },
  { value: "brakes", label: "Brakes" },
  { value: "steering_skis", label: "Steering & skis" },
  { value: "body_accessories", label: "Body & accessories" },
  { value: "inspection", label: "Inspection" },
  { value: "other", label: "Other" },
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]["value"];

export const CATEGORY_VALUES = SERVICE_CATEGORIES.map((c) => c.value) as [ServiceCategory, ...ServiceCategory[]];

/** Short labels for badges. */
export const CATEGORY_SHORT_LABELS: Record<ServiceCategory, string> = {
  engine: "Engine",
  drivetrain: "Drivetrain",
  track_suspension: "Track & suspension",
  fuel_oil: "Fuel & oil",
  cooling: "Cooling",
  electrical: "Electrical",
  brakes: "Brakes",
  steering_skis: "Steering & skis",
  body_accessories: "Body & accessories",
  inspection: "Inspection",
  other: "Other",
};

/** Database limits (Migration 2). */
export const MAX_ITEMS = 100;
