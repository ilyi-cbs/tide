sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/DateFormat",
    "sap/ui/core/format/NumberFormat",
    "sap/ui/core/ResizeHandler",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Label",
    "sap/m/DatePicker",
    "sap/m/Input",
    "sap/m/VBox",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "tide/cockpit/ext/outlook/HighchartsPreview",
    "tide/cockpit/ext/CockpitActions",
    "tide/cockpit/ext/shared/WorkflowPending",
    "tide/cockpit/ext/shared/PageSections",
  ],
  function (
    JSONModel,
    DateFormat,
    NumberFormat,
    ResizeHandler,
    Dialog,
    Button,
    Label,
    DatePicker,
    Input,
    VBox,
    MessageToast,
    MessageBox,
    HighchartsTimeline,
    CockpitActions,
    WorkflowPending,
    PageSections,
  ) {
    "use strict";

    /**
     * Delivery forecast and resolution options on the typed delivery case page.
     * Reads the bound outlook function into the local "out" JSON model and
     * runs the chosen option through existing actions.
     * Formats and draws only; the service decides what to show (NS-I2).
     */

    const display = DateFormat.getDateInstance({ style: "medium", UTC: true });
    const percent = NumberFormat.getPercentInstance({ maxFractionDigits: 0 });
    const pending = new WeakMap();
    const highchartsState = new WeakMap();

    function today() {
      const date = new Date();
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-");
    }

    function chartLabels(box, description) {
      return {
        description: description,
        chartTitle: text(box, "highchartsChartTitle"),
        referenceDates: text(box, "highchartsReferenceDates"),
        predictionWindow: text(box, "highchartsPredictionWindow"),
        quantiles: text(box, "highchartsQuantiles"),
        purchaseOrder: text(box, "highchartsPurchaseOrder"),
        requestedDate: text(box, "highchartsRequestedDate"),
        sapPlanned: text(box, "highchartsSapPlanned"),
        today: text(box, "highchartsToday"),
        arrivalWindow: text(box, "highchartsArrivalWindow"),
        typicalArrival: text(box, "highchartsTypicalArrival"),
        supplierConfirmed: text(box, "highchartsSupplierConfirmed"),
        plannedArrival: text(box, "highchartsPlannedArrival"),
        date: function (value) {
          return display.format(new Date(value));
        },
        chanceBy: function (level) {
          return text(box, "highchartsChanceBy", [level]);
        },
      };
    }

    function renderChart(box) {
      const state = highchartsState.get(box);
      const host = box.getDomRef?.()?.querySelector(".tideForecastChartHost");
      if (!state || !host || !HighchartsTimeline?.render) return;
      try {
        state.chart?.destroy();
        state.chart = HighchartsTimeline.render(
          host,
          Object.assign({}, state.outlook, { today: today() }),
          state.labels,
        );
        box.getModel("out").setProperty("/highchartsError", "");
      } catch (error) {
        box
          .getModel("out")
          .setProperty("/highchartsError", error.message || String(error));
      }
    }

    function watchChart(box, outlook, description) {
      let state = highchartsState.get(box);
      if (!state) {
        state = { chart: null, outlook: null, labels: null };
        highchartsState.set(box, state);
        ResizeHandler.register(box, function () {
          if (!box.isDestroyed()) state.chart?.reflow();
        });
        box.addEventDelegate({
          onBeforeRendering: function () {
            state.chart?.destroy();
            state.chart = null;
          },
          onAfterRendering: function () {
            renderChart(box);
          },
        });
      }
      state.chart?.destroy();
      state.chart = null;
      state.outlook = outlook;
      state.labels = chartLabels(box, description);
      renderChart(box);
    }

    function day(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
      return m
        ? display.format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])))
        : "";
    }

    function bundle(box) {
      const model = box.getModel("i18nOutlook");
      return model && model.getResourceBundle();
    }

    function text(box, key, args) {
      const b = bundle(box);
      return b ? b.getText(key, args) : key;
    }

    /** Share concurrent section loads of one finding; never reuse stale results. */
    function request(context) {
      const model = context.getModel();
      let requests = pending.get(model);
      if (!requests) {
        requests = new Map();
        pending.set(model, requests);
      }
      const path = context.getPath();
      const hit = requests.get(path);
      if (hit) return hit;
      const op = context
        .getModel()
        .bindContext("PurchasingDeskService.outlook(...)", context);
      const promise = op.invoke().then(function () {
        return op.getBoundContext().requestObject();
      });
      requests.set(path, promise);
      // Share simultaneous section loads, but never reuse an outdated outlook.
      promise
        .finally(function () {
          if (requests.get(path) === promise) requests.delete(path);
        })
        .catch(function () {});
      return promise;
    }

    function build(box, o) {
      const options = (o.options || []).map(function (opt) {
        return Object.assign({}, opt, {
          buttonText: opt.operation ? text(box, "op_" + opt.operation) : "",
        });
      });
      const confirmed = (o.markers || []).find(function (m) {
        return m.kind === "confirmed";
      });
      const estimate = (o.bands || []).find(function (b) {
        return b.kind === "estimate";
      });
      const scenarios = o.forecastKind === "tabpfn" ? o.scenarios || [] : [];
      const windowText =
        o.earliestCredibleDate && o.lateRiskDate
          ? text(
              box,
              o.forecastKind === "tabpfn"
                ? "predictedArrivalWindow"
                : "historicalArrivalWindow",
              [day(o.earliestCredibleDate), day(o.lateRiskDate)],
            )
          : "";
      const accessibleForecast = scenarios
        .map(function (scenario) {
          return (
            scenario.level +
            "% predicted chance of arrival by " +
            day(scenario.arrivalDate)
          );
        })
        .join(". ");
      const hasOnTimeProbability =
        o.forecastKind === "tabpfn" &&
        !o.requestedDateMissed &&
        typeof o.onTimeProbability === "number" &&
        Number.isFinite(o.onTimeProbability) &&
        o.onTimeProbability >= 0 &&
        o.onTimeProbability <= 1;
      const onTimeProbabilityText = o.requestedDateMissed
        ? text(box, "requestedDateMissed")
        : hasOnTimeProbability
          ? text(box, "onTimeProbabilityValue", [
              percent.format(o.onTimeProbability),
              day(o.requiredDate),
            ])
          : "";
      return {
        has: true,
        headline: o.headline || "",
        agreementText: o.agreementText || "",
        recommended:
          options.length && options[0].recommended ? options[0] : null,
        options: options,
        hasOptions: options.length > 0,
        hasAiPrediction: o.forecastKind === "tabpfn" && scenarios.length > 0,
        scenarios: scenarios,
        hasOnTimeProbability: hasOnTimeProbability,
        onTimeProbabilityText: onTimeProbabilityText,
        hasEstimate: (o.bands || []).some(function (b) {
          return b.kind === "estimate";
        }),
        arrivalSource: confirmed
          ? "confirmation"
          : o.mostLikelyDate
            ? "grid"
            : "requested",
        asOfDate: day(o.asOf),
        requiredDateText: day(o.requiredDate),
        mostLikelyDateText: day(o.mostLikelyDate),
        arrivalText: confirmed
          ? text(box, "confirmedArrival", [day(confirmed.date)])
          : o.mostLikelyDate
            ? text(
                box,
                o.forecastKind === "sap_planned"
                  ? "plannedArrival"
                  : "estimatedArrival",
                [day(o.mostLikelyDate)],
              )
            : text(box, "noEstimate"),
        sourceText: o.estimateSource
          ? text(box, "arrivalSource", [o.estimateSource])
          : "",
        plannedText:
          o.plannedDays == null
            ? ""
            : text(box, "plannedDuration", [o.plannedDays]),
        asOfText: text(box, "asOf", [day(o.asOf)]),
        arrivalWindowText: windowText,
        textAlternative:
          (o.markers || [])
            .map(function (m) {
              return m.label + ": " + day(m.date);
            })
            .join(". ") +
          (windowText ? ". " + windowText : "") +
          (accessibleForecast ? ". " + accessibleForecast : "") +
          (onTimeProbabilityText ? ". " + onTimeProbabilityText : "") +
          ". Source: " +
          o.estimateSource +
          ". Information date: " +
          day(o.asOf),
        delayText: o.daysAfterRequired
          ? text(box, "delayAfterRequired", [o.daysAfterRequired])
          : "",
        provenanceText:
          o.forecastKind === "tabpfn"
            ? text(box, "aiProvenance")
            : text(box, "provenance", [o.estimateSource, "", day(today())]),
        hasTimeline: !!(
          o.earliestCredibleDate ||
          o.mostLikelyDate ||
          (o.markers || []).length ||
          o.requiredDate
        ),
      };
    }

    function load(box, force) {
      PageSections.register(box, function () {
        return load(box, true);
      });
      const context = box.getBindingContext();
      let model = box.getModel("out");
      if (!model) {
        model = new JSONModel({ has: false });
        box.setModel(model, "out");
      }
      const path = context && context.getPath ? context.getPath() : "";
      if (!force && box.data("outlookPath") === path) return Promise.resolve();
      box.data("outlookPath", path);
      if (!path || !context.requestProperty) {
        model.setData({ has: false });
        return Promise.resolve();
      }
      if (force) pending.get(context.getModel())?.delete(path);
      return request(context)
        .then(function (o) {
          if (box.getBindingContext()?.getPath() !== path) return;
          const data = o ? build(box, o) : { has: false };
          model.setData(data);
          if (o && data.hasTimeline)
            watchChart(box, o, data.textAlternative || "");
        })
        .catch(function () {
          if (box.getBindingContext()?.getPath() === path)
            model.setData({ has: false });
        });
    }

    function root(control) {
      let c = control;
      while (
        c &&
        !(
          c.getId &&
          /(?:summaryBox|timelineBox|deliveryStoryBox|decisionBandBox|actBox|deliveryRiskHeader)$/.test(
            c.getId(),
          )
        )
      ) {
        c = c.getParent();
      }
      return c;
    }

    function extensionAPI(control) {
      let c = control;
      while (c && !(c.isA && c.isA("sap.ui.core.mvc.View"))) c = c.getParent();
      const controller = c && c.getController && c.getController();
      return controller && controller.getExtensionAPI
        ? controller.getExtensionAPI()
        : null;
    }

    function refreshPage(control) {
      const context = control && control.getBindingContext();
      if (context) PageSections.refresh(context.getPath());
    }

    function navigateTo(api, path) {
      const ctx = api.getModel().bindContext(path).getBoundContext();
      return api.getRouting().navigate(ctx);
    }

    function run(control, option) {
      const box = root(control);
      const context = box && box.getBindingContext();
      const api = extensionAPI(control);
      if (!context || !api || !option || !option.operation)
        return Promise.resolve();
      switch (option.operation) {
        case "addToApprovals":
          return CockpitActions.addToApprovals
            .call(api, context)
            .then(function () {
              refreshPage(control);
            });
        case "simulate":
          return CockpitActions.simulateFinding.call(api, context);
        case "confirm":
          return openConfirmation(control, context);
        case "checkReceipt":
          MessageBox.information(
            text(control, "receiptReference", [
              context.getProperty("PurchaseOrder"),
              context.getProperty("PurchaseOrderItem"),
            ]) +
              "\n\n" +
              option.reason +
              "\n\n" +
              option.effect,
            { title: option.title },
          );
          return Promise.resolve();
        case "openAction":
          return api
            .getRouting()
            .navigateToRoute("ActionsObjectPage", { key: option.target });
        case "openFinding": {
          const findingID = String(option.target);
          const caseID =
            "delivery:" + findingID.slice(findingID.indexOf(":") + 1);
          return navigateTo(
            api,
            "/DeliveryRisks(header_ID='" +
              encodeURIComponent(caseID).replace(/'/g, "%27") +
              "')",
          );
        }
        default:
          MessageToast.show(option.title);
          return Promise.resolve();
      }
    }

    function openConfirmation(control, context) {
      const rules = control.getModel("i18nRules").getResourceBundle();
      const formModel = new JSONModel({ date: "", quantity: "" });
      const date = new DatePicker({
        value: "{/date}",
        valueFormat: "yyyy-MM-dd",
        displayFormat: "medium",
        required: true,
      });
      const quantity = new Input({
        type: "Number",
        value: "{/quantity}",
        required: true,
      });
      let busy = false;
      const dialog = new Dialog({
        title: rules.getText("confDialogTitle"),
        contentWidth: "32rem",
        initialFocus: date,
        content: [
          new VBox({
            items: [
              new Label({ text: rules.getText("confDate"), labelFor: date }),
              date,
              new Label({
                text: rules.getText("confQuantity"),
                labelFor: quantity,
              }).addStyleClass("sapUiSmallMarginTop"),
              quantity,
            ],
          }),
        ],
        beginButton: new Button({
          text: rules.getText("confRecord"),
          type: "Emphasized",
          press: function () {
            if (busy) return;
            const value = formModel.getProperty("/date");
            const amount = Number(formModel.getProperty("/quantity"));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value || ""))
              return MessageToast.show(rules.getText("confNeedDate"));
            if (!(amount > 0))
              return MessageToast.show(rules.getText("confNeedQuantity"));
            busy = true;
            return Promise.all([
              context.requestProperty("PurchaseOrder"),
              context.requestProperty("PurchaseOrderItem"),
            ])
              .then(function (keys) {
                const target = "delivery:" + keys[0] + "/" + keys[1];
                return WorkflowPending.execute(
                  control.getModel("workflow"),
                  "confirmation:" + target,
                  target,
                  "enterConfirmation",
                  {
                    PurchaseOrder: keys[0],
                    PurchaseOrderItem: keys[1],
                    date: value,
                    quantity: amount,
                  },
                );
              })
              .then(function () {
                MessageToast.show(rules.getText("confRecorded"));
                dialog.close();
                context.getModel().refresh();
                context.refresh();
                refreshPage(control);
              })
              .catch(function (error) {
                busy = false;
                MessageBox.error(
                  error && error.message ? error.message : String(error),
                );
              });
          },
        }),
        endButton: new Button({
          text: rules.getText("confCancel"),
          press: function () {
            dialog.close();
          },
        }),
        afterClose: function () {
          dialog.destroy();
        },
      });
      dialog.addStyleClass("sapUiContentPadding");
      dialog.setModel(formModel);
      dialog.open();
      return Promise.resolve();
    }

    function onPress(event) {
      const source = event.getSource();
      const ctx = source.getBindingContext("out");
      const option = ctx
        ? ctx.getObject()
        : root(source).getModel("out").getProperty("/recommended");
      return run(source, option).catch(function (error) {
        MessageBox.error(
          error && error.message ? error.message : String(error),
        );
      });
    }

    function onWhy(event) {
      const source = event.getSource();
      const box = root(source);
      const context = box && box.getBindingContext();
      const api = extensionAPI(source);
      if (context && api) CockpitActions.whyFinding.call(api, context);
    }

    return {
      onContextChange: function (event) {
        load(event.getSource());
      },
      refreshPage: refreshPage,
      onOption: onPress,
      onWhy: onWhy,
      onCompareSuppliers: function (event) {
        const box = root(event.getSource());
        const context = box && box.getBindingContext();
        const api = extensionAPI(event.getSource());
        if (!context || !api) return;
        const query = {};
        [
          "Material",
          "Plant",
          "Supplier",
          "PurchaseOrder",
          "PurchaseOrderItem",
        ].forEach(function (name) {
          const value = context.getProperty(name);
          if (value) query[name] = value;
        });
        Promise.all([
          context.requestProperty("impact/needDate"),
          context.requestProperty("predictedArrival"),
        ]).then(function (values) {
          if (values[0]) query.needDate = values[0];
          if (values[1]) query.predictedArrival = values[1];
          api.getRouting().navigateToRoute("Simulation", { "?query": query });
        });
      },
    };
  },
);
