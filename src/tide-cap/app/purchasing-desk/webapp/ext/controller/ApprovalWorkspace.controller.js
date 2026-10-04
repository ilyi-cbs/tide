sap.ui.define(
  [
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel",
    "tide/cockpit/ext/approvals/ApprovalWorkspace",
  ],
  function (ControllerExtension, JSONModel, Workspace) {
    "use strict";

    return ControllerExtension.extend(
      "tide.cockpit.ext.controller.ApprovalWorkspace",
      {
        override: {
          onInit: function () {
            this.base
              .getView()
              .setModel(
                new JSONModel({
                  canDecide: false,
                  canApprove: false,
                  canLogOutcome: false,
                }),
                "approval",
              );
          },
        },
        _source: function () {
          return Workspace.forView(this.base.getView());
        },
        onApprove: function () {
          const source = this._source();
          if (source)
            Workspace.onApprove({
              getSource: function () {
                return source;
              },
            });
        },
        onDecline: function () {
          const source = this._source();
          if (source)
            Workspace.onDecline({
              getSource: function () {
                return source;
              },
            });
        },
        onLogOutcome: function () {
          const source = this._source();
          if (source)
            Workspace.onLogOutcome({
              getSource: function () {
                return source;
              },
            });
        },
      },
    );
  },
);
