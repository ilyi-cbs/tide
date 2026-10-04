sap.ui.define(
  ["sap/ui/model/json/JSONModel", "sap/ui/core/format/DateFormat", "tide/cockpit/ext/shared/PageSections"],
  function (JSONModel, DateFormat, PageSections) {
    "use strict";

    const displayDate = DateFormat.getDateInstance({
      style: "medium",
      UTC: true,
    });

    function date(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
      return match
        ? displayDate.format(
            new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])),
          )
        : "";
    }

    function number(value) {
      const parsed = Number(value);
      return value === null ||
        value === undefined ||
        value === "" ||
        !Number.isFinite(parsed)
        ? null
        : parsed;
    }

    function rows(contexts) {
      return (Array.isArray(contexts) ? contexts : [])
        .map(function (context) {
          try {
            return context && typeof context.getObject === "function"
              ? context.getObject()
              : context;
          } catch (error) {
            return null;
          }
        })
        .filter(function (row) {
          return row && typeof row === "object";
        });
    }

    function buildState(
      impactData,
      salesOrderContexts,
      productionOrderContexts,
    ) {
      const salesSource = rows(salesOrderContexts);
      const productionSource = rows(productionOrderContexts);
      const salesOrders = salesSource.map(function (row) {
        return {
          salesOrderLabel: [row.SalesOrder, row.SalesOrderItem]
            .filter(function (value) {
              return value !== null && value !== undefined && value !== "";
            })
            .join(" / "),
          customer: row.CustomerName || row.Customer || "",
          requiredDate: date(row.RequiredDate),
          delayDays: number(row.PredictedDelayDays),
          revenue: number(row.RevenueAtRisk),
          currency: row.Currency || "EUR",
        };
      });
      const productionOrders = productionSource.map(function (row) {
        return {
          productionOrder: row.ProductionOrder || "",
          finishedProduct: row.FinishedProduct || "",
          requiredDate: date(row.RequiredDate),
          shortageDays: number(row.PredictedShortageDays),
          affectedQuantity: number(row.AffectedQuantity),
          unit: row.Unit || "",
        };
      });
      const total = salesOrders.reduce(function (sum, row) {
        return sum + (row.revenue || 0);
      }, 0);
      const stock = impactData?.stock;
      const salesDelayChart = {
        kind: "delayBars",
        title: "Customer delays",
        unit: "calendar days",
        rows: salesOrders
          .map(function (row, index) {
            return {
              label: row.salesOrderLabel,
              value: row.delayDays,
              detail: row.customer,
              requiredDate: salesSource[index].RequiredDate,
              revenue: row.revenue,
              currency: row.currency,
            };
          })
          .filter(function (row) {
            return row.value !== null && row.value > 0;
          })
          .sort(function (left, right) {
            return right.value - left.value;
          })
          .slice(0, 5),
      };
      const productionShortageChart = {
        kind: "delayBars",
        title: "Production shortages",
        unit: "working days",
        rows: productionOrders
          .map(function (row, index) {
            return {
              label: row.productionOrder,
              value: row.shortageDays,
              detail: row.finishedProduct,
              requiredDate: productionSource[index].RequiredDate,
              quantity: row.affectedQuantity,
              quantityUnit: row.unit,
            };
          })
          .filter(function (row) {
            return row.value !== null && row.value > 0;
          })
          .sort(function (left, right) {
            return right.value - left.value;
          })
          .slice(0, 5),
      };
      const shortageFrom = impactData?.shortageFrom;
      const shortageDays = impactData?.shortageDays;
      const hasStock =
        (stock !== null && stock !== undefined) ||
        Boolean(shortageFrom) ||
        (shortageDays !== null && shortageDays !== undefined);
      const isMakeToOrder = impactData?.materialKind === "make_to_order";
      const level = impactData?.impactLevelText || impactData?.levelText || "";
      const earliestNeed = rows(salesOrderContexts)
        .map(function (row) {
          return row.RequiredDate;
        })
        .filter(Boolean)
        .concat(
          rows(productionOrderContexts)
            .map(function (row) {
              return row.RequiredDate;
            })
            .filter(Boolean),
        )
        .concat(impactData?.needDate ? [impactData.needDate] : [])
        .sort()[0];
      const hasRows = salesOrders.length > 0 || productionOrders.length > 0;
      const status = hasRows
        ? "Error"
        : hasStock && (shortageFrom || Number(shortageDays) > 0)
          ? "Warning"
          : "Information";
      const outcome = hasRows
        ? level || "Downstream demand is affected by the current forecast."
        : hasStock && (shortageFrom || Number(shortageDays) > 0)
          ? isMakeToOrder
            ? level || "Linked demand is projected to be supplied late."
            : "Stock is projected to run short for the current forecast."
          : level ||
            "No affected customer or production order is calculated for the current forecast.";
      const exposure = salesOrders.length
        ? salesOrders.length +
          " affected sales orders" +
          (total ? " · EUR " + total.toLocaleString() + " at risk" : "")
        : productionOrders.length
          ? productionOrders.length + " affected production orders"
          : "No affected sales or production orders";
      const timing = earliestNeed
        ? "Earliest affected requirement: " + date(earliestNeed)
        : shortageFrom
          ? "Stock shortage from " + date(shortageFrom)
          : "No affected requirement date is available.";
      const evidence =
        salesOrders.length || productionOrders.length
          ? "Evidence: linked demand and current forecast."
          : isMakeToOrder
            ? "Evidence: sales-order-specific supply and linked component requirements."
            : hasStock
              ? "Evidence: current stock projection."
              : "Evidence: no affected order rows were calculated for the current forecast.";
      const scenarios = rows(impactData?.scenarios).map(function (row) {
        return {
          quantile: "P" + Math.round(Number(row.level) * 100),
          arrival: date(row.arrival),
          revenue: number(row.revenue),
          delayDays: number(row.customerDelayDays),
        };
      });
      const planningRows = rows(impactData?.planningRows).map(function (row) {
        return {
          date: date(row.date),
          element: row.elementText || row.element || "",
          reference: row.id || "",
          quantity: number(row.qty),
          balance: number(row.available),
          status: row.affected
            ? "Affected demand"
            : row.own
              ? "This purchase order"
              : "Other supply / demand",
          state: row.affected ? "Error" : row.own ? "Information" : "None",
        };
      });
      const forecastPoints = rows(impactData?.scenarios)
        .map(function (row) {
          return {
            x: Date.parse(row.arrival),
            y: number(row.customerDelayDays),
            name: "P" + Math.round(Number(row.level) * 100),
            custom: { revenue: number(row.revenue) },
          };
        })
        .filter(function (point) {
          return Number.isFinite(point.x) && point.y !== null && point.y >= 0;
        })
        .sort(function (first, second) {
          return first.x - second.x;
        });
      const purchaseOrder = [
        impactData?.PurchaseOrder,
        impactData?.PurchaseOrderItem,
      ]
        .filter(Boolean)
        .join(" / ");
      const flowNodes = [
        {
          nodeId: "supply",
          laneId: "supply",
          title: purchaseOrder || "Purchase order",
          state: "Neutral",
          stateText:
            "Expected: " + (date(impactData?.expectedDate) || "Not available"),
          texts: [
            impactData?.impactKindText ||
              (isMakeToOrder
                ? "Sales-order-specific supply"
                : "Plant stock supply"),
          ],
          children: productionOrders.length
            ? ["production"]
            : salesOrders.length
              ? ["customer"]
              : [],
        },
        {
          nodeId: "production",
          laneId: "production",
          title: productionOrders.length + " production orders",
          state: productionOrders.length ? "Critical" : "Neutral",
          stateText: productionOrders.length
            ? "Component shortage"
            : "No affected production orders",
          texts: ["Required: " + (date(earliestNeed) || "Not available")],
          children:
            productionOrders.length && salesOrders.length ? ["customer"] : [],
        },
        {
          nodeId: "customer",
          laneId: "customer",
          title: salesOrders.length + " sales orders",
          state: salesOrders.length ? "Negative" : "Neutral",
          stateText: salesOrders.length
            ? "Delivery at risk"
            : "No affected sales orders",
          texts: [
            salesOrders.length
              ? "EUR " +
                (number(impactData?.revenueAtRisk) ?? total).toLocaleString() +
                " at risk"
              : "No linked customer demand",
          ],
          children: [],
        },
      ];
      return {
        state: "loaded",
        salesOrders: salesOrders,
        productionOrders: productionOrders,
        salesDelayChart: salesDelayChart,
        productionShortageChart: productionShortageChart,
        hasSalesDelayChart: salesDelayChart.rows.length > 0,
        hasProductionShortageChart: productionShortageChart.rows.length > 0,
        hasSalesOrders: salesOrders.length > 0,
        hasProductionOrders: productionOrders.length > 0,
        hasStock: hasStock,
        hasImpact: hasRows || hasStock,
        purchaseOrder: purchaseOrder,
        flowNodes: flowNodes,
        demandType:
          impactData?.impactKindText ||
          (isMakeToOrder
            ? "Sales-order-specific supply"
            : "Plant stock supply"),
        kindNote: impactData?.kindNote || "",
        note: impactData?.note || "",
        expectedDate: date(impactData?.expectedDate) || "Not available",
        cautiousDate: date(impactData?.cautiousDate) || "Not available",
        confirmedDate: date(impactData?.confirmedDate) || "Not available",
        needDate: date(earliestNeed) || "Not available",
        arrivalSource:
          {
            confirmation: "Supplier confirmation",
            grid: "Delivery forecast",
            requested: "Requested date",
          }[impactData?.arrivalSource] || "Not available",
        revenueAtRisk:
          number(impactData?.revenueAtRisk) ??
          (salesOrders.length ? total : null),
        revenueCautious: number(impactData?.revenueCautious),
        customerDelayDays: number(impactData?.customerDelayDays),
        shortageDays: number(shortageDays),
        coverageDays: number(impactData?.coverageDays),
        stockQuantity: number(stock),
        stockLabel: isMakeToOrder
          ? "Not applicable: sales-order-specific supply"
          : stock === null || stock === undefined
            ? "Not available"
            : Number(stock).toLocaleString(),
        salesCount: salesOrders.length,
        productionCount: productionOrders.length,
        salesTitle: "Affected sales orders (" + salesOrders.length + ")",
        productionTitle:
          "Affected production orders (" + productionOrders.length + ")",
        planningTitle: "Stock projection details (" + planningRows.length + ")",
        scenarios: scenarios,
        hasScenarios: scenarios.length > 0,
        planningRows: planningRows,
        hasPlanningRows: !isMakeToOrder && planningRows.length > 0,
        forecastChart: {
          kind: "scenarioDelay",
          title: "Customer delay by forecast arrival",
          points: forecastPoints,
        },
        hasForecastChart: forecastPoints.length > 0,
        status: status,
        outcome: outcome,
        exposure: exposure,
        timing: timing,
        evidence: evidence,
        stockSummary:
          hasStock && !isMakeToOrder
            ? "Stock: " +
              (stock === null || stock === undefined
                ? "not available"
                : Number(stock)) +
              (shortageFrom ? " · short from " + date(shortageFrom) : "") +
              (shortageDays !== null && shortageDays !== undefined
                ? " · " + Number(shortageDays) + " shortage days"
                : "")
            : "",
        summary: exposure,
        productionSummary:
          productionOrders.length + " affected production orders",
      };
    }

    function emptyState() {
      return {
        state: "empty",
        salesOrders: [],
        productionOrders: [],
        hasSalesOrders: false,
        hasProductionOrders: false,
        hasStock: false,
      };
    }

    function root(control) {
      let current = control;
      while (
        current &&
        !(current.getId && current.getId().endsWith("businessImpactBox"))
      )
        current = current.getParent();
      return current;
    }

    function load(box) {
      PageSections.register(box, function () {
        box.data("impactPath", null);
        load(box);
      });
      const context = box.getBindingContext();
      const path = context && context.getPath ? context.getPath() : "";
      let impactModel = box.getModel("impact");
      if (!impactModel) {
        impactModel = new JSONModel(emptyState());
        box.setModel(impactModel, "impact");
      }
      if (!context || !path) {
        impactModel.setData(emptyState());
        return;
      }
      if (
        box.data("impactPath") === path &&
        impactModel.getProperty("/state") !== "error"
      )
        return;
      box.data("impactPath", path);
      impactModel.setData({
        state: "loading",
        salesOrders: [],
        productionOrders: [],
        hasSalesOrders: false,
        hasProductionOrders: false,
        hasStock: false,
      });
      const operation = context
        .getModel()
        .bindContext("PurchasingDeskService.businessImpact(...)", context);
      operation
        .invoke()
        .then(function () {
          return operation.getBoundContext().requestObject();
        })
        .then(function (impact) {
          if (box.getBindingContext()?.getPath() !== path) return;
          const flow = box.getItems().find(function (control) {
            return control.isA("sap.suite.ui.commons.ProcessFlow");
          });
          if (flow) flow.setZoomLevel("One");
          impactModel.setData(
            buildState(impact, impact?.salesOrders, impact?.productionOrders),
          );
        })
        .catch(function (error) {
          if (box.getBindingContext()?.getPath() === path) {
            impactModel.setData({
              state: "error",
              salesOrders: [],
              productionOrders: [],
              hasSalesOrders: false,
              hasProductionOrders: false,
              hasStock: false,
              errorText: "Impact information could not be loaded.",
            });
          }
          console.error("Unable to load Business Impact", error);
        });
    }

    return {
      onContextChange: function (event) {
        load(root(event.getSource()));
      },
      onRetry: function (event) {
        const box = root(event.getSource());
        if (box) {
          box.data("impactPath", null);
          load(box);
        }
      },
      refresh: function (box) {
        if (box) {
          box.data("impactPath", null);
          load(box);
        }
      },
      _buildState: buildState,
    };
  },
);
