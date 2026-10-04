// P-8 constants, types and date helpers (pure).
import { addDays, daysBetween } from "../kernel/calendar";
import { PREDICTION_PROFILES } from "../kernel/prediction-profiles";

export { addDays };
export const days = daysBetween;
export const TARGETS = [
  "late_by_days",
  "lead_time_days",
  "partial_delivery",
] as const;
export type Target = (typeof TARGETS)[number];
export const REGIONS = ["domestic", "eu", "overseas"] as const;

/** The 13 features, all known at PO creation. Outcome columns never enter (test enforces). */
export const PREDICT_FEATURES = PREDICTION_PROFILES.orderQuestion.features;
/** Columns known only after the PO date; labels read them, features never. */
export const OUTCOME_COLUMNS = [
  "AvailableDate",
  "ReceivedQuantity",
  "PartialFirstReceipt",
  "LeadTimeDays",
  "ArrivalDate",
];

export const BACKTEST_DAYS = 56;
export const MIN_LATE_DAYS = 1;
export const MAX_LATE_DAYS = 60;
export const MIN_CONTEXT = 100;
export const MAX_CONTEXT = 3_000;
export const MAX_ROWS = 300;
export const SAMPLE_SEED = 1;
export const MIN_EVALUATED = 30;
export const MIN_PER_CLASS = 5;
export const MIN_AUC = 0.6;
export const TOP_K = 10;
export const SHOW_ROWS = 20;
export const LEVELS = [0.1, 0.5, 0.9];
export const NEW_ORDER = "(new order)";

export const TOO_LITTLE = "not enough history to check this";
export const REFUSAL =
  "I can't predict this reliably: on the last 8 weeks my ranking was not clearly better than the normal rate";

export type Verdict = "pass" | "fail" | "too little";

export interface Filters {
  buyer?: string;
  purchasingGroup?: string;
  plant?: string;
  supplier?: string;
  supplierRegion?: (typeof REGIONS)[number];
  materialType?: string;
  materialGroup?: string;
  material?: string;
  poDateFrom?: string;
  poDateTo?: string;
}

export interface Request {
  target: Target;
  lateDays: number | null;
  key: { material: string; supplier: string; plant: string } | null;
  filters: Filters;
}

/** One PO item (first schedule line) with what the features and labels need. */
export interface Item {
  id: string; // PurchaseOrder/PurchaseOrderItem
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  Material: string | null;
  Supplier: string | null;
  Plant: string | null;
  PurchasingGroup: string | null;
  MaterialType: string | null;
  MaterialGroup: string | null;
  SupplierCountry: string | null;
  PlannedDays: number | null;
  OrderQuantity: number | null;
  NetAmountEUR: number | null;
  PurchaseOrderDate: string; // YYYY-MM-DD
  RequestedDate: string | null;
  AvailableDate: string | null;
  PartialFirstReceipt: boolean | null;
  IsOpen: boolean | null;
}

export class FormError extends Error {
  status = 400;
}
export const bad = (message: string) => new FormError(message);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: unknown): v is string =>
  typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
