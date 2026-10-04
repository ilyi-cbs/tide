sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/DateFormat",
    "tide/cockpit/ext/shared/Attention",
    "sap/m/Button",
    "sap/m/Dialog",
    "sap/m/Input",
    "sap/m/Label",
    "sap/m/MessageBox",
    "sap/m/Select",
    "sap/ui/core/Item",
    "tide/cockpit/ext/shared/WorkflowPending",
  ],
  function (
    JSONModel,
    DateFormat,
    Attention,
    Button,
    Dialog,
    Input,
    Label,
    MessageBox,
    Select,
    Item,
    WorkflowPending,
  ) {
    "use strict";

    const activeLoads = new WeakMap();
    const dateTime = DateFormat.getDateTimeInstance({
      style: "medium",
      UTC: true,
    });
    const date = DateFormat.getDateInstance({ style: "medium", UTC: true });
    const operations = {
      delivery_intervention: "Contact supplier about delivery",
      delivery_escalation: "Escalate delivery follow-up",
      pdt_change: "Update planned delivery time",
      price_clarification: "Review price difference",
      master_data_duplicate_review: "Review duplicate materials",
      planner_review: "Review unusual planning setting",
      requisition_review: "Review purchase requisition",
      code_list: "Review code suggestions",
      prediction_worklist: "Review prediction worklist",
      price_check: "Check price",
      post_confirmation: "Record delivery confirmation",
    };
    const events = {
      prepared: "Prepared",
      approved: "Approved",
      declined: "Declined",
      resolved: "Outcome logged",
      follow_up_overdue: "Follow-up overdue",
    };
    const requestTypes = {
      delivery_intervention: "Delivery Risk - At Risk",
      delivery_escalation: "Delivery Risk - Overdue",
      price_clarification: "Price Deviation",
      master_data_duplicate_review: "Duplicate Materials",
      planner_review: "Unusual Planning Setting",
      pdt_change: "Supplier Planned Time",
      requisition_review: "Purchase Requisition Review",
      code_list: "Code Suggestion Review",
      prediction_worklist: "Prediction Worklist",
    };
    const caseRoutes = {
      delivery: "DeliveryRiskCaseObjectPage",
      price: "PriceDeviationObjectPage",
      duplicate: "DuplicateMaterialsObjectPage",
      unusual_setting: "UnusualSettingsObjectPage",
      supplier_planned_time: "SupplierPlannedTimesObjectPage",
      material_planned_time: "MaterialPlannedTimesObjectPage",
    };
    function root(control) {
      let current = control;
      while (
        current &&
        !(current.getId && current.getId().endsWith("approvalWorkspace"))
      )
        current = current.getParent();
      return current;
    }

    function ownerView(control) {
      let current = control;
      while (current && !(current.isA && current.isA("sap.ui.core.mvc.View")))
        current = current.getParent();
      return current;
    }

    function extensionAPI(control) {
      const current = ownerView(control);
      const controller =
        current && current.getController && current.getController();
      return controller && controller.getExtensionAPI
        ? controller.getExtensionAPI()
        : null;
    }

    function value(input, fallback) {
      return input === null || input === undefined || input === ""
        ? fallback || ""
        : String(input);
    }

    function formatDateTime(input) {
      return input ? dateTime.format(new Date(input)) : "Not available";
    }

    function formatDate(input) {
      if (!input) return "Not available";
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input));
      return match
        ? date.format(new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])))
        : String(input);
    }

    function objectText(objectKey) {
      const match = /^(\d+)\/(\d+)$/.exec(String(objectKey || ""));
      return match
        ? "Purchase order " + match[1] + ", item " + match[2]
        : value(objectKey, "Affected object not available");
    }

    function actionState(status, overdue) {
      if (status === "waiting" && overdue) return "Error";
      if (status === "needs_decision" || status === "waiting") return "Warning";
      return status === "resolved" ? "Success" : "None";
    }

    function actionStatus(status, overdue) {
      if (status === "waiting" && overdue) return "Follow-up Overdue";
      return (
        {
          needs_decision: "Needs Decision",
          waiting: "Waiting for Outcome",
          resolved: "Completed",
          declined: "Declined",
        }[status] || value(status)
      );
    }

    function actionIcon(status, overdue) {
      if (status === "waiting" && overdue) return "sap-icon://alert";
      if (status === "needs_decision") return "sap-icon://pending";
      if (status === "waiting") return "sap-icon://lateness";
      return status === "resolved"
        ? "sap-icon://status-positive"
        : "sap-icon://status-inactive";
    }

    function isDeliveryOperation(operationKey) {
      return /^delivery_/.test(operationKey || "");
    }

    function eventRow(row) {
      const isOverdue = row.event === "follow_up_overdue";
      return {
        when: formatDateTime(row.occurredAt),
        eventText: events[row.event] || value(row.event),
        actor: value(row.actor),
        note: value(row.note),
        hasActor: !!row.actor,
        hasNote: !!row.note,
        state: isOverdue
          ? "Error"
          : row.event === "resolved"
            ? "Success"
            : "Information",
        icon: isOverdue
          ? "sap-icon://alert"
          : row.event === "resolved"
            ? "sap-icon://status-positive"
            : "sap-icon://history",
      };
    }

    function requestObject(model, id) {
      const binding = model.bindContext(
        "/Cases('" + encodeURIComponent(id).replace(/'/g, "%27") + "')",
      );
      return binding.requestObject().finally(function () { binding.destroy(); });
    }

    async function requestRows(model, path, context, parameters) {
      const binding = model.bindList(path, context, null, null, parameters);
      const rows = [];
      try {
        while (true) {
          const page = await binding.requestContexts(rows.length, 100);
          rows.push(...page.map(function (entry) { return entry.getObject(); }));
          if (page.length < 100 || (binding.isLengthFinal() && rows.length >= binding.getLength()))
            return rows;
        }
      } finally {
        binding.destroy();
      }
    }

    function makeCase(model, link) {
      return requestObject(model, link.header_ID).then(function (caseRow) {
        const kind = caseRow && caseRow.kind;
        return {
          id: link.header_ID,
          kind: kind,
          title: (caseRow && caseRow.title) || "Affected case",
          subtitle: objectText(link.header_ID.replace(/^delivery:/, "")),
          attentionBucket: Attention.bucket(caseRow && caseRow.attention),
          attentionState: Attention.state(caseRow && caseRow.attention),
          attentionIcon: Attention.icon(caseRow && caseRow.attention),
          route: caseRoutes[kind],
          navigable: !!caseRoutes[kind],
        };
      });
    }

    const workspaces = new WeakMap();

    function load(box) {
      const view = ownerView(box);
      if (view) workspaces.set(view, box);
      const context = box.getBindingContext();
      let model = box.getModel("approval");
      if (!model) {
        model = new JSONModel({
          state: "loading",
          items: [],
          cases: [],
          events: [],
        });
        box.setModel(model, "approval");
      }
      if (view) view.setModel(model, "approval");
      if (!context) {
        model.setData({
          state: "loading",
          canDecide: false,
          canApprove: false,
          canLogOutcome: false,
        });
        return;
      }
      const path = context.getPath();
      if (
        box.data("approvalPath") === path &&
        model.getProperty("/state") === "loaded"
      )
        return;
      box.data("approvalPath", path);
      model.setData({ state: "loading", items: [], cases: [], events: [] });
      const serviceModel = context.getModel();
      const token = {};
      activeLoads.set(box, token);
      const isCurrent = function () {
        return activeLoads.get(box) === token && box.getBindingContext()?.getPath() === path;
      };
      const actionBinding = serviceModel.bindContext(path, null, { $select: "*" });
      return Promise.all([
        actionBinding.requestObject().finally(function () { actionBinding.destroy(); }),
        requestRows(serviceModel, "items", context, { $select: "*" }),
        requestRows(serviceModel, "actionEvents", context, { $select: "*", $orderby: "occurredAt desc" }),
        requestRows(serviceModel, "caseActions", context),
      ])
        .then(function (values) {
          return WorkflowPending.reconcile(
            box.getModel("workflow"),
            "action:" + values[0].ID,
            values[0].ID,
          ).then(function () {
            if (!isCurrent()) return;
            const action = values[0];
            const items = values[1].map(function (row) {
              const text = value(row.text);
              return {
                text: text,
                hasText: !!text,
                field: value(row.field),
                oldValue: value(row.oldValue),
                newValue: value(row.newValue),
                target: value(row.objectKey),
                hasChange: !!(row.field || row.oldValue || row.newValue),
              };
            });
            return Promise.all(
              values[3].map(function (row) {
                return makeCase(serviceModel, row);
              }),
            ).then(function (cases) {
              if (!isCurrent()) return;
              const isChange = items.some(function (item) {
                return item.hasChange;
              });
              const reviewCase = cases.find(function (entry) {
                return entry.navigable;
              });
              const deliveryRequest = isDeliveryOperation(action.operationKey);
              const summary = value(action.summary);
              const hasSupplierText = items.some(function (item) {
                return item.hasText;
              });
              const missingBusinessSummary = !summary;
              const incomplete =
                action.decisionReady === false || missingBusinessSummary;
              const blockReason = missingBusinessSummary
                ? "Approval blocked: business summary missing."
                : action.decisionBlockReason ||
                  "Approval blocked: decision context is incomplete.";
              model.setData({
                state: "loaded",
                id: action.ID,
                modifiedAt: action.modifiedAt,
                workflowPilot:
                  cases.length > 0 &&
                  cases.every(function (entry) {
                    return ["delivery", "price", "duplicate", "unusual_setting",
                      "supplier_planned_time", "material_planned_time", "requisition_review"].includes(entry.kind);
                  }),
                supplierPosting:
                  cases.length > 0 &&
                  cases.every(function (entry) {
                    return entry.kind === "supplier_planned_time";
                  }),
                title: action.title,
                requestType: value(
                  action.requestType,
                  requestTypes[action.operationKey] || "Other Prepared Request",
                ),
                operationText:
                  operations[action.operationKey] ||
                  value(action.operationKey, "Review prepared request"),
                operationKey: value(action.operationKey),
                objectText: objectText(action.objectKey),
                summary: summary,
                hasSummary: !!summary,
                missingBusinessSummary: missingBusinessSummary,
                incomplete: incomplete,
                blockReason: blockReason,
                status: actionStatus(action.status, action.overdue),
                statusState: actionState(action.status, action.overdue),
                statusIcon: actionIcon(action.status, action.overdue),
                expectedBy: formatDate(action.expectedBy),
                showExpectedBy: action.status === "waiting",
                canDecide: action.status === "needs_decision",
                canApprove: action.status === "needs_decision" && !incomplete,
                approveText: ["worklist", "price_check"].includes(action.kind)
                  ? "Complete Review"
                  : isChange && !deliveryRequest
                    ? "Approve Change"
                    : "Approve Follow-up",
                approveTooltip: incomplete ? blockReason : "Approve request",
                canLogOutcome: action.status === "waiting",
                hasDecision: !!action.decidedAt,
                decidedBy: value(action.decidedBy, "Not available"),
                decidedAt: formatDateTime(action.decidedAt),
                decisionNote: value(action.decisionNote),
                hasDecisionNote: !!action.decisionNote,
                hasOutcome: !!action.resolvedAt,
                outcome:
                  {
                    confirmed: "Supplier confirmed",
                    posted: "Posted outside this application",
                    resolved_elsewhere: "Resolved elsewhere",
                    escalated: "Escalated",
                  }[action.resolution] || value(action.resolution),
                resolvedBy: value(action.resolvedBy, "Not available"),
                resolvedAt: formatDateTime(action.resolvedAt),
                isDeliveryRequest: deliveryRequest,
                contentTitle: deliveryRequest
                  ? "Supplier Request"
                  : isChange
                    ? "Proposed Change"
                    : "Requested Follow-up",
                fieldLabel: deliveryRequest
                  ? "Required Delivery Date"
                  : "Field",
                oldValueLabel: deliveryRequest
                  ? "Required Delivery Date"
                  : "Current Value",
                newValueLabel: deliveryRequest
                  ? "Supplier Request"
                  : "Proposed Value",
                showField: !deliveryRequest,
                hasPreparedContent: hasSupplierText || isChange,
                hasEvents: values[2].length > 0,
                recipient: value(action.responsiblePerson),
                hasRecipient: !!action.responsiblePerson,
                hasProvenance: !!(
                  action.createdAt ||
                  action.createdBy ||
                  action.preparedVia
                ),
                hasSupplierText: hasSupplierText,
                items: items,
                cases: cases,
                hasCases: cases.length > 0,
                reviewCase: reviewCase || null,
                hasReviewCase: !!reviewCase,
                events: values[2].map(eventRow),
                preparedAt: formatDateTime(action.createdAt),
                preparedBy: value(action.createdBy, "Not available"),
                preparedVia:
                  {
                    app: "Buyer Cockpit",
                    chat: "Assistant",
                    feeder: "Automated preparation",
                    mcp: "Assistant",
                  }[action.preparedVia] ||
                  value(action.preparedVia, "Not available"),
                problemKey: value(action.problemKey),
                exportFormat:
                  action.exportFormat === "reminder"
                    ? "Reminder text"
                    : action.exportFormat === "csv"
                      ? "CSV"
                      : "Not available",
              });
            });
          });
        })
        .catch(function () {
          if (isCurrent())
            model.setData({ state: "error", items: [], cases: [], events: [],
              canApprove: false, canDecide: false, canLogOutcome: false });
        });
    }

    function workflowDecision(box, action, parameters) {
      const state = box.getModel("approval").getData();
      const commandType =
        action === "PurchasingDeskService.decide"
          ? "approveAction"
          : action === "PurchasingDeskService.decline"
            ? "declineAction"
            : state.supplierPosting ? "recordSupplierPosting" : "recordActionOutcome";
      const note =
        (parameters || []).find(function (entry) {
          return entry.name === "note";
        })?.value ?? null;
      const supplied = Object.fromEntries(
        (parameters || []).map(function (entry) {
          return [entry.name, entry.value];
        }),
      );
      return WorkflowPending.execute(
        box.getModel("workflow"), "action:" + state.id, state.id, commandType,
        { ...supplied, actionID: state.id, expectedModifiedAt: state.modifiedAt, note: note },
      );
    }

    function invoke(control, action, parameters) {
      const box = root(control);
      const context = box && box.getBindingContext();
      const api = extensionAPI(control);
      if (!context || !api) return Promise.resolve();
      const model = box.getModel("approval");
      if (model.getProperty("/busy")) return Promise.resolve();
      model.setProperty("/busy", true);
      const decision =
        model.getProperty("/workflowPilot") &&
        [
          "PurchasingDeskService.decide",
          "PurchasingDeskService.decline",
          "PurchasingDeskService.logOutcome",
        ].includes(action)
          ? workflowDecision(box, action, parameters)
          : context.requestProperty("modifiedAt").then(function (modifiedAt) {
              return api.editFlow.invokeAction(action, {
                model: context.getModel(),
                contexts: [context],
                parameterValues: [
                  { name: "expectedModifiedAt", value: modifiedAt },
                ].concat(parameters || []),
                skipParameterDialog: true,
              });
            });
      return decision
        .then(function () {
          context.getModel().refresh();
          api.refresh();
          box.data("approvalPath", null);
          load(box);
        })
        .finally(function () {
          model.setProperty("/busy", false);
        });
    }

    function decline(control) {
      const box = root(control);
      const bundle = box.getModel("i18nApprovals").getResourceBundle();
      const input = new Input({
        width: "100%",
        placeholder: bundle.getText("declineReason"),
      });
      const dialog = new Dialog({
        title: bundle.getText("decline"),
        contentWidth: "28rem",
        initialFocus: input,
        content: [
          new Label({ text: bundle.getText("declineReason"), labelFor: input }),
          input,
        ],
        beginButton: new Button({
          text: bundle.getText("decline"),
          type: "Reject",
          press: function () {
            const note = input.getValue().trim();
            if (!note) {
              input.setValueState("Error");
              input.setValueStateText(bundle.getText("declineReasonRequired"));
              input.focus();
              return;
            }
            dialog.close();
            invoke(control, "PurchasingDeskService.decline", [
              { name: "note", value: note },
            ]).catch(function (error) {
              MessageBox.error(error.message || String(error));
            });
          },
        }),
        endButton: new Button({
          text: bundle.getText("cancel"),
          press: function () {
            dialog.close();
          },
        }),
        afterClose: function () {
          dialog.destroy();
        },
      });
      dialog.addStyleClass("sapUiContentPadding");
      dialog.open();
    }

    function logOutcome(control) {
      const box = root(control);
      const bundle = box.getModel("i18nApprovals").getResourceBundle();
      const supplier = box.getModel("approval").getProperty("/supplierPosting");
      const canonical = box.getModel("approval").getProperty("/workflowPilot");
      const operation = box.getModel("approval").getProperty("/operationKey");
      const allowed = {
        delivery_intervention: ["confirmed", "resolved_elsewhere"],
        delivery_escalation: ["escalated", "resolved_elsewhere"],
        price_clarification: ["confirmed", "resolved_elsewhere"],
        master_data_duplicate_review: ["confirmed", "resolved_elsewhere"],
        planner_review: ["confirmed", "posted", "resolved_elsewhere"],
        pdt_change: ["posted", "resolved_elsewhere"],
        requisition_review: ["posted", "resolved_elsewhere"],
      };
      const resolutions = canonical ? allowed[operation] || [] :
        ["confirmed", "posted", "resolved_elsewhere", "escalated"];
      const resolutionLabels = {
        confirmed: "outcomeConfirmed", posted: "outcomePosted",
        resolved_elsewhere: "outcomeElsewhere", escalated: "outcomeEscalated",
      };
      const completeness = new Select({
        width: "100%", selectedKey: "unknown",
        items: ["unknown", "partial", "complete"].map(function (key) {
          return new Item({ key: key, text: bundle.getText({
            unknown: "outcomeUnknown", partial: "outcomePartial", complete: "outcomeComplete",
          }[key]) });
        }),
      });
      const outcome = new Select({
        width: "100%",
        selectedKey: supplier ? "unknown" : resolutions[0],
        items: supplier
          ? [
              new Item({
                key: "unknown",
                text: bundle.getText("postingUnknown"),
              }),
              new Item({
                key: "partial",
                text: bundle.getText("postingPartial"),
              }),
              new Item({
                key: "complete",
                text: bundle.getText("postingComplete"),
              }),
            ]
          : resolutions.map(function (key) {
              return new Item({ key: key, text: bundle.getText(resolutionLabels[key]) });
            }),
      });
      const note = new Input({
        width: "100%",
        placeholder: bundle.getText("outcomeNote"),
      });
      const dialog = new Dialog({
        title: bundle.getText("logOutcome"),
        contentWidth: "28rem",
        initialFocus: outcome,
        content: [
          new Label({ text: bundle.getText("outcome"), labelFor: outcome }),
          outcome,
          ...(canonical && !supplier ? [
            new Label({ text: bundle.getText("outcomeCompleteness"), labelFor: completeness })
              .addStyleClass("sapUiSmallMarginTop"),
            completeness,
          ] : []),
          new Label({
            text: bundle.getText("outcomeNote"),
            required: canonical,
            labelFor: note,
          }).addStyleClass("sapUiSmallMarginTop"),
          note,
        ],
        beginButton: new Button({
          text: bundle.getText("logOutcome"),
          type: "Emphasized",
          enabled: supplier || resolutions.length > 0,
          press: function () {
            const reason = note.getValue().trim();
            if (canonical && !reason) {
              note.setValueState("Error");
              note.setValueStateText(
                bundle.getText("postingReferenceRequired"),
              );
              note.focus();
              return;
            }
            const item = box.getModel("approval").getProperty("/items")[0];
            dialog.close();
            invoke(
              control,
              "PurchasingDeskService.logOutcome",
              supplier
                ? [
                    { name: "completeness", value: outcome.getSelectedKey() },
                    { name: "target", value: item.target },
                    { name: "field", value: item.field },
                    { name: "value", value: item.newValue },
                    { name: "note", value: reason },
                  ]
                : [
                    { name: "resolution", value: outcome.getSelectedKey() },
                  ...(canonical ? [{ name: "completeness", value: completeness.getSelectedKey() }] : []),
                    { name: "note", value: note.getValue().trim() || null },
                  ],
            ).catch(function (error) {
              MessageBox.error(error.message || String(error));
            });
          },
        }),
        endButton: new Button({
          text: bundle.getText("cancel"),
          press: function () {
            dialog.close();
          },
        }),
        afterClose: function () {
          dialog.destroy();
        },
      });
      dialog.addStyleClass("sapUiContentPadding");
      dialog.open();
    }

    return {
      forView: function (view) {
        return workspaces.get(view);
      },
      onContextChange: function (event) {
        load(event.getSource());
      },
      onRetry: function (event) {
        const box = root(event.getSource());
        box.data("approvalPath", null);
        load(box);
      },
      onApprove: function (event) {
        invoke(event.getSource(), "PurchasingDeskService.decide", [
          { name: "note", value: null },
        ]).catch(function (error) {
          MessageBox.error(error.message || String(error));
        });
      },
      onDecline: function (event) {
        decline(event.getSource());
      },
      onLogOutcome: function (event) {
        logOutcome(event.getSource());
      },
      onOpenCase: function (event) {
        const api = extensionAPI(event.getSource());
        const row = event.getSource().getBindingContext("approval").getObject();
        if (api && row.route)
          api.getRouting().navigateToRoute(row.route, { key: row.id });
      },
      onReviewCase: function (event) {
        const api = extensionAPI(event.getSource());
        const row = root(event.getSource())
          .getModel("approval")
          .getProperty("/reviewCase");
        if (api && row?.route)
          api.getRouting().navigateToRoute(row.route, { key: row.id });
      },
    };
  },
);
