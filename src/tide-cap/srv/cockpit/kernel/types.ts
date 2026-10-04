// Kernel types are shared by feature code and pure-domain tests.
import type cds from "@sap/cds";
import type { Meter } from "./model-calls";

export type Source =
  | "rule"
  | "lookup"
  | "empirical"
  | "tabpfn"
  | "fake"
  | "calculation"
  | "confirmation"
  | "fallback"
  | "none";

export type FindingList =
  | "at_risk"
  | "overdue"
  | "price"
  | "pdt"
  | "mm_pdt"
  | "freetext"
  | "duplicate"
  | "rare";

export const FINDING_LISTS: FindingList[] = [
  "at_risk",
  "overdue",
  "price",
  "pdt",
  "mm_pdt",
  "freetext",
  "duplicate",
  "rare",
];

export type ImpactLevel =
  | "customer_order_late"
  | "production_affected"
  | "stock_uncovered"
  | "covered_by_stock"
  | "no_impact";

export const IMPACT_LEVELS: ImpactLevel[] = [
  "customer_order_late",
  "production_affected",
  "stock_uncovered",
  "covered_by_stock",
  "no_impact",
];

export type ActionKind =
  | "reminder"
  | "pdt_change"
  | "worklist"
  | "code_list"
  | "pr_review"
  | "post_confirmation"
  | "price_check"
  | "price_clarification"
  | "mdg_case"
  | "planner_review";
export type ActionVia = "app" | "chat" | "feeder" | "mcp";
export type OperationKey =
  | "delivery_intervention"
  | "delivery_escalation"
  | "pdt_change"
  | "price_clarification"
  | "master_data_duplicate_review"
  | "planner_review"
  | "requisition_review"
  | "code_list"
  | "prediction_worklist"
  | "price_check"
  | "post_confirmation";
export type ExportFormat = "reminder" | "csv";
export type RequestType =
  | "Delivery Risk - At Risk"
  | "Delivery Risk - Overdue"
  | "Price Deviation"
  | "Duplicate Materials"
  | "Unusual Planning Setting"
  | "Configuration Review"
  | "Supplier Planned Time"
  | "Material Planned Time"
  | "Purchase Requisition Review"
  | "Code Suggestion Review"
  | "Prediction Worklist"
  | "Other Prepared Request";

export interface AtRiskDetailRow {
  source: Source;
  lateShare: number | null;
  gapDays: number;
  plannedDays: number | null;
  plannedFlag: string | null;
  riskRank: number;
  ruleVerdict: string | null;
  ownDeliveries: number;
  contextLevel: string | null;
  gridRef: string;
  fastDays: number | null;
  typicalDays: number | null;
  slowDays: number | null;
  dueCriticality: number;
}

export interface OverdueDetailRow {
  daysOverdue: number;
  overdueCriticality: number;
  confirmationStatus: string;
  confirmationCriticality: number;
  netAmount: number | null;
  currency: string | null;
}

export interface PriceDetailRow {
  unitPrice: number;
  priorMedian: number;
  priorCount: number;
  ratio: number;
  factor: number;
  direction: string;
  priceKey: string;
  currentPrice: number | null;
  priceQuantity: number | null;
  proposalPrice: number | null;
  potentialDifference?: number | null;
  currency: string | null;
  expectedP10?: number | null;
  expectedP50?: number | null;
  expectedP90?: number | null;
  deviationPercent?: number | null;
  tailPosition?: number | null;
  assessmentSource?: string | null;
  assessmentRunID?: string | null;
  calibrationStatus?: string | null;
}

export interface DuplicateDetailRow {
  groupKey: string;
  activity: number;
  candidateCount?: number;
  materialType?: string | null;
  materialNumbers?: string | null;
  mainPlant?: string | null;
  purchasingGroup?: string | null;
}
export interface RareDetailRow {
  groupSize: number;
  materialType?: string | null;
  unusualPairCount?: number;
  firstPair?: string | null;
}

export interface PdtDetailRow {
  proposalDays: number | null;
  proposalQuantile: number | null;
  proposalRule: string | null;
  currentDays: number | null;
  currentFrom: string | null;
  masterDays: number | null;
  purchasingInfoRecord: string | null;
  ownDeliveries: number | null;
  p10: number | null;
  p50: number | null;
  p80: number | null;
  p90: number | null;
  orders12m: number | null;
  value12mEUR: number | null;
  rangeSource: Source | null;
  rangeCount: number | null;
  rangeP10: number | null;
  rangeP50: number | null;
  rangeP80: number | null;
  rangeP90: number | null;
  rangeSentence: string | null;
  settingRecheck?: string | null;
  settingRange?: Record<string, any> | null;
}

export interface MmPdtSourceRow {
  supplier: string;
  supplierName: string | null;
  orders12m: number | null;
  orderShare: number | null;
  ownDeliveries: number | null;
  typicalDays: number | null;
  infoRecordDays: number | null;
  source: Source | null;
  pdtFindingID: string | null;
}

export interface MmPdtDetailRow {
  proposalDays: number | null;
  proposalRule: string | null;
  masterDays: number | null;
  masterFlag: string | null;
  difference: number | null;
  tolerance: number | null;
  orders12m: number | null;
  note: string | null;
  sources: MmPdtSourceRow[];
}

export interface FreetextDetailRow {
  requestedAt: string | null;
  requestText: string;
  codingText: string;
  segment: string | null;
  demo: boolean;
  contextRows: number;
  inputs: string;
}

/** Shared Finding header plus exactly one type-specific detail payload. */
export interface FindingRow {
  ID?: string;
  snapshot_ID?: string | null;
  list: FindingList;
  listText?: string | null;
  listCriticality?: number | null;
  objectKey: string;
  problemKey?: string | null;
  PurchaseOrder?: string | null;
  PurchaseOrderItem?: string | null;
  Material?: string | null;
  Supplier?: string | null;
  supplierDisplay?: string | null;
  Plant?: string | null;
  plantDisplay?: string | null;
  PurchasingGroup?: string | null;
  MRPController?: string | null;
  PurchaseRequisition?: string | null;
  PurchaseRequisitionItem?: string | null;
  itemTitle?: string | null;
  itemSubtitle?: string | null;
  issue?: string | null;
  issueTechnical?: string | null;
  impactLevel?: ImpactLevel | null;
  impactCriticality?: number | null;
  impactText?: string | null;
  deliveryPriority?: string | null;
  deliveryPriorityOrder?: number | null;
  deliveryPriorityCriticality?: number | null;
  predictedArrival?: string | null;
  arrivalSource?: string | null;
  revenueAtRisk?: number | null;
  dueDate?: string | null;
  nextStep?: string | null;
  nextActionKind?: ActionKind | null;
  changeAvailable?: boolean | null;
  source?: Source | null;
  sourceText?: string | null;
  chain?: string | null;
  technicalChain?: string | null;
  trigger?: "morning" | "arrived";
  status?: "open" | "closed";
  statusCriticality?: number | null;
  arrivedAt?: string | null;
  rank?: number | null;
  atRiskDetail?: AtRiskDetailRow;
  overdueDetail?: OverdueDetailRow;
  priceDetail?: PriceDetailRow;
  duplicateDetail?: DuplicateDetailRow;
  rareDetail?: RareDetailRow;
  pdtDetail?: PdtDetailRow;
  mmPdtDetail?: MmPdtDetailRow;
  freetextDetail?: FreetextDetailRow;
  /** Transitional input only; writers must migrate this payload into a typed detail. */
  expert?: string | null;
}

export type EventKind =
  | "morning"
  | "po_item"
  | "goods_receipt"
  | "confirmation"
  | "freetext"
  | "action"
  | "recompute"
  | "why";

/** A row of tide.cockpit.Event (§5). */
export interface EventRow {
  seq: number;
  at: string;
  simTime?: string | null;
  kind: EventKind;
  title: string;
  findingID?: string | null;
  objectKey?: string | null;
  source?: Source | null;
  status?: string | null;
  modelCalls?: number | null;
  costUnits?: number | null;
  latencyMs?: number | null;
  PurchasingGroup?: string | null;
  Plant?: string | null;
}

/** Context of one pipeline step (§4). */
export interface StepContext {
  user: cds.User;
  snapshotId: string;
  asOf: string; // YYYY-MM-DD
  dryRun: boolean;
  meter: Meter;
  publication?: {
    writes: Array<() => Promise<unknown>>;
    buyers?: Record<string, any>[];
    openItems?: Record<string, any>[];
    lineGrids?: Record<string, any>[];
    sourceRanges?: Record<string, any>[];
  };
}

export interface Step {
  name: string;
  required?: boolean;
  run(ctx: StepContext): Promise<void>;
}

export type IngestKind =
  "po_item" | "goods_receipt" | "confirmation" | "freetext";

export interface IngestEvent {
  kind: IngestKind;
  at: string; // ISO sim time
  rows: Record<string, any[]>; // entity set -> rows, s4 names
}

export interface HookResult {
  events: Array<Partial<EventRow>>;
}

export type Hook = (
  ev: IngestEvent,
  ctx: StepContext,
) => Promise<HookResult | void>;

/** What every feature folder's index.ts exports. */
export interface FeatureModule {
  step: Step;
  register(srv: cds.Service): void;
}
