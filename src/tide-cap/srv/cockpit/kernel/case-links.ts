// UI hash links for cases; must match app/purchasing-desk/webapp/ext/CaseNavigation.js.
export const CASE_LINK_ENTITIES: Record<string, string> = {
  delivery: "DeliveryRisks",
  price: "PriceDeviations",
  duplicate: "DuplicateMaterials",
  unusual_setting: "UnusualSettings",
  supplier_planned_time: "SupplierPlannedTimes",
  material_planned_time: "MaterialPlannedTimes",
  requisition_review: "RequisitionReviews",
};

const ALIASES: Record<string, string> = {
  at_risk: "delivery",
  overdue: "delivery",
  rare: "unusual_setting",
  pdt: "supplier_planned_time",
  mm_pdt: "material_planned_time",
  freetext: "requisition_review",
  requisition: "requisition_review",
};

export function caseHash(id: string, kind?: string): string {
  const text = String(id);
  const prefix = text.split(":", 1)[0];
  const resolved = kind || ALIASES[prefix] || prefix;
  if (resolved === "requisition_review") {
    const parts = text.slice(text.indexOf(":") + 1).split("/");
    return (
      "#PurchaseRequisitionReviews(PurchaseRequisition='" +
      encodeURIComponent(parts[0]) +
      "',PurchaseRequisitionItem='" +
      encodeURIComponent(parts[1]) +
      "',IsActiveEntity=true)"
    );
  }
  const entity = CASE_LINK_ENTITIES[resolved];
  if (!entity) return "";
  if (resolved === "delivery") {
    const key = "delivery:" + text.slice(text.indexOf(":") + 1);
    return (
      "#DeliveryRisks('" + encodeURIComponent(encodeURIComponent(key)) + "')"
    );
  }
  return (
    "#" +
    entity +
    "('" +
    encodeURIComponent(encodeURIComponent(text.replace(/'/g, "''"))).replace(
      /'/g,
      "%2527",
    ) +
    "')"
  );
}
