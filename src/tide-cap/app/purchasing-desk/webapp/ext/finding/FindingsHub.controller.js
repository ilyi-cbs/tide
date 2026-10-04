sap.ui.define(
  [
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/NumberFormat",
    "tide/cockpit/ext/Nav",
  ],
  function (ControllerExtension, JSONModel, NumberFormat, Nav) {
    "use strict";

    /**
     * Compute chart bindings here because expanded headers load on demand.
     * Fragment-local formatters can resolve too late.
     */
    function trendHasData(trend) {
      return (
        Array.isArray(trend) &&
        trend.length > 0 &&
        trend.every(function (p) {
          return (
            p &&
            typeof p.revenueAtRisk === "number" &&
            isFinite(p.revenueAtRisk)
          );
        })
      );
    }

    /** [{asOf, revenueAtRisk}] -> [{x: index, y: revenueAtRisk}] for LineMicroChartPoint (no bindable index). */
    function trendPoints(trend) {
      return (trend || []).map(function (p, i) {
        return { x: i, y: p.revenueAtRisk };
      });
    }

    const REFRESH_MS = 5000;
    const shortFormat = NumberFormat.getFloatInstance({
      style: "short",
      maxFractionDigits: 1,
    });

    function splitScaled(value) {
      const formatted = shortFormat.format(Number(value || 0));
      return {
        value: formatted.replace(/[^\d.,]/g, "") || "0",
        scale: formatted.replace(/[\d.,\s]/g, ""),
      };
    }

    function reviewPercent(toReview, awaitingApproval, completed) {
      const total =
        Number(toReview || 0) +
        Number(awaitingApproval || 0) +
        Number(completed || 0);
      if (!total) return 0;
      return Math.max(
        0,
        Math.min(
          100,
          Math.round(
            ((Number(awaitingApproval || 0) + Number(completed || 0)) / total) *
              100,
          ),
        ),
      );
    }

    /** Supplies navigation actions and stored counts/trend data for the Findings List Report header. */
    return ControllerExtension.extend("tide.cockpit.ext.finding.FindingsHub", {
      override: {
        onInit: function () {
          this.base.getView().setModel(
            new JSONModel({
              trend: [],
              trendPoints: [],
              trendHasData: false,
              atRisk: 0,
              revenueAtRiskValue: "0",
              revenueAtRiskScale: "",
              pendingApprovals: 0,
              requestsToReview: 0,
              requestReviewPercent: 0,
              preventionFindings: 0,
            }),
            "hub",
          );
        },

        onBeforeRendering: function () {
          if (this._started) return;
          this._started = true;
          this._delay = REFRESH_MS;
          this._poll();
        },

        onExit: function () {
          this._disposed = true;
          clearTimeout(this._timer);
        },
      },

      _poll: function () {
        const dom = this.base.getView().getDomRef();
        // FE keeps the list alive after navigating away; skip while hidden.
        const hidden = document.hidden || (dom && !dom.offsetParent);
        (hidden ? Promise.resolve(true) : this.refresh()).then(
          function (ok) {
            if (this._disposed) return;
            this._delay =
              ok === false ? Math.min(this._delay * 2, 60000) : REFRESH_MS;
            this._timer = setTimeout(this._poll.bind(this), this._delay);
          }.bind(this),
        );
      },

      /** Stored state only: overview() reads stored rows. Never a model call. */
      refresh: function () {
        if (this._disposed) return Promise.resolve();
        const view = this.base.getView();
        const model = view.getModel();
        if (!model || this._busy) return Promise.resolve();
        this._busy = true;
        const op = view.getModel("publication").bindContext("/overview(...)");
        return op
          .invoke()
          .then(function () {
            return op.getBoundContext().requestObject();
          })
          .then(
            function (o) {
              if (this._disposed) return;
              const hub = view.getModel("hub");
              const trend = (o && o.trend) || [];
              const kpis = (o && o.kpis) || {};
              const revenue = splitScaled(kpis.revenueAtRisk);
              hub.setProperty("/trend", trend);
              hub.setProperty("/trendPoints", trendPoints(trend));
              hub.setProperty("/trendHasData", trendHasData(trend));
              hub.setProperty("/atRisk", kpis.atRisk || 0);
              hub.setProperty("/revenueAtRiskValue", revenue.value);
              hub.setProperty("/revenueAtRiskScale", revenue.scale);
              hub.setProperty("/pendingApprovals", kpis.pendingApprovals || 0);
              hub.setProperty("/requestsToReview", kpis.requestsToReview || 0);
              hub.setProperty(
                "/requestReviewPercent",
                reviewPercent(
                  kpis.requestsToReview,
                  kpis.requestsAwaitingApproval,
                  kpis.requestsCompleted,
                ),
              );
              hub.setProperty(
                "/preventionFindings",
                kpis.preventionFindings || 0,
              );
            }.bind(this),
          )
          .catch(function () {
            return false;
          })
          .finally(
            function () {
              op.destroy();
              this._busy = false;
            }.bind(this),
          );
      },

      onOpenOverview: function () {
        Nav.overview.call(this.base.getExtensionAPI());
      },

      onOpenApprovals: function () {
        Nav.approvals.call(this.base.getExtensionAPI());
      },

      onOpenRequests: function () {
        Nav.requests.call(this.base.getExtensionAPI());
      },

      onOpenPrevention: function () {
        Nav.prevention.call(this.base.getExtensionAPI());
      },

      onOpenSimulation: function () {
        Nav.simulation.call(this.base.getExtensionAPI());
      },
    });
  },
);
