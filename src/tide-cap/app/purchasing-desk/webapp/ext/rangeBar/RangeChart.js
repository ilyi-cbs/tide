sap.ui.define(
  [
    "sap/ui/core/Control",
    "sap/ui/core/ResizeHandler",
    "sap/ui/core/format/DateFormat",
    "tide/cockpit/ext/outlook/HighchartsPreview",
    "sap/ui/core/format/NumberFormat",
  ],
  function (
    Control,
    ResizeHandler,
    DateFormat,
    HighchartsTimeline,
    NumberFormat,
  ) {
    "use strict";

    const displayDate = DateFormat.getDateInstance({
      style: "medium",
      UTC: true,
    });

    return Control.extend("tide.cockpit.ext.rangeBar.RangeChart", {
      metadata: {
        properties: {
          axisType: { type: "string", defaultValue: "linear" },
          lanes: { type: "object", defaultValue: null },
          selectedQuantile: { type: "float", defaultValue: 0.8 },
          asOfLabel: { type: "string", defaultValue: "As of" },
          feasibleLabel: { type: "string", defaultValue: "Meets need date" },
          infeasibleLabel: { type: "string", defaultValue: "After need date" },
          noRangeLabel: { type: "string", defaultValue: "No estimate" },
          p10: { type: "any", defaultValue: null },
          p50: { type: "any", defaultValue: null },
          p80: { type: "any", defaultValue: null },
          p90: { type: "any", defaultValue: null },
          ordered: { type: "any", defaultValue: null },
          requested: { type: "any", defaultValue: null },
          planned: { type: "any", defaultValue: null },
          asOf: { type: "any", defaultValue: null },
          unit: { type: "string", defaultValue: "days" },
          valueDecimals: { type: "int", defaultValue: -1 },
          includeZero: { type: "boolean", defaultValue: true },
          minimumPadding: { type: "float", defaultValue: 1 },
          chartTitle: { type: "string", defaultValue: "Lead-time range" },
          rangeTitle: { type: "string", defaultValue: "P10-P90 range" },
          requestedLabel: { type: "string", defaultValue: "Requested" },
          plannedLabel: { type: "string", defaultValue: "SAP planned" },
          labels: { type: "string", defaultValue: "" },
        },
        events: {
          scenarioSelect: { parameters: { quantile: { type: "float" } } },
        },
      },

      renderer: {
        apiVersion: 2,
        render: function (manager, control) {
          manager
            .openStart("div", control)
            .class("tideRangeChart")
            .openEnd()
            .close("div");
        },
      },

      onBeforeRendering: function () {
        this._chart?.destroy();
        this._chart = null;
      },

      onAfterRendering: function () {
        if (!this._resizeId) {
          this._resizeId = ResizeHandler.register(
            this,
            function () {
              if (this._chart) this._chart.reflow();
              else this._renderChart();
            }.bind(this),
          );
        }
        this._renderChart();
      },

      _renderChart: function () {
        const host = this.getDomRef();
        if (!host || host.clientWidth <= 0 || this._chart) return;
        const lanes = this.getLanes();
        if (Array.isArray(lanes)) {
          const valueFormat = NumberFormat.getFloatInstance({
            minFractionDigits: 2,
            maxFractionDigits: 2,
          });
          const labels = {
            chartTitle: this.getChartTitle(),
            needDate: this.getRequestedLabel(),
            today: this.getAsOfLabel(),
            feasible: this.getFeasibleLabel(),
            infeasible: this.getInfeasibleLabel(),
            noRange: this.getNoRangeLabel(),
            value: function (value) {
              return valueFormat.format(value);
            },
            date: function (value) {
              return displayDate.format(new Date(value));
            },
          };
          if (this.hasListeners?.("scenarioSelect"))
            labels.onSelect = function (quantile) {
              this.fireScenarioSelect({ quantile: quantile });
            }.bind(this);
          this._chart = HighchartsTimeline.renderLanes(
            host,
            {
              rows: lanes,
              axisType: this.getAxisType(),
              selectedQuantile: this.getSelectedQuantile(),
              asOf: this.getAsOf(),
              needDate: this.getRequested(),
            },
            labels,
          );
          return;
        }
        if (
          [this.getP10(), this.getP50(), this.getP80(), this.getP90()].every(
            function (value) {
              return value === null || value === undefined || value === "";
            },
          )
        )
          return;
        const words = this.getLabels().split("|");
        const duration = this.getAxisType() === "linear";
        const unit = this.getUnit();
        const decimals = this.getValueDecimals();
        const valueFormat =
          decimals < 0
            ? null
            : NumberFormat.getFloatInstance({
                minFractionDigits: decimals,
                maxFractionDigits: decimals,
              });
        this._chart = HighchartsTimeline.renderRange(
          host,
          {
            axisType: this.getAxisType(),
            includeZero: this.getIncludeZero(),
            minimumPadding: this.getMinimumPadding(),
            p10: this.getP10(),
            p50: this.getP50(),
            p80: this.getP80(),
            p90: this.getP90(),
            ordered: this.getOrdered(),
            requested: this.getRequested(),
            planned: this.getPlanned(),
            today: this.getAsOf(),
          },
          {
            chartTitle: words[4] || this.getChartTitle(),
            predictionWindow: this.getRangeTitle(),
            requestedDate: words[2] || this.getRequestedLabel(),
            sapPlanned: words[3] || this.getPlannedLabel(),
            unit: unit,
            value: function (value) {
              return duration
                ? (valueFormat ? valueFormat.format(value) : value) +
                    (unit ? " " + unit : "")
                : displayDate.format(new Date(value));
            },
            chanceBy: function (level) {
              const label =
                level === 10 ? words[0] : level === 90 ? words[1] : "";
              return "P" + level + (label ? " - " + label : "");
            },
          },
        );
      },

      exit: function () {
        this.onBeforeRendering();
        if (this._resizeId) ResizeHandler.deregister(this._resizeId);
        this._resizeId = null;
      },
    });
  },
);
