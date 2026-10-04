sap.ui.define(
  [
    "sap/fe/core/PageController",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/DateFormat",
    "sap/ui/core/format/NumberFormat",
    "sap/m/TableSelectDialog",
    "sap/m/ColumnListItem",
    "sap/m/Column",
    "sap/m/Text",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/core/InvisibleMessage",
    "sap/ui/core/library",
  ],
  function (
    PageController,
    JSONModel,
    DateFormat,
    NumberFormat,
    TableSelectDialog,
    ColumnListItem,
    Column,
    Text,
    Filter,
    FilterOperator,
    InvisibleMessage,
    coreLibrary,
  ) {
    "use strict";

    /**
     * Delivery Simulation is stateless; planOrder returns the percentile grid,
     * so scenario changes stay client-side.
     */

    const SLIDER = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
    const DEFAULT_INDEX = SLIDER.indexOf(0.8);
    const display = DateFormat.getDateInstance({ style: "medium", UTC: true });
    const number = NumberFormat.getFloatInstance({
      maxFractionDigits: 1,
      groupingEnabled: true,
    });
    const amount = NumberFormat.getFloatInstance({
      minFractionDigits: 2,
      maxFractionDigits: 2,
      groupingEnabled: true,
    });
    const InvisibleMessageMode = coreLibrary.InvisibleMessageMode;

    function parse(value) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
      return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    }

    function show(value) {
      const d = parse(value);
      return d ? display.format(d) : "–";
    }

    function rowAt(rows, q) {
      return (rows || []).find(function (r) {
        return Math.abs(Number(r.quantile) - q) < 1e-9;
      });
    }

    function errorMessage(error) {
      return error && error.message ? error.message : String(error || "");
    }

    return PageController.extend("tide.cockpit.ext.planning.Planning", {
      onInit: function () {
        PageController.prototype.onInit.apply(this, arguments);
        this._model = new JSONModel({
          input: {
            Material: "",
            MaterialText: "",
            Plant: "",
            PlantName: "",
            Supplier: "",
            SupplierText: "",
            needDate: "",
            OpenQuantity: "",
            Unit: "",
            PurchaseOrder: "",
            PurchaseOrderItem: "",
            predictedArrival: "",
          },
          asOf: "",
          asOfDate: null,
          busy: false,
          simulationProgress: 0,
          compareSuppliers: false,
          forcePrediction: false,
          error: "",
          needDateInvalid: false,
          needDateState: "None",
          needDateStateText: "",
          result: null,
          hasRows: false,
          index: String(DEFAULT_INDEX),
          summary: "",
          status: null,
          decision: {},
          hasSingleChart: false,
          hasComparisonChart: false,
          singleLanes: [],
          comparisonLanes: [],
          comparisonAsOf: "",
          selectedQuantile: SLIDER[DEFAULT_INDEX],
          cur: {},
          rows: [],
          comparisonVisible: false,
          comparisonRan: false,
          comparisonBusy: false,
          comparisonError: "",
          hasSupplierOptions: false,
          supplierOptions: [],
          priceLoading: false,
          priceError: "",
          priceAvailable: false,
          price: {},
        });
        this._invisibleMessage = InvisibleMessage.getInstance();
        this.getView().setModel(this._model, "plan");
        const router = this.getAppComponent().getRouter();
        // "Simulation" is the current route; "Planning" is kept only so old
        // links/bookmarks (#/Planning?...) keep working.
        this._simulationRoutes = [
          router.getRoute("Simulation"),
          router.getRoute("Planning"),
        ];
        this._simulationRoutes.forEach((route) =>
          route.attachPatternMatched(this._onMatched, this),
        );
      },

      onExit: function () {
        this._simulationRoutes?.forEach((route) =>
          route.detachPatternMatched(this._onMatched, this),
        );
        this._simulationRoutes = null;
        this._simulationRequestId = (this._simulationRequestId || 0) + 1;
        this._stopSimulationProgress();
        if (PageController.prototype.onExit)
          PageController.prototype.onExit.apply(this, arguments);
      },

      _text: function (key, args) {
        return this.getView()
          .getModel("i18nPlanning")
          .getResourceBundle()
          .getText(key, args);
      },

      _scenarioLabel: function (quantile) {
        const key =
          quantile === 0.5
            ? "scenarioP50"
            : quantile === 0.8
              ? "scenarioP80"
              : quantile === 0.9
                ? "scenarioP90"
                : "scenarioP" + Math.round(quantile * 100);
        return this._text(key);
      },

      _scenarioValue: function (row) {
        if (!row || !row.earliestDelivery)
          return this._text("supplierNoRangeShort");
        return this._text("scenarioArrivalDate", [show(row.earliestDelivery)]);
      },

      /** "Simulate Delivery" from a finding: #/Simulation?Material=…&Plant=…&Supplier=…&needDate=… */
      _onMatched: function (event) {
        const query = (event.getParameter("arguments") || {})["?query"] || {};
        const m = this._model;
        this._simulationRequestId = (this._simulationRequestId || 0) + 1;
        this._stopSimulationProgress();
        m.setProperty("/busy", false);
        m.setProperty("/input", {
          Material: query.Material || "",
          MaterialText: "",
          Plant: query.Plant || "",
          PlantName: "",
          Supplier: query.Supplier || "",
          SupplierText: "",
          needDate: query.needDate || "",
          OpenQuantity: query.OpenQuantity || "",
          Unit: query.Unit || "",
          PurchaseOrder: query.PurchaseOrder || "",
          PurchaseOrderItem: query.PurchaseOrderItem || "",
          predictedArrival: query.predictedArrival || "",
        });
        const quantity =
          query.OpenQuantity && query.Unit
            ? query.OpenQuantity + " " + query.Unit
            : "";
        m.setProperty("/compareMode", !!query.PurchaseOrder);
        m.setProperty(
          "/riskContext",
          query.PurchaseOrder
            ? this._text("poRiskContext", [
                query.PurchaseOrder + "/" + (query.PurchaseOrderItem || ""),
                quantity || this._text("quantityNotProvided"),
                query.predictedArrival
                  ? show(query.predictedArrival)
                  : this._text("arrivalNotProvided"),
              ])
            : "",
        );
        m.setProperty("/result", null);
        m.setProperty("/hasRows", false);
        m.setProperty("/hasSingleChart", false);
        m.setProperty("/error", "");
        m.setProperty("/comparisonNeedDate", query.needDate || "");
        m.setProperty("/comparisonVisible", false);
        m.setProperty("/priceLoading", false);
        m.setProperty("/priceError", "");
        m.setProperty("/priceAvailable", false);
        m.setProperty("/price", {});
        m.setProperty("/comparisonRan", false);
        m.setProperty("/comparisonBusy", false);
        m.setProperty("/comparisonError", "");
        m.setProperty("/supplierOptions", []);
        m.setProperty("/hasSupplierOptions", false);
        m.setProperty("/hasComparisonChart", false);
        this._supplierRequestId = (this._supplierRequestId || 0) + 1;
        this._asOf().then(
          function (asOf) {
            m.setProperty("/asOf", asOf);
            m.setProperty("/asOfDate", parse(asOf));
            this._checkNeedDate();
          }.bind(this),
        );
      },

      _asOf: function () {
        if (this._asOfPromise) {
          return this._asOfPromise;
        }
        const binding = this.getView()
          .getModel()
          .bindContext("/Dataset('current')");
        this._asOfPromise = binding
          .requestObject("asOf")
          .then(function (v) {
            return v || "";
          })
          .catch(function () {
            return "";
          });
        return this._asOfPromise;
      },

      /** A supplier filled in from the result is dropped when material or plant change. */
      onInputChange: function () {
        this._invalidateComparison();
        const m = this._model;
        if (
          this._filledSupplier &&
          m.getProperty("/input/Supplier") === this._filledSupplier
        ) {
          m.setProperty("/input/Supplier", "");
          m.setProperty("/input/SupplierText", "");
        }
        this._filledSupplier = null;
      },

      /** Plant typed by hand: the material may no longer be maintained there, so it is dropped. */
      onPlantChange: function () {
        this.onInputChange();
        this._model.setProperty("/input/Material", "");
        this._model.setProperty("/input/MaterialText", "");
      },

      onSupplierChange: function () {
        this._invalidateComparison();
        this._filledSupplier = null;
      },

      /** Need date typed by hand: past dates blocked with an Error value state, not just a disabled minDate. */
      onNeedDateChange: function () {
        this._checkNeedDate();
        if (!this._model.getProperty("/needDateInvalid"))
          this._invalidateComparison();
      },

      _invalidateComparison: function () {
        const m = this._model;
        this._supplierRequestId = (this._supplierRequestId || 0) + 1;
        m.setProperty("/result", null);
        m.setProperty("/hasRows", false);
        m.setProperty("/summary", "");
        m.setProperty("/status", null);
        m.setProperty("/decision", {});
        m.setProperty("/hasSingleChart", false);
        m.setProperty("/timelineAlternative", "");
        m.setProperty("/comparisonVisible", false);
        m.setProperty("/comparisonRan", false);
        m.setProperty("/comparisonBusy", false);
        m.setProperty("/comparisonError", "");
        m.setProperty("/supplierOptions", []);
        m.setProperty("/hasSupplierOptions", false);
        m.setProperty("/hasComparisonChart", false);
      },

      _checkNeedDate: function () {
        const m = this._model;
        const asOf = m.getProperty("/asOf");
        const value = m.getProperty("/input/needDate");
        if (!value || !asOf) {
          m.setProperty("/needDateInvalid", false);
          m.setProperty("/needDateState", "None");
          m.setProperty("/needDateStateText", "");
          if (value && !/^(\d{4})-(\d{2})-(\d{2})$/.test(value)) {
            m.setProperty("/needDateInvalid", true);
            m.setProperty("/needDateState", "Error");
            m.setProperty("/needDateStateText", this._text("needDateInvalid"));
          }
          return;
        }
        if (value < asOf) {
          m.setProperty("/needDateInvalid", true);
          m.setProperty("/needDateState", "Error");
          m.setProperty(
            "/needDateStateText",
            this._text("needDatePast", [show(asOf)]),
          );
        } else {
          m.setProperty("/needDateInvalid", false);
          m.setProperty("/needDateState", "None");
          m.setProperty("/needDateStateText", "");
        }
        if (value && !m.getProperty("/needDateInvalid")) {
          m.setProperty("/input/needDate", value);
        }
      },

      // ------------------------------------------------------------ value helps

      /** Generic TableSelectDialog over an OData V4 collection, code + description. */
      _openValueHelp: function (options) {
        const view = this.getView();
        const dialogModel = view.getModel();
        const staticFilters = options.filters || [];
        const dialog = new TableSelectDialog({
          title: options.title,
          noDataText: options.noDataText,
          search: function (event) {
            const value = event.getParameter("value");
            const binding = dialog.getBinding("items");
            const searchFilter = value
              ? new Filter({
                  filters: options.searchFields.map(
                    (f) => new Filter(f, FilterOperator.Contains, value),
                  ),
                  and: false,
                })
              : null;
            binding.filter(
              searchFilter
                ? staticFilters.concat([searchFilter])
                : staticFilters,
            );
          },
          confirm: function (event) {
            const item = event.getParameter("selectedItem");
            if (item) {
              options.onSelect(item.getBindingContext().getObject());
            }
            dialog.destroy();
          },
          cancel: function () {
            dialog.destroy();
          },
        });
        options.columns.forEach(function (c) {
          dialog.addColumn(new Column({ header: new Text({ text: c.label }) }));
        });
        dialog.bindAggregation("items", {
          path: options.path,
          filters: staticFilters,
          template: new ColumnListItem({
            cells: options.columns.map(
              (c) => new Text({ text: "{" + c.field + "}" }),
            ),
          }),
        });
        dialog.setModel(dialogModel);
        view.addDependent(dialog);
        dialog.open();
      },

      onPlantHelp: function () {
        this._invalidateComparison();
        this._openValueHelp({
          title: this._text("plant"),
          noDataText: this._text("noPlants"),
          path: "/PlanningPlants",
          searchFields: ["Plant", "PlantName"],
          columns: [
            { label: this._text("plant"), field: "Plant" },
            { label: this._text("plantName"), field: "PlantName" },
          ],
          onSelect: function (row) {
            this._model.setProperty("/input/Plant", row.Plant);
            this._model.setProperty("/input/PlantName", row.PlantName || "");
            // A material chosen for a different plant may not be maintained here.
            this._model.setProperty("/input/Material", "");
            this._model.setProperty("/input/MaterialText", "");
          }.bind(this),
        });
      },

      /** Scope material choices to the selected plant to prevent picks not maintained there. */
      onMaterialHelp: function () {
        this._invalidateComparison();
        const plant = (this._model.getProperty("/input/Plant") || "").trim();
        if (!plant) {
          return;
        }
        this._openValueHelp({
          title: this._text("material"),
          noDataText: this._text("noMaterials"),
          path: "/PlanningMaterials",
          filters: [new Filter("Plant", FilterOperator.EQ, plant)],
          searchFields: ["Material", "MaterialText"],
          columns: [
            { label: this._text("material"), field: "Material" },
            { label: this._text("materialText"), field: "MaterialText" },
          ],
          onSelect: function (row) {
            this._model.setProperty("/input/Material", row.Material);
            this._model.setProperty(
              "/input/MaterialText",
              row.MaterialText || "",
            );
          }.bind(this),
        });
      },

      onSupplierHelp: function () {
        this._invalidateComparison();
        const material = this._model.getProperty("/input/Material");
        const plant = this._model.getProperty("/input/Plant");
        if (material && plant) {
          this._openSupplierSourcesHelp(material, plant);
          return;
        }
        this._openValueHelp({
          title: this._text("supplier"),
          noDataText: this._text("noSuppliers"),
          path: "/PlanningSuppliers",
          searchFields: ["Supplier", "SupplierName"],
          columns: [
            { label: this._text("supplier"), field: "Supplier" },
            { label: this._text("supplierName"), field: "SupplierName" },
          ],
          onSelect: function (row) {
            this._filledSupplier = null;
            this._model.setProperty("/input/Supplier", row.Supplier);
            this._model.setProperty(
              "/input/SupplierText",
              row.SupplierName || "",
            );
          }.bind(this),
        });
      },

      /** Suppliers already known for this material + plant, listed with their last order date. */
      _openSupplierSourcesHelp: function (material, plant) {
        const view = this.getView();
        const op = view.getModel().bindContext("/planningSources(...)");
        op.setParameter("Material", material);
        op.setParameter("Plant", plant);
        op.invoke()
          .then(
            function () {
              const rows = op.getBoundContext().getObject().value || [];
              const dialogModel = new JSONModel({ rows: rows });
              const dialog = new TableSelectDialog({
                title: this._text("supplier"),
                noDataText: this._text("noSuppliersForMaterial"),
                columns: [
                  new Column({
                    header: new Text({ text: this._text("supplier") }),
                  }),
                  new Column({
                    header: new Text({ text: this._text("supplierName") }),
                  }),
                  new Column({
                    header: new Text({ text: this._text("supplierFromCol") }),
                  }),
                ],
                confirm: function (event) {
                  const item = event.getParameter("selectedItem");
                  if (item) {
                    const row = item.getBindingContext("sources").getObject();
                    this._filledSupplier = null;
                    this._model.setProperty("/input/Supplier", row.Supplier);
                    this._model.setProperty(
                      "/input/SupplierText",
                      row.SupplierName || "",
                    );
                  }
                  dialog.destroy();
                }.bind(this),
                cancel: function () {
                  dialog.destroy();
                },
              });
              dialog.bindAggregation("items", {
                path: "/rows",
                model: "sources",
                template: new ColumnListItem({
                  cells: [
                    new Text({ text: "{sources>Supplier}" }),
                    new Text({ text: "{sources>SupplierName}" }),
                    new Text({ text: "{sources>from}" }),
                  ],
                }),
              });
              dialog.setModel(dialogModel, "sources");
              view.addDependent(dialog);
              dialog.open();
            }.bind(this),
          )
          .catch(
            function () {
              this.onSupplierHelp();
            }.bind(this),
          );
      },

      // ------------------------------------------------------------ simulate

      _startSimulationProgress: function () {
        this._stopSimulationProgress();
        let progress = 5;
        this._model.setProperty("/simulationProgress", progress);
        this._simulationTimer = setInterval(
          function () {
            progress += (92 - progress) * 0.08;
            this._model.setProperty("/simulationProgress", progress);
          }.bind(this),
          250,
        );
      },

      _stopSimulationProgress: function () {
        if (this._simulationTimer != null) clearInterval(this._simulationTimer);
        this._simulationTimer = null;
        this._model.setProperty("/simulationProgress", 100);
      },

      onCalculate: function () {
        const m = this._model;
        const input = m.getProperty("/input");
        if (
          m.getProperty("/busy") ||
          !input.Material ||
          !input.Plant ||
          m.getProperty("/needDateInvalid")
        ) {
          return;
        }
        this._invalidateComparison();
        const requestId = (this._simulationRequestId || 0) + 1;
        this._simulationRequestId = requestId;
        m.setProperty("/busy", true);
        this._startSimulationProgress();
        m.setProperty("/priceLoading", true);
        m.setProperty("/error", "");
        const compare = m.getProperty("/compareSuppliers");
        const op = this.getView().getModel().bindContext("/planOrder(...)");
        op.setParameter("Material", input.Material.trim());
        op.setParameter("Plant", input.Plant.trim());
        op.setParameter("Supplier", (input.Supplier || "").trim() || null);
        // Empty need date: the service uses its default (as-of + 8 weeks) and returns it.
        op.setParameter("needDate", input.needDate || null);
        op.setParameter("force", m.getProperty("/forcePrediction") === true);
        return op
          .invoke()
          .then(
            function () {
              if (this._simulationRequestId !== requestId) return;
              this._show(op.getBoundContext().getObject());
              if (compare) return this.onCompareSuppliers();
            }.bind(this),
          )
          .catch(
            function (e) {
              if (this._simulationRequestId !== requestId) return;
              m.setProperty("/result", null);
              m.setProperty("/hasRows", false);
              m.setProperty(
                "/error",
                this._text("error", [(e && e.message) || ""]),
              );
              this._invisibleMessage.announce(
                m.getProperty("/error"),
                InvisibleMessageMode.Assertive,
              );
            }.bind(this),
          )
          .finally(
            function () {
              if (this._simulationRequestId !== requestId) return;
              this._stopSimulationProgress();
              m.setProperty("/busy", false);
              m.setProperty("/priceLoading", false);
            }.bind(this),
          );
      },

      _show: function (r) {
        const m = this._model;
        const rows = r.rows || [];
        m.setProperty("/index", String(DEFAULT_INDEX));
        if (!m.getProperty("/input/Supplier") && r.Supplier) {
          m.setProperty("/input/Supplier", r.Supplier);
          m.setProperty("/input/SupplierText", r.SupplierName || "");
          this._filledSupplier = r.Supplier;
        }
        if (r.MaterialText)
          m.setProperty("/input/MaterialText", r.MaterialText);
        if (r.PlantName) m.setProperty("/input/PlantName", r.PlantName);
        const cur = r.currency || "";
        const asOf = m.getProperty("/asOf");
        m.setProperty(
          "/input/needDate",
          r.needDate || m.getProperty("/input/needDate"),
        );
        m.setProperty("/result", r);
        const currency = r.assumedPriceCurrency || r.currency || "";
        const source = r.priceSource || "unavailable";
        const available =
          (r.priceP50 !== null && r.priceP50 !== undefined) ||
          (r.historicalPriceReference !== null &&
            r.historicalPriceReference !== undefined);
        m.setProperty("/priceAvailable", available);
        m.setProperty(
          "/priceError",
          source === "unavailable"
            ? r.priceReason || this._text("priceUnavailable")
            : "",
        );
        m.setProperty("/price", {
          unit: (currency ? currency + " / " : "") + (r.assumedPriceUnit || ""),
          p50Text:
            r.priceP50 != null
              ? amount.format(r.priceP50) +
                " " +
                currency +
                " / " +
                (r.assumedPriceUnit || "")
              : "–",
          rangeText:
            r.priceP10 != null && r.priceP90 != null
              ? amount.format(r.priceP10) +
                " to " +
                amount.format(r.priceP90) +
                " " +
                currency
              : "–",
          historicalText:
            r.historicalPriceReference != null
              ? amount.format(r.historicalPriceReference) +
                " " +
                currency +
                " (" +
                (r.historicalPriceCount || 0) +
                ")"
              : "–",
          assumptionText:
            r.assumedPriceQuantity != null
              ? number.format(r.assumedPriceQuantity) +
                " " +
                (r.assumedPriceUnit || "") +
                "; " +
                currency
              : "–",
          sourceText:
            source === "tabpfn"
              ? this._text("priceModel")
              : this._text("priceUnavailable"),
          sourceState: source === "tabpfn" ? "Information" : "None",
        });
        m.setProperty("/hasRows", rows.length > 0);
        m.setProperty(
          "/summary",
          [r.Material, r.Supplier, r.Plant, show(r.needDate)]
            .filter(Boolean)
            .join(" · "),
        );
        m.setProperty("/cur", {});
        m.setProperty("/comparisonVisible", false);
        m.setProperty("/comparisonRan", false);
        m.setProperty("/comparisonError", "");
        m.setProperty("/supplierOptions", []);
        m.setProperty("/hasSupplierOptions", false);
        m.setProperty("/hasComparisonChart", false);
        this._supplierRequestId = (this._supplierRequestId || 0) + 1;

        // --------- status badge: on track / order now / not achievable ---------
        const orderRow = rowAt(rows, 0.8) || {};
        const daysLeft = orderRow.latestOrderDate
          ? this._daysBetween(asOf, orderRow.latestOrderDate)
          : null;
        let statusKey = "statusOnTrack";
        let statusState = "Success";
        if (!r.feasible) {
          statusKey = "statusNotAchievable";
          statusState = "Error";
        } else if (daysLeft !== null && daysLeft <= 0) {
          statusKey = "statusOrderOverdue";
          statusState = "Error";
        } else if (daysLeft !== null && daysLeft <= 7) {
          statusKey = "statusOrderNow";
          statusState = "Warning";
        }
        if (rows.length && !orderRow.reachable) {
          statusKey =
            !orderRow.latestOrderDate || orderRow.latestOrderDate >= asOf
              ? "statusP80NeedDateInfeasible"
              : "statusP80Overdue";
          statusState = "Error";
        }
        m.setProperty("/status", {
          text: this._text(statusKey),
          state: statusState,
        });
        m.setProperty(
          "/earliestAchievableText",
          r.earliestAchievableDate
            ? this._text("earliestAchievable", [show(r.earliestAchievableDate)])
            : "",
        );
        m.setProperty(
          "/maintainedText",
          r.plannedDays === null || r.plannedDays === undefined
            ? this._text("sapNotMaintained")
            : this._text("days", [number.format(r.plannedDays)]),
        );
        const sapGap = r.masterDataDirection
          ? this._text(
              r.masterDataDirection === "too_short"
                ? "sapGapTooShort"
                : r.masterDataDirection === "too_long"
                  ? "sapGapTooLong"
                  : "sapGapInLine",
              [
                String(Math.round(r.masterDataGapDays)),
                number.format(r.masterDataTypicalDays),
              ],
            )
          : r.plannedDays === null || r.plannedDays === undefined
            ? this._text("sapGapUnavailable")
            : this._text("sapGapNoRange");
        m.setProperty("/decision", {
          orderByDateText: show(orderRow.latestOrderDate),
          recommendedLabel: this._text("recommendedOrderBy"),
          needDateText: show(r.needDate),
          daysText:
            daysLeft === null
              ? "–"
              : daysLeft < 0
                ? this._text("daysOverdue", [String(Math.abs(daysLeft))])
                : daysLeft === 0
                  ? this._text("orderByToday")
                  : this._text("daysRemainingCount", [String(daysLeft)]),
          daysState:
            daysLeft === null
              ? "None"
              : daysLeft <= 0
                ? "Error"
                : daysLeft <= 7
                  ? "Warning"
                  : "Success",
          daysIcon:
            daysLeft !== null && daysLeft <= 0 ? "sap-icon://alert" : "",
          feasibilityText: !r.feasible
            ? this._text("infeasible")
            : orderRow.reachable
              ? this._text("feasibleAtP80")
              : this._text("p80NotReachable"),
          feasibilityState:
            !r.feasible || !orderRow.reachable ? "Error" : "Success",
          feasibilityIcon:
            !r.feasible || !orderRow.reachable
              ? "sap-icon://alert"
              : "sap-icon://accept",
          sapText: sapGap,
        });
        if (!rows.length) {
          m.setProperty(
            "/decision/sapText",
            r.sapOrderDate
              ? this._text("sapOrderDateValue", [
                  show(r.sapOrderDate),
                  number.format(r.plannedDays),
                  r.plannedFrom,
                ])
              : this._text("sapNotMaintained"),
          );
        }
        m.setProperty(
          "/sapText",
          r.sapOrderDate
            ? this._text("sapOrderDateValue", [
                show(r.sapOrderDate),
                number.format(r.plannedDays),
                r.plannedFrom,
              ])
            : this._text("sapNotMaintained"),
        );

        m.setProperty(
          "/sapText",
          r.sapOrderDate
            ? this._text("sapOrderDateValue", [
                show(r.sapOrderDate),
                number.format(r.plannedDays),
                r.plannedFrom,
              ])
            : this._text("sapNotMaintained"),
        );
        m.setProperty(
          "/goodsReceiptText",
          r.goodsReceiptDays === null || r.goodsReceiptDays === undefined
            ? ""
            : this._text("days", [number.format(r.goodsReceiptDays)]),
        );
        m.setProperty(
          "/infoRecordText",
          r.plannedFrom === "info record" && r.plannedInfoRecord
            ? this._text("infoRecordRef", [
                r.plannedInfoRecord,
                show(r.plannedSince),
              ])
            : "",
        );
        m.setProperty(
          "/materialSinceText",
          r.materialSince
            ? this._text("sinceDate", [show(r.materialSince)])
            : "",
        );
        m.setProperty(
          "/supplierSinceText",
          r.supplierSince
            ? this._text("sinceDate", [show(r.supplierSince)])
            : "",
        );
        m.setProperty(
          "/evidenceSourceText",
          this._text("sourceAndHistory", [
            r.sourceText || this._text("unknownSource"),
            r.n == null ? this._text("noHistoryCount") : String(r.n),
          ]),
        );
        m.setProperty(
          "/rangeEvidenceText",
          r.rangeAgreement
            ? this._text("rangeAgreement", [
                r.rangeAgreement === "aligned"
                  ? this._text("rangeAligned")
                  : this._text("rangeDivergent"),
              ])
            : r.modelFallback
              ? this._text("rangeFallback", [r.modelFallback])
              : "",
        );
        m.setProperty("/comparisonNeedDate", r.needDate);

        // --------- master-data verdict ---------
        if (r.masterDataDirection) {
          const key =
            r.masterDataDirection === "too_short"
              ? "verdictTooShort"
              : r.masterDataDirection === "too_long"
                ? "verdictTooLong"
                : "verdictPlausible";
          m.setProperty(
            "/verdictText",
            this._text(key, [
              String(Math.round(r.masterDataGapDays)),
              number.format(r.masterDataTypicalDays),
            ]),
          );
          m.setProperty(
            "/verdictState",
            r.masterDataDirection === "plausible" ? "Success" : "Warning",
          );
          m.setProperty(
            "/verdictActionable",
            r.masterDataDirection !== "plausible",
          );
        } else {
          m.setProperty("/verdictText", "");
          m.setProperty("/verdictActionable", false);
        }

        const hasDemand = r.dailyDemand !== null && r.dailyDemand !== undefined;
        m.setProperty("/hasDemand", hasDemand);
        m.setProperty(
          "/hasValue",
          hasDemand && r.unitPrice !== null && r.unitPrice !== undefined,
        );
        m.setProperty(
          "/demandText",
          hasDemand ? number.format(r.dailyDemand) + " " + (r.unit || "") : "",
        );
        m.setProperty(
          "/unitPriceText",
          hasDemand && r.unitPrice != null
            ? amount.format(r.unitPrice) +
                " " +
                (r.currency || "") +
                " / " +
                (r.unit || "")
            : "",
        );
        m.setProperty(
          "/rows",
          SLIDER.map(
            function (q, i) {
              const row = rowAt(rows, q) || {};
              const unit = r.unit || "";
              const past =
                !!row.latestOrderDate && asOf && row.latestOrderDate < asOf;
              const dueToday =
                !!row.latestOrderDate && asOf && row.latestOrderDate === asOf;
              const soon =
                !past &&
                !!row.latestOrderDate &&
                asOf &&
                row.latestOrderDate <= this._addDays(asOf, 7);
              const days = row.latestOrderDate
                ? this._daysBetween(asOf, row.latestOrderDate)
                : null;
              return {
                index: i,
                selected: i === DEFAULT_INDEX,
                levelText: this._scenarioLabel(q),
                leadTimeText: this._text("days", [
                  number.format(row.leadTimeDays),
                ]),
                latestText: show(row.latestOrderDate),
                latestState: past
                  ? "Error"
                  : dueToday || soon
                    ? "Warning"
                    : "Success",
                latestIcon: past || dueToday ? "sap-icon://alert" : "",
                daysLeftText: past
                  ? this._text("orderByPast", [String(Math.abs(days))])
                  : dueToday
                    ? this._text("orderByToday")
                    : days === null
                      ? "–"
                      : this._text("daysRemainingCount", [String(days)]),
                daysLeftState: past
                  ? "Error"
                  : dueToday || soon
                    ? "Warning"
                    : "Success",
                meetsNeedText: row.reachable
                  ? this._text("yes")
                  : this._text("no"),
                meetsNeedState: row.reachable ? "Success" : "Error",
                bufferText: this._text("days", [number.format(row.safetyDays)]),
                stockText:
                  row.safetyStock === null || row.safetyStock === undefined
                    ? "–"
                    : number.format(row.safetyStock) + " " + unit,
                stockValueText:
                  row.safetyStockValue === null ||
                  row.safetyStockValue === undefined
                    ? "–"
                    : amount.format(row.safetyStockValue) + " " + cur,
              };
            }.bind(this),
          ),
        );
        m.setProperty("/currency", cur);
        this._updateSingleChart(r);
        m.setProperty("/comparisonVisible", false);
        m.setProperty("/comparisonRan", false);
        m.setProperty("/comparisonError", "");
        m.setProperty("/supplierOptions", []);
        m.setProperty("/hasSupplierOptions", false);
        m.setProperty("/hasComparisonChart", false);
        this._select(Number(m.getProperty("/index")));
      },

      onCompareSuppliers: function () {
        const m = this._model;
        const input = m.getProperty("/input");
        if (
          !input.Material ||
          !input.Plant ||
          m.getProperty("/needDateInvalid")
        ) {
          return;
        }
        const material = input.Material.trim();
        const plant = input.Plant.trim();
        const requestId = (this._supplierRequestId || 0) + 1;
        this._supplierRequestId = requestId;
        m.setProperty("/comparisonVisible", true);
        m.setProperty("/comparisonRan", true);
        m.setProperty("/comparisonBusy", true);
        m.setProperty("/comparisonError", "");
        m.setProperty("/supplierOptions", []);
        m.setProperty("/hasSupplierOptions", false);
        m.setProperty("/hasComparisonChart", false);
        m.setProperty("/comparisonLanes", []);
        const operation = this.getView()
          .getModel()
          .bindContext("/compareSuppliers(...)");
        operation.setParameter("Material", material);
        operation.setParameter("Plant", plant);
        operation.setParameter("needDate", input.needDate || null);
        operation.setParameter(
          "force",
          m.getProperty("/forcePrediction") === true,
        );
        return operation
          .invoke()
          .then(function () {
            return operation.getBoundContext().requestObject();
          })
          .then(
            function (response) {
              if (this._supplierRequestId !== requestId) return;
              const comparison = response || {};
              const options = (comparison.options || [])
                .map(
                  function (option) {
                    const supplierText = option.SupplierName
                      ? option.SupplierName + " (" + option.Supplier + ")"
                      : option.Supplier;
                    const hasRange = !!option.p50Date;
                    const currency = option.assumedPriceCurrency || "";
                    return Object.assign({}, option, {
                      supplierText: supplierText,
                      priceUnitText: [currency, option.assumedPriceUnit]
                        .filter(Boolean)
                        .join(" / "),
                      hasRange: hasRange,
                      errorText: option.error || "",
                      rangeMessage: hasRange
                        ? ""
                        : this._text("supplierNoRange"),
                      feasibilitySummary: hasRange
                        ? this._text(
                            option.p80Reachable
                              ? "supplierNeedDateFeasible"
                              : "supplierNeedDateInfeasible",
                          )
                        : this._text("supplierNoRangeShort"),
                      feasibilityState:
                        hasRange && option.p80Reachable
                          ? "Success"
                          : hasRange
                            ? "Error"
                            : "None",
                      p50Text: show(option.p50Date),
                      p80Text: show(option.p80Date),
                      p90Text: show(option.p90Date),
                      p50FeasibilityText: hasRange
                        ? this._text(
                            option.p50Reachable
                              ? "meetsNeedDate"
                              : "missesNeedDate",
                          )
                        : this._text("supplierNoRangeShort"),
                      p80FeasibilityText: hasRange
                        ? this._text(
                            option.p80Reachable
                              ? "meetsNeedDate"
                              : "missesNeedDate",
                          )
                        : this._text("supplierNoRangeShort"),
                      p90FeasibilityText: hasRange
                        ? this._text(
                            option.p90Reachable
                              ? "meetsNeedDate"
                              : "missesNeedDate",
                          )
                        : this._text("supplierNoRangeShort"),
                      p50FeasibilityState: option.p50Reachable
                        ? "Success"
                        : "Error",
                      p80FeasibilityState: option.p80Reachable
                        ? "Success"
                        : "Error",
                      p90FeasibilityState: option.p90Reachable
                        ? "Success"
                        : "Error",
                      priceP50Text:
                        option.priceP50 == null
                          ? "–"
                          : amount.format(option.priceP50) + " " + currency,
                      priceRangeText:
                        option.priceP10 == null || option.priceP90 == null
                          ? "–"
                          : amount.format(option.priceP10) +
                            "-" +
                            amount.format(option.priceP90) +
                            " " +
                            currency,
                      priceSourceText:
                        option.priceSource === "tabpfn"
                          ? this._text("priceModel")
                          : this._text("priceUnavailable"),
                    });
                  }.bind(this),
                )
                .sort(function (left, right) {
                  return (
                    Number(right.p80Reachable) - Number(left.p80Reachable) ||
                    String(left.p80Date || "9999").localeCompare(
                      String(right.p80Date || "9999"),
                    ) ||
                    String(left.supplierText).localeCompare(
                      String(right.supplierText),
                    )
                  );
                });
              m.setProperty("/supplierOptions", options);
              m.setProperty("/comparisonPriceLanes", this._priceLanes(options));
              m.setProperty("/hasSupplierOptions", options.length > 0);
              const selectedSupplier = m.getProperty("/result/Supplier");
              const selectedLane = (m.getProperty("/singleLanes") || [])[0];
              m.setProperty(
                "/comparisonLanes",
                options.map(function (option) {
                  if (
                    option.Supplier === selectedSupplier &&
                    selectedLane &&
                    !option.errorText
                  ) {
                    return Object.assign({}, selectedLane, {
                      id: option.Supplier,
                      name: option.supplierText,
                    });
                  }
                  return {
                    id: option.Supplier,
                    name: option.supplierText,
                    points: [
                      { quantile: 0.5, date: option.p50Date },
                      { quantile: 0.8, date: option.p80Date },
                      { quantile: 0.9, date: option.p90Date },
                    ],
                  };
                }),
              );
              m.setProperty("/comparisonAsOf", comparison.asOf);
              m.setProperty("/comparisonNeedDate", comparison.needDate);
              m.setProperty(
                "/hasComparisonChart",
                options.some(function (option) {
                  return option.hasRange;
                }),
              );
              if (!options.length) {
                m.setProperty(
                  "/comparisonError",
                  this._text("supplierComparisonEmpty"),
                );
              }
              this._invisibleMessage.announce(
                m.getProperty("/comparisonError") ||
                  this._text("supplierComparisonComplete", [
                    String(options.length),
                  ]),
                m.getProperty("/comparisonError")
                  ? InvisibleMessageMode.Assertive
                  : InvisibleMessageMode.Polite,
              );
            }.bind(this),
          )
          .catch(
            function (error) {
              if (this._supplierRequestId !== requestId) return;
              m.setProperty(
                "/comparisonError",
                this._text("supplierComparisonUnavailable", [
                  (error && error.message) || "",
                ]),
              );
              m.setProperty("/hasSupplierOptions", false);
              this._invisibleMessage.announce(
                m.getProperty("/comparisonError"),
                InvisibleMessageMode.Assertive,
              );
            }.bind(this),
          )
          .finally(
            function () {
              if (this._supplierRequestId === requestId)
                m.setProperty("/comparisonBusy", false);
            }.bind(this),
          );
      },

      _addDays: function (iso, days) {
        const d = parse(iso);
        if (!d) return iso;
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      },

      _updateSingleChart: function (result) {
        this._model.setProperty(
          "/singlePriceLanes",
          this._priceLanes([result]),
        );
        const points = (result.rows || [])
          .filter(function (row) {
            return row.earliestDelivery;
          })
          .map(function (row) {
            return { quantile: row.quantile, date: row.earliestDelivery };
          });
        this._model.setProperty(
          "/singleLanes",
          points.length
            ? [
                {
                  id: "selected",
                  name: result.SupplierName
                    ? result.SupplierName + " (" + result.Supplier + ")"
                    : result.Supplier || this._text("supplier"),
                  points: points,
                },
              ]
            : [],
        );
        this._model.setProperty("/hasSingleChart", points.length > 0);
      },

      onChartScenarioSelect: function (event) {
        const index = SLIDER.indexOf(event.getParameter("quantile"));
        if (index >= 0) this._select(index);
      },

      _priceLanes: function (options) {
        return options.map(function (option) {
          const unit = [option.assumedPriceCurrency, option.assumedPriceUnit]
            .filter(Boolean)
            .join(" / ");
          const supplier =
            option.supplierText ||
            (option.SupplierName
              ? option.SupplierName + " (" + option.Supplier + ")"
              : option.Supplier);
          return {
            id: option.Supplier,
            name: supplier + (unit ? " - " + unit : ""),
            points:
              option.priceP50 === null || option.priceP50 === undefined
                ? []
                : [
                    { quantile: 0.1, value: option.priceP10 },
                    { quantile: 0.5, value: option.priceP50 },
                    { quantile: 0.9, value: option.priceP90 },
                  ],
          };
        });
      },

      /** Level chosen from the segmented button: the values of that level, no request. */
      onLevelSelect: function (event) {
        this._select(Number(event.getParameter("item").getKey()));
      },

      /** Level chosen from the table: same selection as the segmented button. */
      onRowSelect: function (event) {
        const item = event.getParameter("listItem");
        if (!item) return;
        const row = item.getBindingContext("plan").getObject();
        this._select(Number(row.index));
      },

      _select: function (index) {
        const m = this._model;
        const r = m.getProperty("/result");
        const i = Math.max(0, Math.min(SLIDER.length - 1, Number(index)));
        m.setProperty("/index", String(i));
        m.setProperty("/selectedQuantile", SLIDER[i]);
        m.setProperty(
          "/rows",
          (m.getProperty("/rows") || []).map(function (row, k) {
            return Object.assign({}, row, { selected: k === i });
          }),
        );
        if (!r) {
          return;
        }
        const row = rowAt(r.rows, SLIDER[i]);
        if (!row) {
          return;
        }
        const unit = r.unit || "";
        const cur = r.currency || "";
        const own = row.of !== null && row.of !== undefined;
        const asOf = m.getProperty("/asOf");
        const past =
          !!row.latestOrderDate && asOf && row.latestOrderDate < asOf;
        const dueToday =
          !!row.latestOrderDate && asOf && row.latestOrderDate === asOf;
        const daysPast = past
          ? this._daysBetween(row.latestOrderDate, asOf)
          : 0;
        m.setProperty("/cur", {
          levelText: this._text("days", [number.format(row.safetyDays)]),
          latestText: show(row.latestOrderDate),
          latestState: past ? "Error" : dueToday ? "Warning" : "Success",
          latestIcon:
            past || dueToday ? "sap-icon://alert" : "sap-icon://accept",
          latestNote: past
            ? this._text("orderByPast", [String(daysPast)])
            : dueToday
              ? this._text("orderByToday")
              : "",
          leadTimeText: this._text("days", [number.format(row.leadTimeDays)]),
          earliestText: this._text("earliestNote", [
            show(row.earliestDelivery),
          ]),
          reachable: !!row.reachable,
          reachableText: row.reachable
            ? this._text("reachable")
            : this._text("notReachable"),
          reachableState: row.reachable ? "Success" : "Error",
          bufferText: this._text("days", [number.format(row.safetyDays)]),
          likeText: own
            ? this._text("likePast", [String(row.within), String(row.of)])
            : this._text("aiNote"),
          note: own ? "" : this._text("aiNote"),
          stockText:
            row.safetyStock === null || row.safetyStock === undefined
              ? "–"
              : number.format(row.safetyStock) + " " + unit,
          stockValueText:
            row.safetyStockValue === null || row.safetyStockValue === undefined
              ? "–"
              : amount.format(row.safetyStockValue) + " " + cur,
        });
        const p80 = rowAt(r.rows, 0.8) || {};
        const p80Days = p80.latestOrderDate
          ? this._daysBetween(asOf, p80.latestOrderDate)
          : null;
        m.setProperty("/decision/orderByDateText", show(p80.latestOrderDate));
        m.setProperty(
          "/decision/recommendedLabel",
          this._text("recommendedOrderBy"),
        );
        m.setProperty(
          "/decision/recommendedLabel",
          this._text("recommendedOrderBy"),
        );
        m.setProperty("/decision/needDateText", show(r.needDate));
        m.setProperty(
          "/decision/daysText",
          p80Days === null
            ? "–"
            : p80Days < 0
              ? this._text("daysOverdue", [String(Math.abs(p80Days))])
              : p80Days === 0
                ? this._text("orderByToday")
                : this._text("daysRemainingCount", [String(p80Days)]),
        );
        m.setProperty(
          "/decision/daysState",
          p80Days === null
            ? "None"
            : p80Days <= 0
              ? "Error"
              : p80Days <= 7
                ? "Warning"
                : "Success",
        );
        m.setProperty(
          "/decision/daysIcon",
          p80Days !== null && p80Days <= 0 ? "sap-icon://alert" : "",
        );
        m.setProperty(
          "/decision/feasibilityText",
          !r.feasible
            ? this._text("infeasible")
            : p80.reachable
              ? this._text("feasibleAtP80")
              : this._text("p80NotReachable"),
        );
        m.setProperty(
          "/decision/feasibilityState",
          !r.feasible || !p80.reachable ? "Error" : "Success",
        );
        m.setProperty(
          "/decision/feasibilityIcon",
          !r.feasible || !p80.reachable
            ? "sap-icon://alert"
            : "sap-icon://accept",
        );
        const selectedScenario = this._scenarioLabel(SLIDER[i]);
        m.setProperty(
          "/decision/selectedScenarioText",
          this._text("selectedScenarioSummary", [
            selectedScenario,
            show(row.latestOrderDate),
          ]),
        );
        const sapText = r.masterDataDirection
          ? this._text(
              r.masterDataDirection === "too_short"
                ? "sapGapTooShort"
                : r.masterDataDirection === "too_long"
                  ? "sapGapTooLong"
                  : "sapGapInLine",
              [
                String(Math.round(r.masterDataGapDays)),
                number.format(r.masterDataTypicalDays),
              ],
            )
          : r.plannedDays == null
            ? this._text("sapGapUnavailable")
            : this._text("sapGapNoRange");
        m.setProperty("/decision/sapText", sapText);
      },

      _daysBetween: function (from, to) {
        const a = parse(from);
        const b = parse(to);
        if (!a || !b) return 0;
        return Math.round((b.getTime() - a.getTime()) / 86400000);
      },
    });
  },
);
