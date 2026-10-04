sap.ui.define([], function () {
  "use strict";

  function text(control, key, values) {
    const view = control.base.getView();
    const model = view.getModel("i18nFreetext");
    return model ? model.getResourceBundle().getText(key, values) : key;
  }

  return {
    origin: function (origin, value, source) {
      if (origin === "buyer_cleared") return text(this, "clearedByYou");
      if (
        origin === "buyer_changed" ||
        (value !== source && value !== null && value !== undefined)
      )
        return text(this, "changedByYou");
      return value !== null && value !== undefined && value !== ""
        ? text(this, "fromRequest")
        : text(this, "needsInput");
    },
    provenance: function (evidence, current) {
      if (!evidence) return "";
      const hasValue = evidence.current
        ? evidence.current.kind !== "missing"
        : current !== null && current !== undefined && current !== "";
      if (hasValue && evidence.origin === "source")
        return text(
          this,
          evidence.reviewed ? "fromRequestReviewed" : "fromRequest",
        );
      if (hasValue && evidence.origin === "ai")
        return text(this, evidence.reviewed ? "aiReviewed" : "aiNotReviewed");
      if (hasValue) return text(this, "changedByYou");
      if (evidence.cleared) return text(this, "clearedByYou");
      if (evidence.status === "pending") return text(this, "suggestionPending");
      if (evidence.status === "stale") return text(this, "suggestionStale");
      if (evidence.value)
        return text(this, "suggestionAvailable", [
          evidence.value,
          evidence.name,
        ]);
      return text(this, "suggestionUnavailable");
    },
    assistanceIcon: function (status) {
      return (
        {
          pending: "sap-icon://synchronize",
          available: "sap-icon://ai",
          stale: "sap-icon://alert",
          failed: "sap-icon://error",
          unavailable: "sap-icon://hint",
        }[status] || "sap-icon://hint"
      );
    },
    assistanceType: function (status) {
      return "Transparent";
    },
    assistanceEnabled: function (evidence) {
      return !!evidence && evidence.applicable !== false;
    },
    refreshSelected: function (evidence, current) {
      const missing = evidence?.current
        ? evidence.current.kind === "missing"
        : current === null || current === undefined || current === "";
      return (
        !!evidence?.capabilities?.canPredict &&
        (missing || ["stale", "failed"].includes(evidence.status))
      );
    },
    canUse: function (suggestion, current, editable) {
      return !!editable && !!suggestion && suggestion !== current;
    },
    showServices: function (category, performer, limit) {
      return (
        ["1", "9", "D", "B"].includes(category) ||
        !!performer ||
        (limit !== null && limit !== undefined)
      );
    },
  };
});
