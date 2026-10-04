sap.ui.define(
  [
    "sap/ui/core/theming/Parameters",
    "highcharts/esm/highcharts",
    "highcharts/esm/modules/xrange",
    "highcharts/esm/modules/accessibility",
  ],
  function (Parameters, Highcharts) {
    "use strict";

    function stamp(value) {
      if (value instanceof Date)
        return Number.isFinite(value.getTime())
          ? stamp(value.toISOString())
          : null;
      const text = String(value || "").slice(0, 10);
      const time = Date.parse(text + "T00:00:00Z");
      return /^\d{4}-\d{2}-\d{2}$/.test(text) &&
        Number.isFinite(time) &&
        new Date(time).toISOString().slice(0, 10) === text
        ? time
        : null;
    }

    function addDays(value, days) {
      if (value === null || days == null || days === "") return null;
      const duration = Number(days);
      const arrival = value + Math.ceil(duration) * 86400000;
      return !Number.isFinite(duration) ||
        duration < 0 ||
        !Number.isFinite(new Date(arrival).getTime())
        ? null
        : arrival;
    }

    function numeric(value) {
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && !value.trim()) return null;
      const result = Number(value);
      return Number.isFinite(result) ? result : null;
    }

    function scenarioDate(outlook, level, parse) {
      const scenario = (outlook.scenarios || []).find(function (item) {
        return Number(item.level) === level;
      });
      return (parse || stamp)(scenario && scenario.arrivalDate);
    }

    function theme() {
      const values =
        Parameters.get({
          name: [
            "sapIndicationColor_7",
            "sapChart_OrderedColor_1",
            "sapChart_OrderedColor_2",
            "sapTextColor",
            "sapContent_LabelColor",
            "sapList_BorderColor",
            "sapNegativeColor",
            "sapCriticalColor",
            "sapCriticalTextColor",
            "sapContent_FocusColor",
            "sapGroup_ContentBackground",
          ],
        }) || {};
      return {
        primary: values.sapIndicationColor_7 || "#5b3fc4",
        secondary: values.sapChart_OrderedColor_2 || "#e76500",
        text: values.sapTextColor || "#32363a",
        label: values.sapContent_LabelColor || "#556b82",
        grid: values.sapList_BorderColor || "#d9d9d9",
        negative: values.sapNegativeColor || "#bb0000",
        critical: values.sapCriticalTextColor || "#8d5f00",
        focus: values.sapContent_FocusColor || "#0070f2",
        surface: values.sapGroup_ContentBackground || "#ffffff",
      };
    }

    function color(Highcharts, color, opacity) {
      return Highcharts.color(color).setOpacity(opacity).get();
    }

    function point(x, y, name, color, emphasized) {
      return x === null
        ? null
        : {
            x: x,
            y: y,
            name: name,
            color: color,
            custom: { emphasized: Boolean(emphasized) },
          };
    }

    function escape(value) {
      return String(value || "").replace(/[&<>"']/g, function (character) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[character];
      });
    }

    function layoutForecast(chart, rowCount, colors) {
      const series = chart.get("forecast-quantiles");
      if (!series) return;
      const labels = series.points
        .filter(function (item) {
          return (
            item.dataLabel &&
            Number.isFinite(item.plotX) &&
            Number.isFinite(item.plotY)
          );
        })
        .map(function (item) {
          item.dataLabel.css({ width: Math.min(180, chart.plotWidth) + "px" });
          const box = item.dataLabel.getBBox(true);
          return {
            point: item,
            width: box.width,
            height: box.height,
            left: Math.max(
              0,
              Math.min(chart.plotWidth - box.width, item.plotX - box.width / 2),
            ),
          };
        });
      const laneHeight = Math.max.apply(
        null,
        [40].concat(
          labels.map(function (label) {
            return label.height + 12;
          }),
        ),
      );
      const lanes = [];
      labels
        .sort(function (left, right) {
          return left.left - right.left;
        })
        .forEach(function (label) {
          let lane = 0;
          while (lanes[lane] !== undefined && label.left < lanes[lane] + 16)
            lane += 1;
          lanes[lane] = label.left + label.width;
          label.point.dataLabel.attr({
            x: label.left,
            y: label.point.plotY + 20 + lane * laneHeight,
            opacity: 1,
          });
        });
      const stems = labels.flatMap(function (label) {
        const left = chart.plotLeft + label.point.plotX;
        const top = chart.plotTop + label.point.plotY;
        return [
          ["M", left, top - 9],
          ["L", left, top + 9],
        ];
      });
      if (!chart.forecastTicks)
        chart.forecastTicks = chart.renderer
          .path()
          .attr({ stroke: colors.primary, "stroke-width": 1, zIndex: 4 })
          .add();
      chart.forecastTicks.attr({ d: stems });
      const remaining = labels.length
        ? chart.plotHeight - labels[0].point.plotY
        : 0;
      const axis = chart.yAxis?.[0];
      const windowLabelHeight =
        axis?.ticks[axis.tickPositions.at(-1)]?.label?.getBBox(true).height ||
        0;
      const marginBottom = Math.max(
        72,
        Math.ceil(windowLabelHeight + 12 - remaining),
        Math.ceil(20 + lanes.length * laneHeight - remaining + 16),
      );
      const rowHeights = axis
        ? axis.tickPositions.slice(0, -1).map(function (position) {
            return (
              (axis.ticks[position]?.label?.getBBox(true).height || 0) + 16
            );
          })
        : [];
      const rowHeight = Math.ceil(
        Math.max.apply(null, [48].concat(rowHeights)),
      );
      const height = 40 + rowCount * rowHeight + marginBottom;
      if (
        chart.options.chart.marginBottom !== marginBottom ||
        chart.chartHeight !== height
      ) {
        chart.forecastLayout = { marginBottom: marginBottom, height: height };
        if (!chart.forecastLayoutPending) {
          chart.forecastLayoutPending = true;
          queueMicrotask(function () {
            const layout = chart.forecastLayout;
            chart.forecastLayoutPending = false;
            if (chart.renderer && layout)
              chart.update({ chart: layout }, true, false, false);
          });
        }
      }
    }

    function layoutLanes(chart, count) {
      const series = chart.get("simulation-quantiles");
      if (!series) return;
      const groups = Array.from({ length: count }, function () {
        return [];
      });
      series.points.forEach(function (item) {
        if (!item.dataLabel || !Number.isFinite(item.plotX)) return;
        item.dataLabel.css({ width: Math.min(160, chart.plotWidth) + "px" });
        const box = item.dataLabel.getBBox(true);
        groups[item.y].push({
          point: item,
          width: box.width,
          height: box.height,
          left: Math.max(
            0,
            Math.min(chart.plotWidth - box.width, item.plotX - box.width / 2),
          ),
        });
      });
      let rowHeight = 72;
      groups.forEach(function (group) {
        const ends = [];
        const leading = Math.max.apply(
          null,
          [24].concat(
            group.map(function (label) {
              return label.height + 8;
            }),
          ),
        );
        group
          .sort(function (left, right) {
            return left.left - right.left;
          })
          .forEach(function (label) {
            let slot = 0;
            while (ends[slot] !== undefined && label.left < ends[slot] + 12)
              slot += 1;
            ends[slot] = label.left + label.width;
            label.point.dataLabel.attr({
              x: label.left,
              y: label.point.plotY + 18 + slot * leading,
              opacity: 1,
            });
          });
        rowHeight = Math.max(
          rowHeight,
          Math.ceil((26 + ends.length * leading) / 0.75),
        );
      });
      chart.yAxis[0].tickPositions.forEach(function (position) {
        const label = chart.yAxis[0].ticks[position]?.label;
        if (label)
          rowHeight = Math.max(rowHeight, label.getBBox(true).height + 24);
      });
      const height =
        chart.options.chart.marginTop +
        count * rowHeight +
        chart.options.chart.marginBottom;
      if (chart.chartHeight !== height && !chart.forecastLayoutPending) {
        chart.forecastLayoutPending = true;
        queueMicrotask(function () {
          chart.forecastLayoutPending = false;
          if (chart.renderer) chart.setSize(null, height, false);
        });
      }
    }

    function laneOptions(config, labels) {
      const colors = theme();
      const rows = config.rows || [];
      const numericAxis = config.axisType === "linear";
      const parseValue = numericAxis ? numeric : stamp;
      const single = rows.length === 1;
      const selected = Number(config.selectedQuantile ?? 0.8);
      const need = numericAxis ? null : stamp(config.needDate);
      const asOf = numericAxis ? null : stamp(config.asOf);
      const formatDate =
        (numericAxis ? labels.value : labels.date) ||
        function (value) {
          return numericAxis
            ? String(value)
            : Highcharts.time.dateFormat("%b %e, %Y", value);
        };
      const points = [];
      const intervals = [];
      rows.forEach(function (row, index) {
        const values = (row.points || [])
          .map(function (value) {
            return {
              quantile: Number(value.quantile),
              date: parseValue(numericAxis ? value.value : value.date),
            };
          })
          .filter(function (value) {
            return value.date !== null && Number.isFinite(value.quantile);
          });
        const lower =
          values.find(function (value) {
            return value.quantile === 0.1;
          }) ||
          values.find(function (value) {
            return value.quantile === 0.3;
          }) ||
          values.find(function (value) {
            return value.quantile === 0.5;
          });
        const cautious =
          values.find(function (value) {
            return value.quantile === 0.95;
          }) ||
          values.find(function (value) {
            return value.quantile === 0.9;
          });
        if (lower && cautious && lower.date <= cautious.date)
          intervals.push({
            x: lower.date,
            x2: cautious.date,
            y: index,
            name: row.name,
            color: color(
              Highcharts,
              need !== null && lower.date > need
                ? colors.negative
                : colors.primary,
              0.16,
            ),
            borderColor:
              need !== null && lower.date > need
                ? colors.negative
                : colors.primary,
            custom: {
              supplier: row.name,
              range:
                "P" +
                Math.round(lower.quantile * 100) +
                "-P" +
                Math.round(cautious.quantile * 100),
            },
          });
        values
          .filter(function (value) {
            return [0.1, 0.3, 0.5, 0.8, 0.9, 0.95, selected].includes(
              value.quantile,
            );
          })
          .forEach(function (value) {
            const emphasized = value.quantile === selected;
            const late = need !== null && value.date > need;
            const ink = late
              ? colors.negative
              : emphasized
                ? colors.primary
                : colors.label;
            points.push({
              x: value.date,
              y: index,
              name: "P" + Math.round(value.quantile * 100),
              color: ink,
              custom: {
                supplier: row.name,
                quantile: value.quantile,
                emphasized: emphasized,
                late: late,
              },
              marker: {
                radius: emphasized ? 8 : 5,
                fillColor: emphasized ? ink : colors.surface,
                lineColor: ink,
                lineWidth: 2,
              },
            });
          });
      });
      const dates = points
        .map(function (item) {
          return item.x;
        })
        .concat(
          [need, asOf].filter(function (value) {
            return value !== null;
          }),
        );
      const description = function (item) {
        return (
          item.custom.supplier +
          ", " +
          item.name +
          ": " +
          formatDate(item.x) +
          (need === null
            ? ""
            : ", " + (item.custom.late ? labels.infeasible : labels.feasible))
        );
      };
      return {
        chart: {
          type: "scatter",
          animation: false,
          backgroundColor: "transparent",
          height: 48 + rows.length * 120 + 24,
          marginTop: single ? 76 : 48,
          marginBottom: 44,
          marginLeft: single ? 16 : 212,
          marginRight: 24,
          style: {
            fontFamily: "var(--sapFontFamily, '72', Arial, sans-serif)",
            fontSize: "14px",
          },
          events: {
            render: function () {
              layoutLanes(this, rows.length);
            },
          },
        },
        time: { timezone: "UTC" },
        title: { text: null },
        subtitle: {
          text: single ? escape(rows[0].name) : null,
          align: "left",
          x: 0,
          y: 12,
          style: { color: colors.label, fontSize: "14px" },
        },
        credits: { enabled: false },
        exporting: { enabled: false },
        legend: { enabled: false },
        lang: { accessibility: { chartContainerLabel: labels.chartTitle } },
        accessibility: {
          description: points
            .map(description)
            .concat(
              rows
                .filter(function (row) {
                  return !(row.points || []).some(function (value) {
                    return (
                      parseValue(numericAxis ? value.value : value.date) !==
                      null
                    );
                  });
                })
                .map(function (row) {
                  return row.name + ": " + labels.noRange;
                }),
              need === null ? [] : [labels.needDate + ": " + formatDate(need)],
            )
            .join(". "),
          point: {
            descriptionFormatter: function (item) {
              return item.x2 == null
                ? description(item)
                : item.name +
                    ", " +
                    item.custom.range +
                    ": " +
                    formatDate(item.x) +
                    " - " +
                    formatDate(item.x2);
            },
          },
        },
        xAxis: {
          type: numericAxis ? "linear" : "datetime",
          min: dates.length
            ? Math.min.apply(null, dates) -
              (numericAxis
                ? Math.max(
                    0.01,
                    (Math.max.apply(null, dates) -
                      Math.min.apply(null, dates)) *
                      0.06,
                  )
                : asOf === null
                  ? 2 * 86400000
                  : 0)
            : undefined,
          max: dates.length
            ? Math.max.apply(null, dates) +
              (numericAxis
                ? Math.max(
                    0.01,
                    (Math.max.apply(null, dates) -
                      Math.min.apply(null, dates)) *
                      0.06,
                  )
                : 2 * 86400000)
            : undefined,
          lineWidth: 1,
          lineColor: colors.grid,
          tickLength: 0,
          tickPixelInterval: 120,
          minTickInterval: numericAxis ? undefined : 86400000,
          gridLineWidth: 1,
          gridLineColor: color(Highcharts, colors.grid, 0.3),
          labels: {
            enabled: true,
            formatter: function () {
              return numericAxis
                ? formatDate(this.value)
                : Highcharts.time.dateFormat("%e %b", this.value);
            },
            style: { color: colors.label, fontSize: "12px" },
          },
          dateTimeLabelFormats: { day: "%e %b", week: "%e %b", month: "%b %Y" },
          plotLines: [
            asOf === null
              ? null
              : {
                  value: asOf,
                  color: colors.label,
                  width: 1,
                  dashStyle: "ShortDash",
                  zIndex: 2,
                  label: {
                    text: labels.today,
                    rotation: 0,
                    align: "left",
                    x: 4,
                    y: -26,
                    style: { color: colors.label, fontSize: "12px" },
                  },
                },
            need === null
              ? null
              : {
                  value: need,
                  color: colors.negative,
                  width: 1,
                  dashStyle: "ShortDash",
                  zIndex: 2,
                  label: {
                    text: labels.needDate,
                    rotation: 0,
                    align: "right",
                    x: -4,
                    y: -10,
                    style: {
                      color: colors.negative,
                      fontSize: "12px",
                      fontWeight: "bold",
                    },
                  },
                },
          ].filter(Boolean),
        },
        yAxis: {
          categories: rows.map(function (row) {
            return row.name;
          }),
          reversed: true,
          min: -0.25,
          max: Math.max(0.75, rows.length - 0.25),
          tickPositions: rows.map(function (_row, index) {
            return index;
          }),
          startOnTick: false,
          endOnTick: false,
          title: { text: null },
          gridLineWidth: 1,
          gridLineColor: color(Highcharts, colors.grid, 0.4),
          labels: {
            enabled: !single,
            align: "left",
            x: -188,
            y: 4,
            style: {
              color: colors.text,
              fontSize: "14px",
              width: "176px",
              textOverflow: "none",
            },
            formatter: function () {
              return escape(rows[this.pos]?.name || "");
            },
          },
        },
        tooltip: {
          backgroundColor: colors.surface,
          borderColor: colors.grid,
          borderRadius: 4,
          shadow: false,
          style: { color: colors.text, fontSize: "14px" },
          formatter: function () {
            return (
              "<b>" +
              escape(this.custom.supplier) +
              "</b><br/>" +
              (this.x2 == null
                ? escape(this.name) +
                  ": " +
                  escape(formatDate(this.x)) +
                  (need === null
                    ? ""
                    : "<br/>" +
                      escape(
                        this.custom.late ? labels.infeasible : labels.feasible,
                      ))
                : escape(this.custom.range) +
                  ": " +
                  escape(formatDate(this.x)) +
                  " - " +
                  escape(formatDate(this.x2)))
            );
          },
        },
        plotOptions: {
          series: { animation: false, states: { inactive: { opacity: 1 } } },
          scatter: {
            cursor: labels.onSelect ? "pointer" : "default",
            point: {
              events: {
                click: function () {
                  if (labels.onSelect) labels.onSelect(this.custom.quantile);
                },
              },
            },
          },
        },
        responsive: {
          rules: [
            {
              condition: { maxWidth: 600 },
              chartOptions: {
                chart: { marginLeft: single ? 16 : 136, marginRight: 16 },
                yAxis: { labels: { x: -120, style: { width: "110px" } } },
              },
            },
          ],
        },
        series: [
          {
            type: "xrange",
            name: labels.chartTitle,
            data: intervals,
            pointWidth: 20,
            grouping: false,
            colorByPoint: false,
            color: color(Highcharts, colors.primary, 0.12),
            borderColor: colors.primary,
            borderWidth: 1,
            borderRadius: 2,
            dataLabels: { enabled: false },
            zIndex: 1,
          },
          {
            type: "scatter",
            id: "simulation-quantiles",
            name: labels.chartTitle,
            data: points,
            zIndex: 3,
            dataLabels: {
              enabled: true,
              allowOverlap: true,
              crop: false,
              overflow: "allow",
              padding: 0,
              style: {
                fontSize: "14px",
                textOutline: "none",
                width: "160px",
                textOverflow: "none",
              },
              formatter: function () {
                return (
                  '<span style="color:' +
                  this.color +
                  ";font-weight:" +
                  (this.custom.emphasized ? "bold" : "normal") +
                  '">' +
                  escape(this.name) +
                  "</span>"
                );
              },
            },
          },
        ],
      };
    }

    function options(outlook, labels) {
      const colors = theme();
      const duration = outlook.axisType === "linear";
      const parse = duration ? numeric : stamp;
      const quantileValue = function (value) {
        const result = parse(value);
        return duration && result !== null && result < 0 ? null : result;
      };
      const hasQuantiles = ["tabpfn", "range"].includes(outlook.forecastKind);
      if (!hasQuantiles) colors.primary = colors.label;
      const ordered = duration
        ? null
        : stamp(
            (outlook.markers || []).find(function (item) {
              return item.kind === "ordered";
            })?.date,
          );
      const requested = parse(outlook.requiredDate);
      const today = duration ? null : stamp(outlook.today || outlook.asOf);
      const planned = duration
        ? quantileValue(outlook.plannedDays)
        : addDays(ordered, outlook.plannedDays);
      const p10 = quantileValue(outlook.earliestCredibleDate);
      const p50 =
        scenarioDate(outlook, 50, quantileValue) ??
        quantileValue(outlook.mostLikelyDate);
      const p80 = scenarioDate(outlook, 80, quantileValue);
      const p90 =
        scenarioDate(outlook, 90, quantileValue) ??
        quantileValue(outlook.lateRiskDate);
      const formatDate =
        labels.value ||
        labels.date ||
        function (value) {
          return duration
            ? value + " " + (labels.unit || "days")
            : Highcharts.time.dateFormat("%b %e, %Y", value);
        };
      const references = [
        point(ordered, 0, labels.purchaseOrder, colors.label),
        point(requested, 1, labels.requestedDate, colors.negative, true),
        point(planned, 2, labels.sapPlanned, colors.critical),
      ].filter(Boolean);
      references.forEach(function (reference, index) {
        reference.y = index;
      });
      const forecastRow = references.length;
      const hasRange = p10 !== null && p90 !== null && p10 <= p90;
      const quantile =
        labels.chanceBy ||
        function (level) {
          return "P" + level + " - " + level + "% chance by";
        };
      const arrivalLabel =
        outlook.forecastKind === "confirmation"
          ? labels.supplierConfirmed || "Supplier confirmed"
          : outlook.forecastKind === "sap_planned"
            ? labels.plannedArrival || "SAP planned arrival"
            : labels.typicalArrival || "Typical arrival";
      const forecast = hasQuantiles
        ? [
            point(p10, forecastRow, quantile(10), colors.primary),
            point(p50, forecastRow, quantile(50), colors.primary, true),
            point(p80, forecastRow, quantile(80), colors.primary),
            point(p90, forecastRow, quantile(90), colors.primary),
          ].filter(Boolean)
        : [
            point(
              stamp(outlook.mostLikelyDate),
              forecastRow,
              arrivalLabel,
              colors.primary,
              true,
            ),
          ].filter(Boolean);
      references.concat(forecast).forEach(function (item) {
        item.marker = { radius: item.custom.emphasized ? 6 : 4 };
        item.dataLabels = {
          style: { fontWeight: item.custom.emphasized ? "bold" : "normal" },
        };
      });
      forecast.forEach(function (item) {
        item.marker = {
          radius: item.custom.emphasized ? 7 : 4,
          fillColor: item.custom.emphasized ? colors.primary : colors.surface,
          lineColor: colors.primary,
          lineWidth: 2,
        };
      });
      const rows = references.concat([
        {
          name: hasQuantiles
            ? labels.predictionWindow
            : labels.arrivalWindow || "Arrival window",
          color: colors.primary,
        },
      ]);
      const dates = references
        .concat(forecast)
        .map(function (item) {
          return item.x;
        })
        .concat(hasRange ? [p10, p90] : [], today === null ? [] : [today]);
      const minimum = dates.length ? Math.min.apply(null, dates) : 0;
      const maximum = dates.length ? Math.max.apply(null, dates) : 0;
      const padding = duration
        ? Math.max(outlook.minimumPadding ?? 1, (maximum - minimum) * 0.06)
        : 2 * 86400000;
      const description = function (item) {
        return (
          item.name +
          ": " +
          formatDate(item.x) +
          (item.x2 == null ? "" : " - " + formatDate(item.x2))
        );
      };

      return {
        chart: {
          type: "scatter",
          animation: false,
          backgroundColor: "transparent",
          height: 40 + rows.length * 48 + 100,
          marginTop: 40,
          marginBottom: 100,
          marginLeft: 236,
          events: {
            render: function () {
              layoutForecast(this, rows.length, colors);
            },
          },
          spacing: [12, 24, 12, 12],
          style: {
            fontFamily: "var(--sapFontFamily, '72', Arial, sans-serif)",
            fontSize: "14px",
          },
        },
        time: { timezone: "UTC" },
        title: { text: null },
        credits: { enabled: false },
        exporting: { enabled: false },
        legend: { enabled: false },
        lang: {
          accessibility: {
            chartContainerLabel:
              labels.chartTitle || "Delivery forecast timeline",
          },
        },
        accessibility: {
          description: [labels.description]
            .concat(
              references.concat(forecast).map(description),
              hasRange
                ? [
                    rows[forecastRow].name +
                      ": " +
                      formatDate(p10) +
                      " - " +
                      formatDate(p90),
                  ]
                : [],
              today === null ? [] : [labels.today + ": " + formatDate(today)],
            )
            .filter(Boolean)
            .join(". "),
          point: { descriptionFormatter: description },
        },
        tooltip: {
          backgroundColor: colors.surface,
          borderColor: colors.grid,
          borderRadius: 4,
          shadow: false,
          padding: 12,
          style: { color: colors.text, fontSize: "14px" },
          formatter: function () {
            return (
              "<b>" +
              escape(this.name) +
              "</b><br/>" +
              escape(formatDate(this.x)) +
              (this.x2 == null ? "" : " - " + escape(formatDate(this.x2)))
            );
          },
        },
        xAxis: {
          type: duration ? "linear" : "datetime",
          min: dates.length
            ? duration
              ? outlook.includeZero === false
                ? Math.max(0, minimum - padding)
                : Math.min(0, minimum - padding)
              : minimum - padding
            : undefined,
          max: dates.length ? maximum + padding : undefined,
          lineColor: colors.grid,
          lineWidth: 0,
          opposite: true,
          tickLength: 0,
          gridLineWidth: 0,
          labels: { enabled: false },
          plotLines:
            today === null
              ? []
              : [
                  {
                    value: today,
                    color: color(Highcharts, colors.text, 0.5),
                    dashStyle: "ShortDash",
                    width: 1,
                    zIndex: 2,
                    label: {
                      text: labels.today,
                      rotation: 0,
                      y: -14,
                      style: {
                        color: colors.text,
                        fontSize: "12px",
                        fontWeight: "bold",
                      },
                    },
                  },
                ],
        },
        yAxis: {
          categories: rows.map(function (row) {
            return row.name;
          }),
          reversed: true,
          min: 0,
          max: forecastRow,
          tickPositions: rows.map(function (_row, index) {
            return index;
          }),
          startOnTick: false,
          endOnTick: false,
          title: { text: null },
          gridLineWidth: 1,
          gridLineColor: color(Highcharts, colors.grid, 0.4),
          labels: {
            align: "left",
            x: -210,
            y: -3,
            style: {
              color: colors.text,
              fontSize: "14px",
              width: "200px",
              textOverflow: "none",
            },
            formatter: function () {
              const row = rows[this.pos];
              const date =
                row.x == null
                  ? hasRange
                    ? formatDate(p10) + " - " + formatDate(p90)
                    : ""
                  : formatDate(row.x);
              return (
                '<span style="color:' +
                row.color +
                ";font-weight:" +
                (row.custom?.emphasized ? "bold" : "normal") +
                '">' +
                escape(row.name) +
                '</span><br/><span style="color:' +
                colors.label +
                '">' +
                escape(date) +
                "</span>"
              );
            },
          },
        },
        plotOptions: {
          series: {
            animation: false,
            stickyTracking: false,
            states: { inactive: { opacity: 1 } },
          },
          scatter: { marker: { radius: 5, symbol: "circle" } },
        },
        responsive: {
          rules: [
            {
              condition: { maxWidth: 600 },
              chartOptions: {
                chart: { marginLeft: 136 },
                yAxis: { labels: { x: -120, style: { width: "110px" } } },
              },
            },
          ],
        },
        series: [
          {
            type: "xrange",
            name: rows[forecastRow].name,
            data: hasRange
              ? [
                  {
                    x: p10,
                    x2: p90,
                    y: forecastRow,
                    name: rows[forecastRow].name,
                  },
                ]
              : [],
            colorByPoint: false,
            color: color(Highcharts, colors.primary, 0.12),
            borderColor: colors.primary,
            borderWidth: 1,
            borderRadius: 2,
            pointWidth: 12,
            grouping: false,
            dataLabels: { enabled: false },
            zIndex: 1,
          },
          ...references.map(function (reference) {
            return {
              type: "line",
              name: reference.name,
              data: [
                { x: reference.x, y: reference.y },
                { x: reference.x, y: forecastRow },
              ],
              color: color(Highcharts, reference.color, 0.5),
              dashStyle: "ShortDash",
              lineWidth: 1,
              marker: { enabled: false },
              enableMouseTracking: false,
              accessibility: { enabled: false },
              zIndex: 1,
            };
          }),
          {
            type: "scatter",
            id: "forecast-quantiles",
            name: labels.quantiles,
            data: forecast,
            zIndex: 3,
            dataLabels: {
              enabled: true,
              formatter: function () {
                return (
                  '<span style="font-size:' +
                  (this.custom?.emphasized ? "16px" : "14px") +
                  ";color:" +
                  colors.text +
                  '">' +
                  escape(formatDate(this.x)) +
                  '</span><br/><span style="font-size:12px;color:' +
                  (this.custom?.emphasized ? colors.primary : colors.label) +
                  '">' +
                  escape(this.name) +
                  "</span>"
                );
              },
              y: 38,
              crop: false,
              overflow: "allow",
              allowOverlap: true,
              padding: 0,
              style: {
                color: colors.primary,
                fontSize: "14px",
                width: "180px",
                textOverflow: "none",
                textOutline: "none",
              },
            },
          },
          {
            type: "scatter",
            name: labels.referenceDates,
            data: references,
            zIndex: 3,
            dataLabels: { enabled: false },
          },
        ].filter(Boolean),
      };
    }

    return {
      render: function (host, outlook, labels) {
        if (!host || !outlook) return null;
        return Highcharts.chart(host, options(outlook, labels));
      },
      renderLanes: function (host, config, labels) {
        if (!host || !config?.rows?.length) return null;
        return Highcharts.chart(
          host,
          laneOptions(
            config,
            Object.assign(
              {
                chartTitle: "Estimated arrival if ordered today",
                needDate: "Need date",
                today: "Today",
                feasible: "Meets need date",
                infeasible: "After need date",
                noRange: "No estimate",
              },
              labels,
            ),
          ),
        );
      },
      renderRange: function (host, range, labels) {
        if (!host || !range) return null;
        return Highcharts.chart(
          host,
          options(
            {
              forecastKind: "range",
              axisType: range.axisType,
              includeZero: range.includeZero,
              minimumPadding: range.minimumPadding,
              markers: [{ kind: "ordered", date: range.ordered }],
              requiredDate: range.requested,
              plannedDays: range.planned,
              today: range.today,
              earliestCredibleDate: range.p10,
              mostLikelyDate: range.p50,
              lateRiskDate: range.p90,
              scenarios: [{ level: 80, arrivalDate: range.p80 }],
            },
            Object.assign(
              {
                chartTitle: "Lead-time range",
                predictionWindow: "P10-P90 range",
                purchaseOrder: "Purchase order",
                requestedDate: "Requested",
                sapPlanned: "SAP planned",
                today: "As of",
                quantiles: "Quantiles",
                referenceDates: "Reference values",
                chanceBy: function (level) {
                  return "P" + level;
                },
              },
              labels,
            ),
          ),
        );
      },
    };
  },
);
