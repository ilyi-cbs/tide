sap.ui.define(
  ["sap/ui/model/json/JSONModel", "sap/ui/core/format/DateFormat"],
  function (JSONModel, DateFormat) {
    "use strict";

    const displayDate = DateFormat.getDateInstance({
      style: "medium",
      UTC: true,
    });

    function root(control) {
      let current = control;
      while (
        current &&
        !(current.getId && current.getId().endsWith("deliveryHistoryBox"))
      )
        current = current.getParent();
      return current;
    }

    function days(value) {
      return value === null || value === undefined
        ? "Not maintained"
        : Number(value) + " days";
    }

    function date(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
      return match
        ? displayDate.format(
            new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])),
          )
        : "";
    }

    function dateAfter(orderDate, totalDays) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(orderDate || ""));
      const daysToAdd = Number(totalDays);
      if (!match || !Number.isFinite(daysToAdd)) return "";
      return displayDate.format(
        new Date(Date.UTC(+match[1], +match[2] - 1, +match[3] + daysToAdd)),
      );
    }

    function finite(value) {
      return (
        value !== null &&
        value !== undefined &&
        typeof value !== "boolean" &&
        String(value).trim() !== "" &&
        Number.isFinite(Number(value))
      );
    }

    function forecastSource(history) {
      if (history.confirmedArrival)
        return { text: "Supplier confirmed", state: "Success" };
      if (history.forecastSource === "tabpfn")
        return { text: "AI forecast", state: "Information" };
      if (history.forecastBasis === "survivors")
        return { text: "Estimate for open items", state: "Information" };
      return { text: "Historical estimate", state: "None" };
    }

    function asOfText(value) {
      return value ? " as of " + date(value) : "";
    }

    function contextOf(box) {
      let current = box;
      while (current && !current.getBindingContext?.())
        current = current.getParent?.();
      return current?.getBindingContext?.();
    }

    function load(box) {
      const context = contextOf(box);
      const path = context && context.getPath ? context.getPath() : "";
      let model = box.getModel("history");
      if (!model) {
        model = new JSONModel({ state: "empty", deliveries: [] });
        box.setModel(model, "history");
      }
      if (!path) {
        model.setData({ state: "empty", deliveries: [] });
        return;
      }
      if (
        box.data("historyPath") === path &&
        model.getProperty("/state") !== "error"
      )
        return;
      box.data("historyPath", path);
      model.setData({ state: "loading", deliveries: [] });
      const operation = context
        .getModel()
        .bindContext("PurchasingDeskService.deliveryHistory(...)", context);
      operation
        .invoke()
        .then(function () {
          return operation.getBoundContext().requestObject();
        })
        .then(function (history) {
          if (contextOf(box)?.getPath() !== path) return;
          const typical = history.typicalDays;
          const trend = history.recentTrendDays;
          const hasProbabilityForecast = [
            history.typicalForecastDays,
            history.planningForecastDays,
            history.lateRiskForecastDays,
          ].every(finite);
          const source = forecastSource(history);
          const chartDeliveries = (history.deliveries || [])
            .filter(function (row) {
              return (
                finite(row.leadTimeDays) &&
                Number(row.leadTimeDays) >= 0 &&
                row.available &&
                Number.isFinite(Date.parse(row.available))
              );
            })
            .sort(function (left, right) {
              return String(left.available).localeCompare(
                String(right.available),
              );
            })
            .map(function (row) {
              return Object.assign({}, row, {
                receiptDate: date(row.available),
              });
            });
          model.setData(
            Object.assign({}, history, {
              state: "loaded",
              chartDeliveries,
              chart: {
                kind: "deliveryHistory",
                title: "Observed completed purchase order items",
                description:
                  "Observed order-to-availability lead times. Historical median uses all eligible completed items; PO planned duration excludes receipt handling.",
                median: finite(typical) ? Number(typical) : null,
                planned:
                  !history.plannedDaysFlag &&
                  finite(history.plannedDays) &&
                  Number(history.plannedDays) > 0
                    ? Number(history.plannedDays)
                    : null,
                points: chartDeliveries.map(function (row) {
                  return {
                    x: Date.parse(row.available),
                    y: Number(row.leadTimeDays),
                    name: row.purchaseOrder + " / " + row.item,
                    custom: { ordered: row.ordered, requested: row.requested },
                  };
                }),
              },
              chartScope:
                "Latest " +
                chartDeliveries.length +
                " of " +
                history.observedReceipts +
                " completed PO items. Historical median uses all eligible items. PO planned duration excludes receipt handling.",
              hasChartDeliveries: chartDeliveries.length > 0,
              typicalText: days(typical),
              rangeText:
                history.fastestDays === null ||
                history.fastestDays === undefined
                  ? "Not available"
                  : history.fastestDays + "-" + history.slowestDays + " days",
              plannedText:
                days(history.plannedDays) +
                ({
                  default: " (system default)",
                  placeholder: " (placeholder)",
                  not_maintained: " (not maintained)",
                }[history.plannedDaysFlag] || ""),
              trendText:
                trend === null || trend === undefined
                  ? "Not enough recent deliveries"
                  : trend === 0
                    ? "In line with the long-term typical time"
                    : Math.abs(trend) +
                      " days " +
                      (trend > 0 ? "slower" : "faster") +
                      " than the long-term typical time",
              summary: history.observedReceipts
                ? history.observedReceipts +
                  " observed receipts for the current material, supplier, and plant" +
                  (history.forecastAsOf
                    ? ", as of " + date(history.forecastAsOf)
                    : "") +
                  "."
                : "",
              forecastText:
                history.typicalForecastDays === null ||
                history.typicalForecastDays === undefined
                  ? "No current delivery forecast is available."
                  : history.confirmedArrival
                    ? "Supplier confirmed delivery after " +
                      Number(history.typicalForecastDays) +
                      " total days from order."
                    : history.forecastSource === "tabpfn"
                      ? "AI forecast" +
                        asOfText(history.forecastAsOf) +
                        ", not a supplier promise. Probabilities describe predicted arrival, not model accuracy."
                      : history.forecastBasis === "survivors"
                        ? "Estimate conditions on items still open this long" +
                          asOfText(history.forecastAsOf) +
                          "."
                        : "Historical estimate from eligible observed receipts" +
                          asOfText(history.forecastAsOf) +
                          ".",
              hasProbabilityForecast,
              showForecast: finite(history.typicalForecastDays),
              forecastSourceText: source.text,
              forecastSourceState: source.state,
              forecastAttribution:
                history.forecastSource === "tabpfn"
                  ? "Source: TabPFN by PriorLabs"
                  : "",
              forecastRows: hasProbabilityForecast
                ? [
                    {
                      threshold: "50% predicted arrival by",
                      days: history.typicalForecastDays,
                      arrival: dateAfter(
                        history.currentOrderDate,
                        history.typicalForecastDays,
                      ),
                    },
                    {
                      threshold: "80% predicted arrival by",
                      days: history.planningForecastDays,
                      arrival: dateAfter(
                        history.currentOrderDate,
                        history.planningForecastDays,
                      ),
                    },
                    {
                      threshold: "90% predicted arrival by",
                      days: history.lateRiskForecastDays,
                      arrival: dateAfter(
                        history.currentOrderDate,
                        history.lateRiskForecastDays,
                      ),
                    },
                  ]
                : [],
            }),
          );
        })
        .catch(function () {
          if (contextOf(box)?.getPath() === path) {
            model.setData({
              state: "error",
              deliveries: [],
              errorText: "Delivery history could not be loaded.",
            });
          }
        });
    }

    return {
      onContextChange: function (event) {
        load(root(event.getSource()));
      },
      onRetry: function (event) {
        const box = root(event.getSource());
        if (box) {
          box.data("historyPath", null);
          load(box);
        }
      },
    };
  },
);
