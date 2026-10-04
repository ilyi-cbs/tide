sap.ui.define(
  [
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel",
    "tide/cockpit/ext/CaseNavigation",
  ],
  function (ControllerExtension, JSONModel, CaseNavigation) {
    "use strict";

    const KPIS = ["price", "duplicates", "unusual", "supplier", "material"];

    return ControllerExtension.extend(
      "tide.cockpit.ext.prevention.PreventionHeader",
      {
        override: {
          routing: {
            onBeforeNavigation: function (contextInfo) {
              const context = contextInfo.bindingContext;
              if (!context?.getPath().startsWith("/PlannedTimes("))
                return false;
              const row = context.getObject();
              const hash = CaseNavigation.caseHash(row.caseID, row.caseKind);
              if (!hash) return true;
              window.location.hash = hash;
              return true;
            },
          },
          onInit: function () {
            this._disposed = false;
            this.base.getView().setModel(
              new JSONModel(
                Object.fromEntries(
                  KPIS.map(function (kpi) {
                    return [kpi, { count: null, status: "loading" }];
                  }),
                ),
              ),
              "prevention",
            );
          },

          onBeforeRendering: function () {
            if (this._started) return;
            this._started = true;
            this.refresh();
          },

          onExit: function () {
            this._disposed = true;
          },
        },

        refresh: function () {
          if (this._disposed) return Promise.resolve();
          if (this._pending) return this._pending;
          const view = this.base.getView();
          const model = view.getModel();
          if (!model) return Promise.resolve();
          const kpis = view.getModel("prevention");
          const operation = model.bindContext(
            "/PurchasingDeskService.preventionSummary(...)",
          );
          this._pending = operation
            .invoke()
            .then(function () {
              return operation.getBoundContext().requestObject();
            })
            .then(
              function (summary) {
                if (this._disposed) return;
                const counts = Object.fromEntries(
                  KPIS.map(function (key) {
                    const count = Number(summary[key]);
                    if (!Number.isSafeInteger(count) || count < 0)
                      throw new Error("Invalid finding count");
                    return [key, count];
                  }),
                );
                KPIS.forEach(function (key) {
                  kpis.setProperty(`/${key}`, {
                    count: counts[key],
                    status: "current",
                  });
                });
              }.bind(this),
            )
            .catch(
              function () {
                if (this._disposed) return;
                KPIS.forEach(function (key) {
                  const previous = kpis.getProperty(`/${key}/count`);
                  kpis.setProperty(`/${key}`, {
                    count: previous,
                    status: previous === null ? "unavailable" : "stale",
                  });
                });
              }.bind(this),
            )
            .finally(() => {
              this._pending = null;
            });
          return this._pending;
        },
      },
    );
  },
);
