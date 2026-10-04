const leadTimeFeatures = [
  "Material",
  "MaterialGroup",
  "MaterialType",
  "Plant",
  "Supplier",
  "SupplierCountry",
  "PurchaseOrderType",
  "Category",
  "OrderQuantity",
  "NetAmountEUR",
  "PlannedDays",
  "RequestedGapDays",
  "PurchaseOrderMonth",
];

export const PREDICTION_PROFILES = {
  source: {
    version: "source-first-availability-v2",
    feed: "CockpitLeadTimeFeed",
    target: "LeadTimeDays",
    features: leadTimeFeatures,
    semantics:
      "Days to first non-canceled availability; not complete fulfillment",
    context: "Same plant; availability and order date strictly before origin",
    support:
      "Origin-safe representative of the requested supplier; otherwise unavailable",
    fallback: "Explicit context quantiles or separately identified own history",
  },
  openItem: {
    version: "open-first-availability-v2",
    feed: "CockpitLeadTimeFeed",
    target: "LeadTimeDays",
    features: [
      "Material",
      "MaterialGroup",
      "MaterialType",
      "Supplier",
      "OrderQuantity",
      "PlannedDays",
    ],
    semantics:
      "First availability of an unreceived order; no remainder promise",
    context:
      "Same plant before origin; completed histories conditioned on overdue age",
    support: "At least two eligible historical rows",
    fallback:
      "Explicit context quantiles; empirical survivor evidence kept separate",
  },
  independentSetting: {
    version: "independent-setting-v2",
    feed: "CockpitLeadTimeFeed",
    target: "LeadTimeDays",
    features: leadTimeFeatures.filter(
      (feature) => !["PlannedDays", "RequestedGapDays"].includes(feature),
    ),
    semantics:
      "Independent first-availability comparator, not an optimal master setting",
    context: "Same plant; no maintained-time or requested-gap features",
    support:
      "At least five rows and real provider; complete supplier coverage for master comparison",
    fallback: "No operational proposal from fake or fallback output",
  },
  orderQuestion: {
    version: "order-question-v2",
    feed: "CockpitPredictFeed",
    target: "yClass or yDays, selected by the validated request",
    features: [
      "Plant",
      "PurchasingGroup",
      "Supplier",
      "SupplierRegion",
      "MaterialType",
      "MaterialGroup",
      "PlannedDays",
      "PlannedStatus",
      "RequestedGapDays",
      "OrderQuantity",
      "NetAmount",
      "POMonth",
      "OwnPastDeliveries",
    ],
    semantics:
      "First-availability lateness/duration or comparable-unit first-day partial delivery",
    context: "Creation-time features; temporal backtest before current scoring",
    support:
      "Diagnostic ranking may be unvalidated; worklist requires a passing check",
    fallback:
      "Explicit provider attribution; raw scores are not calibrated probabilities",
  },
  price: {
    version: "price-anomaly-v2-diagnostic",
    feed: "CockpitPriceFeed",
    target: "LogUnitPrice",
    features: [
      "Material",
      "MaterialGroup",
      "MaterialType",
      "Supplier",
      "Plant",
      "PurchasingOrganization",
      "OrderQuantity",
      "OrderUnit",
      "DateOffsetDays",
      "PurchaseOrderMonth",
    ],
    semantics:
      "Positive normalized price under exact scenario quantity, currency and unit",
    context:
      "Strictly earlier prices, partitioned by currency and unit; evaluated PO excluded for anomalies",
    support:
      "Compatible historical representative; valid finite price-space quantiles",
    fallback:
      "Historical reference remains separate; anomaly tuning is diagnostic, not calibrated",
  },
} as const;
