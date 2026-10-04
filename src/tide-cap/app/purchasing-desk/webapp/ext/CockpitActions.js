sap.ui.define(
  [
    "sap/m/Button",
    "sap/m/Dialog",
    "sap/m/Input",
    "sap/m/TextArea",
    "sap/m/Label",
    "sap/m/VBox",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "tide/cockpit/ext/shared/WorkflowPending",
  ],
  function (
    Button,
    Dialog,
    Input,
    TextArea,
    Label,
    VBox,
    MessageToast,
    MessageBox,
    WorkflowPending,
  ) {
    "use strict";

    /**
     * Custom actions of the cockpit (manifest "actions"). Called with
     * `this` = FE extension API; args: (bindingContext, selectedContexts).
     */

    function text(api, key) {
      return api.getModel("i18n").getResourceBundle().getText(key);
    }

    function approvalText(api, key, args) {
      return api
        .getModel("i18nApprovals")
        .getResourceBundle()
        .getText(key, args);
    }

    function selectedNeedsDecision(api, contexts) {
      const selected = contexts || [];
      const eligible = selected.filter(function (context) {
        return context.getProperty("status") === "needs_decision";
      });
      if (!eligible.length) {
        MessageToast.show(approvalText(api, "onlyNeedsDecision"));
        return null;
      }
      return { eligible: eligible, skipped: selected.length - eligible.length };
    }

    function runForSelected(api, contexts, action, note, skipped) {
      const completed = [];
      const failed = [];
      const selection = contexts.map(function (context) {
        return {
          context: context,
          actionID: context.getProperty("ID"),
          expectedModifiedAt: context.getProperty("modifiedAt"),
        };
      });
      return selection
        .reduce(function (chain, selected) {
          const context = selected.context;
          return chain.then(function () {
            return WorkflowPending.execute(
              api.getModel("workflow"),
              "action:" + selected.actionID,
              selected.actionID,
              action === "decide" ? "approveAction" : "declineAction",
              {
                actionID: selected.actionID,
                expectedModifiedAt: selected.expectedModifiedAt,
                note: note ?? null,
              },
            )
              .then(function (result) {
                if (
                  action === "decide"
                    ? !["waiting", "resolved"].includes(result.status)
                    : result.status !== "declined"
                )
                  throw new Error(
                    "The previous decision was recovered. Reload before making a different decision.",
                  );
                completed.push(context);
              })
              .catch(function (error) {
                failed.push({
                  title:
                    context.getProperty("title") ||
                    context.getProperty("objectKey") ||
                    context.getProperty("ID"),
                  message: error && error.message,
                });
              });
          });
        }, Promise.resolve())
        .then(function () {
          api.getModel().refresh();
          api.refresh();
          if (failed.length || skipped) {
            const details = failed
              .map(function (failure) {
                return (
                  failure.title +
                  (failure.message ? ": " + failure.message : "")
                );
              })
              .join("\n");
            MessageBox.warning(
              approvalText(api, "approvalPartialFailure", [
                completed.length,
                failed.length,
                skipped || 0,
              ]),
              {
                details: details || undefined,
              },
            );
          } else {
            MessageToast.show(
              approvalText(
                api,
                action === "decide" ? "approvalCompleted" : "declineCompleted",
                [completed.length],
              ),
            );
          }
        });
    }

    function declineDialog(api, contexts) {
      const input = new Input({
        width: "100%",
        placeholder: approvalText(api, "declineReason"),
      });
      const dialog = new Dialog({
        title: approvalText(api, "declineSelectedTitle"),
        contentWidth: "28rem",
        content: [
          new Label({
            text: approvalText(api, "declineSelectedMessage"),
            labelFor: input,
          }),
          input,
        ],
        beginButton: new Button({
          text: approvalText(api, "decline"),
          type: "Reject",
          press: function () {
            const note = input.getValue().trim();
            if (!note) {
              input.setValueState("Error");
              input.setValueStateText(
                approvalText(api, "declineReasonRequired"),
              );
              input.focus();
              return;
            }
            dialog.close();
            runForSelected(
              api,
              contexts.eligible,
              "decline",
              note,
              contexts.skipped,
            );
          },
        }),
        endButton: new Button({
          text: approvalText(api, "cancel"),
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

    /** Opens a fresh assistant conversation with the item as page context. */
    function ask(api, context, question) {
      const assistant = document.querySelector("tide-assistant");
      if (!assistant) {
        MessageToast.show(text(api, "assistantMissing"));
        return;
      }
      const pageContext = {
        title: "Buyer cockpit",
        itemIDs: [
          context.getProperty("PurchaseOrder") +
            "/" +
            context.getProperty("PurchaseOrderItem"),
        ],
      };
      if (assistant.openAssistant.length >= 2) {
        assistant.openAssistant(pageContext, {
          message: question,
          newConversation: true,
          contextScope: "once",
        });
      } else {
        assistant.openAssistant(pageContext);
      }
    }

    function preventionContext(context) {
      const values = {};
      [
        "caseID",
        "caseTitle",
        "Material",
        "Plant",
        "Supplier",
        "PurchasingGroup",
        "PurchaseOrder",
        "PurchaseOrderItem",
        "unitPrice",
        "priorMedian",
        "factor",
        "priorCount",
        "currentDays",
        "proposedDays",
        "p50",
        "difference",
        "tolerance",
        "candidateCount",
        "groupSize",
        "unusualPairCount",
      ].forEach(function (name) {
        const value = context.getProperty(name);
        if (value !== null && value !== undefined && value !== "")
          values[name] = value;
      });
      return values;
    }

    // XML fragment press handlers receive an event, while FE manifest
    // actions receive a binding context. Support both entry points.
    function bindingContext(value) {
      return value && typeof value.getProperty === "function"
        ? value
        : value && typeof value.getSource === "function"
          ? value.getSource().getBindingContext()
          : null;
    }

    function preventionQuestion(context) {
      const kind = String(context.getProperty("caseID") || "").split(":", 1)[0];
      const questions = {
        price:
          "Read the current typed case first. Why was this price anomaly detected? Explain the current price, comparable history, deviation, and recommended next step.",
        duplicate:
          "Read the current typed case first. Why are these materials considered possible duplicates? Summarize the matching evidence and recommended review.",
        unusual_setting:
          "Read the current typed case first. Why is this planning setting unusual? Compare it with the peer group and explain the recommended review.",
        supplier_planned_time:
          "Read the current typed case first. Why is this supplier planned-time change proposed? Explain the delivery evidence and recommendation.",
        material_planned_time:
          "Read the current typed case first. Why is this material planned-time change proposed? Explain the source evidence, tolerance, and recommended action.",
      };
      return (
        questions[kind] ||
        "Why is this prevention case listed? Explain the evidence and recommended next step."
      );
    }

    function invokeBoundAction(api, context, name, parameters) {
      const caseID =
        context.getProperty("caseID") || context.getProperty("header_ID");
      return WorkflowPending.execute(
        api.getModel("workflow"),
        "case:" + caseID,
        caseID,
        name,
        Object.assign({ caseID: caseID }, parameters),
      ).then(function (result) {
        if (
          result.caseID !== caseID ||
          (result.commandType && result.commandType !== name)
        )
          throw new Error(
            "A previous command was recovered. Reload before preparing another decision.",
          );
        if (name === "prepareCaseAction" && !result.actionID)
          throw new Error(
            "The previous decision was recovered. Reload before preparing an approval.",
          );
        // Refresh is deliberately not awaited. FE may wait for the page
        // binding that this action has just invalidated; the dialog must
        // close once the server confirms that the action was prepared.
        context.getModel().refresh();
        api.refresh();
        return result;
      });
    }

    function responsibleDialog(api, context, expectedFingerprint) {
      const expectedModifiedAt =
        context.getProperty("caseUpdatedAt") ||
        context.getProperty("header/modifiedAt");
      const person = new Input({
        width: "100%",
        placeholder: "Buyer, purchasing group, or responsible role",
      });
      const message = new TextArea({
        width: "100%",
        rows: 3,
        growing: true,
        growingMaxLines: 5,
        placeholder: "What needs to be clarified?",
      });
      const dialog = new Dialog({
        title: "Ask Responsible Person",
        contentWidth: "32rem",
        initialFocus: person,
        content: [
          new VBox({
            width: "100%",
            items: [
              new Label({ text: "Responsible person", labelFor: person }),
              person,
              new Label({
                text: "Clarification needed",
                labelFor: message,
                class: "sapUiMediumMarginTop",
              }),
              message,
            ],
          }),
        ],
        beginButton: new Button({
          text: "Prepare Clarification",
          type: "Emphasized",
          press: function () {
            const responsiblePerson = person.getValue().trim();
            const responsibleMessage = message.getValue().trim();
            if (!responsiblePerson || !responsibleMessage) {
              if (!responsiblePerson) person.setValueState("Error");
              if (!responsibleMessage) message.setValueState("Error");
              return;
            }
            dialog.setBusy(true);
            invokeBoundAction(api, context, "prepareCaseAction", {
              responsiblePerson: responsiblePerson,
              responsibleMessage: responsibleMessage,
              expectedModifiedAt: expectedModifiedAt,
              expectedFingerprint: expectedFingerprint,
            })
              .then(function () {
                dialog.close();
                MessageToast.show("Clarification prepared in Approvals.");
              })
              .catch(function (error) {
                MessageBox.error(
                  error.message || "The clarification could not be prepared.",
                );
              })
              .finally(function () {
                dialog.setBusy(false);
              });
          },
        }),
        endButton: new Button({
          text: "Cancel",
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

    function exceptionDialog(api, context, expectedFingerprint) {
      const expectedModifiedAt =
        context.getProperty("caseUpdatedAt") ||
        context.getProperty("header/modifiedAt");
      const note = new TextArea({
        width: "100%",
        rows: 3,
        growing: true,
        growingMaxLines: 5,
        placeholder: "Why is this price justified?",
      });
      const dialog = new Dialog({
        title: "Accept Price as Justified",
        contentWidth: "32rem",
        initialFocus: note,
        content: [
          new VBox({
            width: "100%",
            items: [
              new Label({ text: "Business reason", labelFor: note }),
              note,
            ],
          }),
        ],
        beginButton: new Button({
          text: "Accept Exception",
          type: "Reject",
          press: function () {
            const value = note.getValue().trim();
            if (!value) {
              note.setValueState("Error");
              return;
            }
            dialog.setBusy(true);
            invokeBoundAction(api, context, "acceptCaseException", {
              note: value,
              expectedModifiedAt: expectedModifiedAt,
              expectedFingerprint: expectedFingerprint,
            })
              .then(function () {
                dialog.close();
                MessageToast.show("Price exception accepted.");
              })
              .catch(function (error) {
                MessageBox.error(
                  error.message || "The exception could not be accepted.",
                );
              })
              .finally(function () {
                dialog.setBusy(false);
              });
          },
        }),
        endButton: new Button({
          text: "Cancel",
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
      /** "Why?" on a finding starts a fresh conversation with a seeded question. */
      whyFinding: function (context) {
        const assistant = document.querySelector("tide-assistant");
        if (!assistant) {
          MessageToast.show(text(this, "assistantMissing"));
          return;
        }
        const po = context.getProperty("PurchaseOrder");
        const caseID =
          context.getProperty("caseID") || context.getProperty("header_ID");
        const label =
          context.getProperty("caseTitle") ||
          context.getProperty("itemTitle") ||
          context.getProperty("objectKey") ||
          (po
            ? "PO " + po + "/" + context.getProperty("PurchaseOrderItem")
            : "Delivery risk");
        const pageContext = {
          title: "Buyer cockpit",
          findingID: context.getProperty("ID") || undefined,
          caseID: caseID || undefined,
          findingLabel: label,
        };
        if (po) {
          pageContext.itemIDs = [
            po + "/" + context.getProperty("PurchaseOrderItem"),
          ];
        }
        assistant.openAssistant(pageContext, {
          message: "Why is " + label + " listed and what should I do?",
          newConversation: true,
          contextScope: "once",
        });
      },

      askTideForPrevention: function (context) {
        const assistant = document.querySelector("tide-assistant");
        if (!assistant) {
          MessageToast.show(text(this, "assistantMissing"));
          return;
        }
        const details = preventionContext(context);
        assistant.openAssistant(
          {
            title: "Buyer cockpit",
            caseID: details.caseID,
            findingLabel:
              context.getProperty("caseTitle") ||
              context.getProperty("Material") ||
              "Prevention case",
            prevention: details,
          },
          {
            message: preventionQuestion(context),
            newConversation: true,
            contextScope: "once",
          },
        );
      },

      askResponsible: function (context) {
        const binding = bindingContext(context);
        if (!binding) {
          MessageBox.error(
            "The current prevention case is no longer available. Refresh the page and try again.",
          );
          return;
        }
        const api = this;
        return binding
          .requestProperty("header/sourceFingerprint")
          .then(function (fingerprint) {
            responsibleDialog(api, binding, fingerprint);
          });
      },

      acceptPriceException: function (context) {
        const binding = bindingContext(context);
        if (!binding) {
          MessageBox.error(
            "The current prevention case is no longer available. Refresh the page and try again.",
          );
          return;
        }
        const api = this;
        return binding
          .requestProperty("header/sourceFingerprint")
          .then(function (fingerprint) {
            exceptionDialog(api, binding, fingerprint);
          });
      },

      /**
       * Simulate Delivery uses impact need date, then requested date.
       * Without either, the service defaults to as-of + 56.
       */
      simulateFinding: function (context) {
        const api = this;
        const query = {};
        ["Material", "Plant", "Supplier"].forEach(function (name) {
          const value = context.getProperty(name);
          if (value) {
            query[name] = value;
          }
        });
        const late = function (path) {
          return context.requestProperty(path).catch(function () {
            return null;
          });
        };
        const hasItem = !!context.getProperty("PurchaseOrder");
        return Promise.all([
          hasItem ? late("impact/needDate") : null,
          hasItem ? late("dueDate") : null,
        ]).then(function (dates) {
          const phase =
            context.getProperty("phase") || context.getProperty("list");
          const due =
            phase === "at_risk" || phase === "overdue"
              ? context.getProperty("dueDate")
              : null;
          const needDate = dates[0] || dates[1] || due;
          if (needDate) {
            query.needDate = needDate;
          }
          api.getRouting().navigateToRoute("Simulation", { "?query": query });
        });
      },

      /** Prepares a finding's next step; all decisions happen in Approvals. */
      addToApprovals: function (context) {
        const api = this;
        const caseID =
          context.getProperty("caseID") || context.getProperty("header_ID");
        const reviewed = {
          caseID: caseID,
          expectedModifiedAt:
            context.getProperty("caseUpdatedAt") ||
            context.getProperty("header/modifiedAt"),
          expectedFingerprint:
            context.getProperty("sourceFingerprint") ||
            context.getProperty("header/sourceFingerprint"),
        };
        return new Promise(function (resolve, reject) {
          MessageBox.confirm(approvalText(api, "prepareApprovalMessage"), {
            title: approvalText(api, "prepareApprovalTitle"),
            actions: [
              approvalText(api, "prepareApproval"),
              approvalText(api, "cancel"),
            ],
            emphasizedAction: approvalText(api, "prepareApproval"),
            onClose: function (action) {
              if (action !== approvalText(api, "prepareApproval")) {
                resolve();
                return;
              }
              WorkflowPending.execute(
                api.getModel("workflow"),
                "case:" + caseID,
                caseID,
                "prepareCaseAction",
                reviewed,
              )
                .then(function (result) {
                  if (!result.actionID)
                    throw new Error(
                      "The previous decision was recovered. Reload before preparing an approval.",
                    );
                  MessageToast.show(approvalText(api, "addedToApprovals"));
                  api.getModel().refresh();
                  api.refresh();
                  resolve();
                })
                .catch(reject);
            },
          });
        });
      },

      /** Opens the active approval already associated with this finding. */
      openActiveApproval: function (context) {
        const api = this;
        return context.requestObject("activeAction").then(function (action) {
          if (action && action.ID) {
            api
              .getRouting()
              .navigateToRoute("ActionsObjectPage", { key: action.ID });
          }
        });
      },

      approveSelected: function (context, selectedContexts) {
        const api = this;
        const selection = selectedNeedsDecision(api, selectedContexts);
        if (!selection) return Promise.resolve();
        return new Promise(function (resolve) {
          MessageBox.confirm(approvalText(api, "approveSelectedMessage"), {
            title: approvalText(api, "approveSelectedTitle"),
            actions: [
              approvalText(api, "approve"),
              approvalText(api, "cancel"),
            ],
            emphasizedAction: approvalText(api, "approve"),
            onClose: function (action) {
              resolve(
                action === approvalText(api, "approve")
                  ? runForSelected(
                      api,
                      selection.eligible,
                      "decide",
                      undefined,
                      selection.skipped,
                    )
                  : undefined,
              );
            },
          });
        });
      },

      declineSelected: function (context, selectedContexts) {
        const selection = selectedNeedsDecision(this, selectedContexts);
        if (!selection) return Promise.resolve();
        declineDialog(this, selection);
        return Promise.resolve();
      },

      isApproved: function (context) {
        const status = context && context.getProperty("status");
        return status === "waiting" || status === "resolved";
      },
    };
  },
);
