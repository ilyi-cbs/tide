// Pure domain of the rule lists (P-13): no CDS, no I/O, "today" is the asOf parameter.
// Named constants of the rules.

/** Visibility starts on the first calendar day after the requested date. */
export const OVERDUE_DAYS = 0;
/** Thirty days is an escalation milestone, not a visibility gap. */
export const OVERDUE_ESCALATION_DAYS = 30;
export const PRICE_FACTORS = [10, 100, 1000] as const;
export const PRICE_BAND = 0.15;
export const PRICE_MIN_PRIOR = 3;
export const PRICE_WINDOW_DAYS = 30;
export const ACTIVE_MONTHS = 24;
export const RECENT_MONTHS = 12;
export const PAIR_FIELDS = [
  "ProcurementType",
  "ProcurementSubType",
  "MRPType",
  "LotSizingProcedure",
  "MRPResponsible",
] as const;
export type PairField = (typeof PAIR_FIELDS)[number];

/** Buyer words of the planning fields (first view). */
export const FIELD_WORDS: Record<PairField, string> = {
  ProcurementType: "procurement type",
  ProcurementSubType: "special procurement",
  MRPType: "MRP type",
  LotSizingProcedure: "lot size",
  MRPResponsible: "MRP controller",
};
