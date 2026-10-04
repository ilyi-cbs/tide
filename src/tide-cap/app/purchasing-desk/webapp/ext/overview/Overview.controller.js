sap.ui.define(
  [
    "sap/fe/core/PageController",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/resource/ResourceModel",
    "sap/ui/core/format/NumberFormat",
    "sap/ui/core/format/DateFormat",
    "tide/cockpit/ext/overview/openList",
    "tide/cockpit/ext/findingLink",
  ],
  function (
    PageController,
    JSONModel,
    ResourceModel,
    NumberFormat,
    DateFormat,
    openList,
    findingLink,
  ) {
    "use strict";

    const REFRESH_MS = 5000;

    return PageController.extend("tide.cockpit.ext.overview.Overview", {
      onInit: function () {
        PageController.prototype.onInit.apply(this, arguments);
        const view = this.getView();
        view.setModel(
          new JSONModel({
            subtitle: "",
            narrative: "",
            kpis: {},
            topPriorities: [],
            arrivedToday: [],
            trend: [],
            priorityTrend: [],
            priorityTrendHasData: false,
            changeSummary: null,
            topSuppliers: [],
            header: {},
            initialLoading: true,
            refreshFailed: false,
            lastSuccessfulUpdate: "",
          }),
          "ov",
        );
      },

      onBeforeRendering: function () {
        if (!this._started) {
          this._started = true;
          this._delay = REFRESH_MS;
          this._poll();
        }
      },

      onExit: function () {
        this._disposed = true;
        clearTimeout(this._timer);
      },

      _poll: function () {
        const run = document.hidden ? Promise.resolve(true) : this.refresh();
        run.then(
          function (ok) {
            if (this._disposed) return;
            this._delay =
              ok === false ? Math.min(this._delay * 2, 60000) : REFRESH_MS;
            this._timer = setTimeout(this._poll.bind(this), this._delay);
          }.bind(this),
        );
      },

      /** The i18nOverview model (registered by the manifest; created here if missing). */
      _bundle: function () {
        const view = this.getView();
        let model =
          view.getModel("i18nOverview") ||
          this.getAppComponent().getModel("i18nOverview");
        if (!model) {
          model = new ResourceModel({
            bundleName: "tide.cockpit.ext.overview.i18n",
            async: true,
          });
          view.setModel(model, "i18nOverview");
        }
        return Promise.resolve(model.getResourceBundle());
      },

      /** Uses stored overview rows; the event-feed fragment polls Events independently. */
      refresh: function () {
        if (this._disposed) return Promise.resolve();
        const model = this.getView().getModel();
        const dom = this.getView().getDomRef();
        // Only while the page is shown (FE keeps it alive after navigating away).
        if (!model || this._busy || (dom && !dom.offsetParent && this._started))
          return Promise.resolve();
        this._busy = true;
        const op = this.getView()
          .getModel("publication")
          .bindContext("/overview(...)");
        const me = this._me ? null : model.bindContext("/me(...)");
        return Promise.all(
          [op, me].map(function (binding) {
            if (!binding) return null;
            return binding
              .invoke()
              .then(function () {
                return binding.getBoundContext().requestObject();
              })
              .finally(function () {
                binding.destroy();
              });
          }),
        )
          .then(
            function (results) {
              if (this._disposed) return;
              if (results[1]) this._me = results[1];
              return this._bundle().then(
                function (bundle) {
                  if (!this._disposed)
                    this._apply(results[0] || {}, this._me || {}, bundle);
                }.bind(this),
              );
            }.bind(this),
          )
          .catch(
            function () {
              if (this._disposed) return false;
              const ov = this.getView().getModel("ov");
              ov.setProperty("/initialLoading", false);
              ov.setProperty("/refreshFailed", true);
              return false;
            }.bind(this),
          )
          .finally(
            function () {
              this._busy = false;
            }.bind(this),
          );
      },

      _apply: function (o, me, bundle) {
        const ov = this.getView().getModel("ov");
        const k = o.kpis || {};
        const pub = o.publication || {};
        const short = NumberFormat.getFloatInstance({
          style: "short",
          maxFractionDigits: 1,
        });
        const known = k.revenueAtRisk !== null && k.revenueAtRisk !== undefined;
        const rev = known ? short.format(Number(k.revenueAtRisk)) : "";
        const notice =
          pub.source === "synthetic"
            ? "pubSynthetic"
            : pub.source === "operational" && pub.completeness !== "complete"
              ? "pubPartial"
              : null;
        ov.setProperty(
          "/publicationNotice",
          notice
            ? bundle.getText(notice, [
                pub.completeness || "-",
                pub.publishedAt || "-",
              ])
            : "",
        );
        ov.setProperty(
          "/publicationNoticeType",
          notice === "pubSynthetic" ? "Information" : "Warning",
        );
        ov.setProperty(
          "/revenueSub",
          !known
            ? bundle.getText("kpiRevenueUnavailable")
            : k.revenuePartial
              ? bundle.getText("kpiRevenuePartial")
              : bundle.getText("kpiRevenueSub"),
        );
        ov.setProperty(
          "/subtitle",
          o.asOf
            ? bundle.getText("ovAsOf", [o.asOf])
            : bundle.getText("ovAsOfUnknown"),
        );
        ov.setProperty("/narrative", o.narrative || "");
        ov.setProperty("/kpis", k);
        ov.setProperty(
          "/revenueValue",
          known ? rev.replace(/[^\d.,]/g, "") || "0" : "–",
        );
        ov.setProperty(
          "/revenueScale",
          known ? rev.replace(/[\d.,\s]/g, "") : "",
        );
        ov.setProperty(
          "/codesSub",
          bundle.getText("kpiRequestsSub", [
            String(k.requestsToReview || 0),
            String(k.requestsAwaitingApproval || 0),
          ]),
        );
        ov.setProperty("/topPriorities", o.topPriorities || []);
        ov.setProperty("/arrivedToday", o.arrivedToday || []);
        ov.setProperty("/trend", o.trend || []);
        ov.setProperty("/priorityTrend", o.priorityTrend || []);
        ov.setProperty("/asOf", o.asOf || "");
        ov.setProperty("/priorityTrendLabels", {
          critical: bundle.getText("priorityTrendCritical"),
          high: bundle.getText("priorityTrendHigh"),
          medium: bundle.getText("priorityTrendMedium"),
          low: bundle.getText("priorityTrendLow"),
          total: bundle.getText("priorityTrendTotal"),
          axis: bundle.getText("priorityTrendValueAxis"),
        });
        ov.setProperty(
          "/priorityTrendSubtitle",
          o.asOf
            ? bundle.getText("priorityTrendSubtitle", [
                DateFormat.getDateInstance({
                  day: "numeric",
                  month: "long",
                  UTC: true,
                }).format(new Date(o.asOf + "T00:00:00Z")),
              ])
            : bundle.getText("priorityTrendSubtitleEmpty"),
        );
        ov.setProperty(
          "/priorityTrendHasData",
          !!(o.priorityTrend && o.priorityTrend.length),
        );
        ov.setProperty("/changeSummary", o.changeSummary || null);
        ov.setProperty("/topSuppliers", o.topSuppliers || []);
        ov.setProperty(
          "/revenueByPriority",
          (o.revenueByPriority || []).filter(function (row) {
            return row.findingCount > 0;
          }),
        );
        ov.setProperty("/header", {
          userName: me.name || me.userId || "",
          userId: me.userId || "",
          currentDate: o.asOf
            ? DateFormat.getDateInstance({ style: "medium", UTC: true }).format(
                new Date(o.asOf + "T00:00:00Z"),
              )
            : "",
          lastUpdated: me.preparedAt
            ? bundle.getText("lastUpdated", [
                DateFormat.getDateTimeInstance({
                  style: "medium",
                  UTC: true,
                }).format(new Date(me.preparedAt)),
              ])
            : bundle.getText("lastUpdatedUnknown"),
        });
        ov.setProperty("/initialLoading", false);
        ov.setProperty("/refreshFailed", false);
        ov.setProperty(
          "/lastSuccessfulUpdate",
          bundle.getText("refreshLastSuccess", [
            DateFormat.getDateTimeInstance({ style: "short" }).format(
              new Date(),
            ),
          ]),
        );
      },

      _openList: function (list) {
        openList(this.getAppComponent().getRouter(), list);
      },

      /** Priority / arrived row press: opens the Finding's own object page (same hash form as FE's own navigation). */
      onBriefItemPress: function (event) {
        const context = event.getSource().getBindingContext("ov");
        const id = context && context.getProperty("ID");
        const hash = id && findingLink.findingHash(id);
        if (hash) window.location.hash = hash;
      },

      onOpenList: function (event) {
        this._openList(event.getSource().data("list"));
      },

      onOpenApprovals: function () {
        this.getAppComponent().getRouter().navTo("ActionsList");
      },
    });
  },
);
