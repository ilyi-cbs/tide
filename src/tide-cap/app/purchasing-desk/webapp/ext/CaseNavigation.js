(function (factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else sap.ui.define([], factory);
})(function () {
  "use strict";
  const entities = {
    delivery: "DeliveryRisks",
    price: "PriceDeviations",
    duplicate: "DuplicateMaterials",
    unusual_setting: "UnusualSettings",
    supplier_planned_time: "SupplierPlannedTimes",
    material_planned_time: "MaterialPlannedTimes",
    requisition_review: "RequisitionReviews",
  };
  const aliases = {
    at_risk: "delivery",
    overdue: "delivery",
    rare: "unusual_setting",
    pdt: "supplier_planned_time",
    mm_pdt: "material_planned_time",
    freetext: "requisition_review",
    requisition: "requisition_review",
  };
  function caseHash(id, kind) {
    const text = String(id);
    const prefix = text.split(":", 1)[0];
    const resolved = kind || aliases[prefix] || prefix;
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
    const entity = entities[resolved];
    if (!entity) return "";
    const key =
      resolved === "delivery"
        ? "delivery:" + text.slice(text.indexOf(":") + 1)
        : text;
    if (resolved === "delivery")
      return (
        "#DeliveryRisks('" + encodeURIComponent(encodeURIComponent(key)) + "')"
      );
    return (
      "#" +
      entity +
      "('" +
      encodeURIComponent(encodeURIComponent(key.replace(/'/g, "''"))).replace(
        /'/g,
        "%2527",
      ) +
      "')"
    );
  }
  return { entities: entities, caseHash: caseHash };
});
