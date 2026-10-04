sap.ui.define([], function () {
    "use strict";

    /** Finding lists that live in the Prevention worklist (route PreventionList), not Delivery Risks. */
    const PREVENTION_LISTS = ["price", "duplicate", "rare", "pdt", "mm_pdt", "prevention"];
    const TABS = {
        at_risk: "actionRequired",
        overdue: "actionRequired",
        delivery_risks: "actionRequired",
        freetext: "toReview",
        prevention: "price",
        pdt: "supplierPlannedTime",
        mm_pdt: "materialMasterPlannedTime",
    };

    /**
     * Opens the Delivery Risks or Prevention list. Prevention is partitioned by
     * dedicated Type tabs; the tab query selects the relevant starting view.
     */
    return function openList(router, list) {
        const route = list === "freetext"
            ? "RequestsList"
            : PREVENTION_LISTS.includes(list)
              ? "PreventionList"
              : ["at_risk", "overdue"].includes(list)
                ? "DeliveryRisksList"
                : "DeliveryRisksList";
        router.navTo(route, { "?query": { tab: TABS[list] || list } });
    };
});
