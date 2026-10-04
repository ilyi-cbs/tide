sap.ui.define(
  ["sap/m/VBox", "sap/m/VBoxRenderer", "sap/ui/core/InvisibleText"],
  function (VBox, VBoxRenderer, InvisibleText) {
    "use strict";
    function field(control) {
      let current = control;
      while (current && current.getItems) current = current.getItems()[0];
      return current;
    }
    return VBox.extend("tide.cockpit.ext.requisition.AssistedField", {
      metadata: { interfaces: ["sap.ui.core.IFormContent"] },
      renderer: VBoxRenderer,
      onBeforeRendering: function () {
        const label = this.getParent()?.getLabel?.();
        if (typeof label === "string") {
          if (!this._fieldLabel) {
            this._fieldLabel = new InvisibleText({ text: label }).toStatic();
            this.addDependent(this._fieldLabel);
          }
          this._fieldLabel.setText(label);
        }
        const labelID =
          typeof label === "string"
            ? this._fieldLabel.getId()
            : label?.getId?.();
        if (!labelID) return;
        this.findAggregatedObjects(true, function (control) {
          return (
            !control.isA("sap.m.Button") &&
            typeof control.addAriaLabelledBy === "function"
          );
        }).forEach(function (control) {
          if (!control.getAriaLabelledBy().includes(labelID))
            control.addAriaLabelledBy(labelID);
        });
      },
      getFocusDomRef: function () {
        return field(this)?.getFocusDomRef?.() || null;
      },
      getIdForLabel: function () {
        return field(this)?.getIdForLabel?.() || this.getId();
      },
      getAccessibilityInfo: function () {
        return field(this)?.getAccessibilityInfo?.() || {};
      },
    });
  },
);
