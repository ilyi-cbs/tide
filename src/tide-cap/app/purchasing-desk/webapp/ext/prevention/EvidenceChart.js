sap.ui.define(
  [
    "sap/ui/core/Control",
    "sap/ui/core/ResizeHandler",
    "sap/ui/core/theming/Parameters",
    "sap/ui/core/Theming",
    "sap/ui/core/format/DateFormat",
    "sap/ui/core/format/NumberFormat",
    "highcharts/esm/highcharts",
    "highcharts/esm/modules/accessibility",
  ],
  function (
    Control,
    ResizeHandler,
    Parameters,
    Theming,
    DateFormat,
    NumberFormat,
    Highcharts,
  ) {
    "use strict";

    const dates = DateFormat.getDateInstance({ style: "medium", UTC: true });
    const numbers = NumberFormat.getFloatInstance({
      maxFractionDigits: 6,
      groupingEnabled: true,
    });

    function numeric(value) {
      if (
        value == null ||
        typeof value === "boolean" ||
        String(value).trim() === ""
      )
        return null;
      return Number.isFinite(Number(value)) ? Number(value) : null;
    }

    function escape(value) {
      return String(value ?? "").replace(/[&<>"']/g, function (character) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[character];
      });
    }

    function bounds(values) {
      const valid = values.map(numeric).filter(function (value) {
        return value !== null && value >= 0;
      });
      if (!valid.length) return {};
      const low = Math.min.apply(null, valid);
      const high = Math.max.apply(null, valid);
      const padding = Math.max((high - low) * 0.12, high * 0.02, 0.000001);
      return {
        min: Math.max(0, low - padding),
        max: high + padding,
        startOnTick: false,
        endOnTick: false,
      };
    }

    function options(data) {
      const colors =
        Parameters.get({
          name: [
            "sapChart_OrderedColor_1",
            "sapChart_OrderedColor_2",
            "sapIndicationColor_6",
            "sapTextColor",
            "sapContent_LabelColor",
            "sapList_BorderColor",
            "sapCriticalColor",
            "sapFontFamily",
          ],
        }) || {};
      const primary = colors.sapChart_OrderedColor_1 || "#0070f2";
      const secondary = colors.sapChart_OrderedColor_2 || "#e76500";
      const result = {
        chart: {
          type: "scatter",
          backgroundColor: "transparent",
          animation: false,
          style: { fontFamily: colors.sapFontFamily },
          spacing: [20, 16, 16, 8],
        },
        time: { timezone: "UTC" },
        title: { text: null },
        credits: { enabled: false },
        accessibility: {
          enabled: true,
          description: data.description || data.title,
        },
        legend: { enabled: true, itemStyle: { color: colors.sapTextColor } },
        xAxis: {
          lineColor: colors.sapList_BorderColor,
          labels: { style: { color: colors.sapContent_LabelColor } },
        },
        yAxis: {
          title: { text: data.unit || "" },
          gridLineColor: colors.sapList_BorderColor,
          labels: { style: { color: colors.sapContent_LabelColor } },
        },
        tooltip: { useHTML: false },
        plotOptions: {
          series: {
            animation: false,
            turboThreshold: 0,
            marker: { radius: 5 },
          },
        },
        series: [],
      };
      if (data.kind === "deliveryHistory") {
        const points = (data.points || []).filter(function (point) {
          return (
            Number.isFinite(point.x) &&
            numeric(point.y) !== null &&
            Number(point.y) >= 0
          );
        });
        result.legend.enabled = false;
        result.xAxis.type = "datetime";
        result.xAxis.minTickInterval = 86400000;
        result.yAxis.min = 0;
        result.yAxis.title.text = "Order to availability (days)";
        result.yAxis.plotLines = [
          {
            value: numeric(data.median),
            color: secondary,
            label: { text: "Historical median" },
          },
          {
            value: numeric(data.planned),
            color: primary,
            label: {
              text: data.plannedLabel || "PO planned delivery duration",
            },
          },
        ]
          .filter(function (line) {
            return line.value !== null && line.value >= 0;
          })
          .map(function (line, index) {
            return Object.assign(line, {
              width: 1,
              dashStyle: "Dash",
              label: Object.assign(line.label, {
                align: "left",
                x: 8,
                y: index ? 14 : -6,
                style: { color: colors.sapTextColor },
              }),
            });
          });
        result.tooltip.formatter = function () {
          const point = this.point || this;
          const custom = point.custom || {};
          return (
            "<b>" +
            escape(point.name) +
            "</b><br/>Available: " +
            escape(dates.format(new Date(point.x))) +
            "<br/>Observed: " +
            escape(numbers.format(point.y)) +
            " days" +
            (custom.ordered ? "<br/>Ordered: " + escape(custom.ordered) : "") +
            (custom.requested
              ? "<br/>Requested: " + escape(custom.requested)
              : "")
          );
        };
        result.series = [
          {
            name: "Observed completed items",
            color: colors.sapIndicationColor_6 || "#0f828f",
            data: points,
          },
        ];
      } else if (data.kind === "scenarioDelay") {
        result.chart.type = "line";
        result.legend.enabled = false;
        result.xAxis.type = "datetime";
        result.xAxis.minTickInterval = 86400000;
        result.xAxis.title = { text: "Forecast arrival date" };
        result.yAxis.min = 0;
        result.yAxis.allowDecimals = false;
        result.yAxis.title.text = "Customer delay (calendar days)";
        result.tooltip.formatter = function () {
          const point = this.point || this;
          return (
            "<b>" +
            escape(point.name) +
            "</b><br/>Arrival: " +
            escape(dates.format(new Date(point.x))) +
            "<br/>Customer delay: " +
            escape(numbers.format(point.y)) +
            " calendar days" +
            (numeric(point.custom?.revenue) !== null
              ? "<br/>Revenue exposure: " +
                escape(numbers.format(point.custom.revenue)) +
                " EUR"
              : "")
          );
        };
        result.series = [
          {
            name: "Customer delay",
            color: secondary,
            data: data.points || [],
            dataLabels: { enabled: false },
          },
        ];
      } else if (data.kind === "delayBars") {
        const rows = (data.rows || [])
          .filter(function (row) {
            return numeric(row.value) !== null && Number(row.value) > 0;
          })
          .slice()
          .sort(function (left, right) {
            return right.value - left.value;
          })
          .slice(0, 5);
        result.chart.type = "bar";
        result.legend.enabled = false;
        result.xAxis.categories = rows.map(function (row) {
          return row.label;
        });
        result.xAxis.labels.style.width = "140px";
        result.yAxis.min = 0;
        result.yAxis.allowDecimals = false;
        result.yAxis.title.text = data.unit;
        result.tooltip.formatter = function () {
          const point = this.point || this;
          const row = point.custom;
          return (
            "<b>" +
            escape(row.label) +
            "</b><br/>" +
            escape(numbers.format(point.y)) +
            " " +
            escape(data.unit) +
            (row.detail ? "<br/>" + escape(row.detail) : "") +
            (row.requiredDate
              ? "<br/>Required: " + escape(row.requiredDate)
              : "") +
            (numeric(row.revenue) !== null
              ? "<br/>Revenue exposure: " +
                escape(numbers.format(row.revenue)) +
                " " +
                escape(row.currency)
              : "") +
            (numeric(row.quantity) !== null
              ? "<br/>Quantity: " +
                escape(numbers.format(row.quantity)) +
                " " +
                escape(row.quantityUnit)
              : "")
          );
        };
        result.series = [
          {
            name: data.title,
            color: data.color || secondary,
            data: rows.map(function (row) {
              return { y: Number(row.value), custom: row };
            }),
            dataLabels: { enabled: true },
          },
        ];
        result.responsive = {
          rules: [
            {
              condition: { maxWidth: 400 },
              chartOptions: {
                xAxis: {
                  labels: { style: { width: "90px", fontSize: "11px" } },
                },
              },
            },
          ],
        };
      } else if (data.kind === "price") {
        const points = (data.points || []).filter(function (point) {
          return (
            Number.isFinite(point.x) &&
            numeric(point.y) !== null &&
            Number(point.y) >= 0
          );
        });
        const median = numeric(data.median);
        result.xAxis.type = "datetime";
        result.xAxis.minTickInterval = 86400000;
        Object.assign(
          result.yAxis,
          bounds(
            points
              .map(function (point) {
                return point.y;
              })
              .concat(median),
          ),
        );
        result.yAxis.plotLines =
          median !== null && median >= 0
            ? [
                {
                  value: median,
                  color: secondary,
                  width: 1,
                  dashStyle: "Dash",
                  label: {
                    text: "Historical median",
                    style: { color: colors.sapTextColor },
                  },
                },
              ]
            : [];
        result.tooltip.formatter = function () {
          const point = this.point || this;
          return (
            "<b>" +
            escape(point.name) +
            "</b><br/>" +
            escape(dates.format(new Date(point.x))) +
            "<br/>Normalized unit price: " +
            escape(numbers.format(point.y)) +
            " " +
            escape(data.unit || "") +
            "<br/>" +
            (point.current ? "Current PO item" : "Earlier comparable price") +
            (median > 0
              ? "<br/>" +
                escape(
                  numbers.format(
                    Math.round(Math.abs(point.y / median - 1) * 10000) / 100,
                  ),
                ) +
                "% " +
                (point.y < median ? "below" : "above") +
                " historical median"
              : "")
          );
        };
        result.series = [
          {
            name: "Earlier comparable prices",
            color: primary,
            data: points.filter(function (point) {
              return !point.current;
            }),
          },
          {
            name: "Current PO item",
            color: secondary,
            marker: { symbol: "diamond", radius: 7 },
            data: points.filter(function (point) {
              return point.current;
            }),
          },
        ];
      } else if (data.kind === "candidateActivity") {
        result.chart.type = "column";
        result.legend.enabled = false;
        result.xAxis.categories = data.rows.map(function (row) {
          return row.label;
        });
        result.yAxis.min = 0;
        result.yAxis.allowDecimals = false;
        result.yAxis.title.text = data.title;
        result.plotOptions.series.dataLabels = { enabled: true };
        result.series = [
          {
            name: data.title,
            color: data.metric === "orders" ? primary : secondary,
            data: data.rows.map(function (row) {
              return numeric(row[data.metric]);
            }),
          },
        ];
      } else if (data.kind === "activity") {
        result.chart.type = "bar";
        result.xAxis.categories = data.rows.map(function (row) {
          return row.label;
        });
        result.yAxis.min = 0;
        result.yAxis.allowDecimals = false;
        result.yAxis.title.text = "Activity in the last 12 months";
        result.series = [
          {
            name: "PO orders",
            color: primary,
            data: data.rows.map(function (row) {
              return row.orders;
            }),
          },
          {
            name: "Material movements",
            color: secondary,
            data: data.rows.map(function (row) {
              return row.movements;
            }),
          },
        ];
      } else if (data.kind === "peers") {
        result.chart.type = "bar";
        result.xAxis.categories = data.rows.map(function (row) {
          return row.label;
        });
        result.yAxis.min = 0;
        result.yAxis.allowDecimals = false;
        result.yAxis.title.text = "Peer materials with both values";
        result.legend.enabled = false;
        result.series = [
          {
            name: "Materials with both values",
            color: primary,
            data: data.rows.map(function (row) {
              return row.count;
            }),
            dataLabels: { enabled: true },
          },
        ];
      } else if (data.kind === "setting") {
        const current = numeric(data.current);
        const proposed = numeric(data.proposed);
        if (
          current === null ||
          proposed === null ||
          current < 0 ||
          proposed < 0
        )
          return result;
        result.xAxis.title = { text: "Days" };
        Object.assign(result.xAxis, bounds([current, proposed]));
        result.yAxis.categories = ["Planned time"];
        result.yAxis.title.text = "";
        result.yAxis.labels.enabled = false;
        result.yAxis.min = -0.5;
        result.yAxis.max = 0.5;
        result.yAxis.gridLineWidth = 0;
        if (Number.isFinite(data.tolerance) && data.tolerance >= 0) {
          const from = Math.max(0, current - data.tolerance);
          const to = current + data.tolerance;
          Object.assign(result.xAxis, bounds([current, proposed, from, to]));
          result.xAxis.plotBands = [
            {
              from: from,
              to: to,
              color: Highcharts.color(primary).setOpacity(0.08).get(),
              label: {
                text: "Allowed tolerance",
                style: { color: colors.sapContent_LabelColor },
              },
            },
          ];
        }
        result.tooltip.formatter = function () {
          return (
            "Current: " +
            escape(numbers.format(current)) +
            " days<br/>Proposed: " +
            escape(numbers.format(proposed)) +
            " days<br/>Change: " +
            (proposed > current ? "+" : "") +
            escape(numbers.format(proposed - current)) +
            " days"
          );
        };
        result.series = [
          {
            type: "line",
            name: "Change",
            showInLegend: false,
            enableMouseTracking: false,
            color: colors.sapList_BorderColor || "#89919a",
            marker: { enabled: false },
            data: [
              { x: Math.min(current, proposed), y: 0 },
              { x: Math.max(current, proposed), y: 0 },
            ],
          },
          {
            name: "Current setting",
            color: primary,
            data: [{ x: current, y: 0 }],
          },
          {
            name: "Proposed setting",
            color: secondary,
            marker: { symbol: "diamond", radius: 7 },
            data: [{ x: proposed, y: 0 }],
          },
        ];
      }
      return result;
    }

    const EvidenceChart = Control.extend(
      "tide.cockpit.ext.prevention.EvidenceChart",
      {
        metadata: {
          properties: {
            data: { type: "object", defaultValue: null },
            height: { type: "sap.ui.core.CSSSize", defaultValue: "18rem" },
          },
        },
        init: function () {
          this._themeChanged = this.invalidate.bind(this);
          Theming.attachApplied(this._themeChanged);
        },
        renderer: {
          apiVersion: 2,
          render: function (manager, control) {
            manager
              .openStart("div", control)
              .class("tidePreventionChart")
              .style("height", control.getHeight())
              .openEnd()
              .close("div");
          },
        },
        onBeforeRendering: function () {
          this._chart?.destroy();
          this._chart = null;
        },
        onAfterRendering: function () {
          if (!this._resizeId)
            this._resizeId = ResizeHandler.register(
              this,
              function () {
                if (this._chart) this._chart.reflow();
                else this._renderChart();
              }.bind(this),
            );
          this._renderChart();
        },
        _renderChart: function () {
          const host = this.getDomRef();
          const data = this.getData();
          if (!host || host.clientWidth <= 0 || !data || this._chart) return;
          this._chart = Highcharts.chart(host, options(data));
        },
        exit: function () {
          this.onBeforeRendering();
          Theming.detachApplied(this._themeChanged);
          if (this._resizeId) ResizeHandler.deregister(this._resizeId);
        },
      },
    );
    EvidenceChart.options = options;
    return EvidenceChart;
  },
);
