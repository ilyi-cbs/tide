sap.ui.define(
  [
    "sap/ui/core/Control",
    "sap/ui/core/ResizeHandler",
    "sap/ui/core/theming/Parameters",
    "sap/ui/core/Theming",
    "sap/ui/core/format/DateFormat",
    "highcharts/esm/highcharts",
    "highcharts/esm/modules/accessibility",
  ],
  function (
    Control,
    ResizeHandler,
    Parameters,
    Theming,
    DateFormat,
    Highcharts,
  ) {
    "use strict";

    const keys = ["critical", "high", "medium", "low"];
    const themeKeys = [
      "sapNegativeColor",
      "sapCriticalColor",
      "sapInformativeColor",
      "sapPositiveColor",
    ];
    const fallback = ["#bb0000", "#e76500", "#0070f2", "#107e3e"];
    const dates = DateFormat.getDateInstance({ style: "medium", UTC: true });

    function escape(value) {
      return String(value).replace(/[&<>"']/g, function (character) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[character];
      });
    }

    function options(rows, visibility, labels, title, asOf) {
      const theme =
        Parameters.get({
          name: themeKeys.concat([
            "sapTextColor",
            "sapContent_LabelColor",
            "sapList_BorderColor",
            "sapFontFamily",
          ]),
        }) || {};
      const points = (rows || [])
        .map(function (row) {
          return { x: Date.parse(row.day + "T00:00:00Z"), row: row };
        })
        .filter(function (point) {
          return (
            Number.isFinite(point.x) &&
            new Date(point.x).toISOString().slice(0, 10) === point.row.day &&
            keys.concat("total").every(function (key) {
              return Number.isInteger(point.row[key]) && point.row[key] >= 0;
            })
          );
        })
        .sort(function (left, right) {
          return left.x - right.x;
        });
      return {
        chart: {
          type: "column",
          backgroundColor: "transparent",
          animation: false,
          style: { fontFamily: theme.sapFontFamily },
          spacing: [16, 12, 16, 8],
        },
        time: { timezone: "UTC" },
        title: { text: null },
        credits: { enabled: false },
        accessibility: {
          enabled: true,
          description:
            title +
            (asOf ? ", as of " + asOf : "") +
            ". Recorded finding counts, not delivery-case counts.",
        },
        xAxis: {
          type: "datetime",
          minTickInterval: 86400000,
          lineColor: theme.sapList_BorderColor,
          labels: { style: { color: theme.sapContent_LabelColor } },
        },
        yAxis: {
          min: 0,
          allowDecimals: false,
          title: { text: labels.axis || "Open findings" },
          gridLineColor: theme.sapList_BorderColor,
          labels: { style: { color: theme.sapContent_LabelColor } },
        },
        legend: {
          itemStyle: { color: theme.sapTextColor },
          itemHiddenStyle: { color: theme.sapContent_LabelColor },
        },
        tooltip: {
          shared: true,
          useHTML: false,
          formatter: function () {
            const row = this.points?.[0]?.point.custom || this.custom;
            if (!row) return false;
            return (
              "<b>" +
              escape(dates.format(new Date(this.x))) +
              "</b><br/>" +
              keys
                .map(function (key) {
                  return escape(labels[key] || key) + ": " + row[key];
                })
                .join("<br/>") +
              "<br/><b>" +
              escape(labels.total || "Total") +
              ": " +
              row.total +
              "</b>"
            );
          },
        },
        plotOptions: {
          column: {
            stacking: "normal",
            pointRange: 86400000,
            maxPointWidth: 64,
          },
          series: { animation: false, turboThreshold: 0 },
        },
        series: keys.map(function (key, index) {
          return {
            id: key,
            name: labels[key] || key,
            color: theme[themeKeys[index]] || fallback[index],
            visible: visibility[key] !== false,
            events: {
              hide: function () {
                visibility[key] = false;
              },
              show: function () {
                visibility[key] = true;
              },
            },
            data: points.map(function (point) {
              return { x: point.x, y: point.row[key], custom: point.row };
            }),
          };
        }),
      };
    }

    const PriorityTrendChart = Control.extend(
      "tide.cockpit.ext.overview.PriorityTrendChart",
      {
        metadata: {
          properties: {
            rows: { type: "object", defaultValue: null },
            labels: { type: "object", defaultValue: null },
            asOf: { type: "string", defaultValue: "" },
            title: { type: "string", defaultValue: "Priority trend" },
          },
        },
        init: function () {
          this._visibility = {};
          this._themeChanged = this.invalidate.bind(this);
          Theming.attachApplied(this._themeChanged);
        },
        renderer: {
          apiVersion: 2,
          render: function (manager, control) {
            manager
              .openStart("div", control)
              .class("tidePriorityViz")
              .style("width", "100%")
              .style("height", "22rem")
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
          if (!host || host.clientWidth <= 0 || this._chart) return;
          this._chart = Highcharts.chart(
            host,
            options(
              this.getRows(),
              this._visibility,
              this.getLabels() || {},
              this.getTitle(),
              this.getAsOf(),
            ),
          );
        },
        exit: function () {
          this.onBeforeRendering();
          Theming.detachApplied(this._themeChanged);
          if (this._resizeId) ResizeHandler.deregister(this._resizeId);
        },
      },
    );
    PriorityTrendChart.options = options;
    return PriorityTrendChart;
  },
);
