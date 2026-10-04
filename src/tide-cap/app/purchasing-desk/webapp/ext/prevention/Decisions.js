sap.ui.define(
  [
    "sap/m/Dialog",
    "sap/m/VBox",
    "sap/m/Text",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/StepInput",
    "sap/m/TextArea",
    "sap/m/Button",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/Device",
    "tide/cockpit/ext/prevention/Workspace",
    "tide/cockpit/ext/shared/WorkflowPending",
  ],
  function (
    Dialog,
    VBox,
    Text,
    Label,
    Input,
    StepInput,
    TextArea,
    Button,
    MessageBox,
    MessageToast,
    Device,
    Workspace,
    WorkflowPending,
  ) {
    "use strict";

    const dialogs = new WeakMap();
    const pendingCommands = new WeakMap();

    function open(control, accepting) {
      const view = Workspace.viewOf(control);
      const model = view.getModel("prevention");
      const snapshot = { ...model.getData() };
      const context = control.getBindingContext() || view.getBindingContext();
      if (
        !context ||
        dialogs.has(view) ||
        !(accepting ? snapshot.canAccept : snapshot.canPrepare)
      )
        return;
      const price = snapshot.entity === "PriceDeviations";
      const supplier = snapshot.entity === "SupplierPlannedTimes";
      const caseID = snapshot.row.header_ID;
      const expectedModifiedAt = snapshot.row.header?.modifiedAt;
      const attempts = pendingCommands.get(view) || new Map();
      pendingCommands.set(view, attempts);
      const previous = attempts.get(context.getPath());
      if (previous && previous.accepting !== accepting) {
        MessageBox.error("The previous decision's outcome is still unknown.");
        return;
      }
      let attempt = previous;
      const title = accepting
        ? snapshot.config.alternative
        : snapshot.config.primary;
      const inputs = [];
      const content = [
        new Text({
          text: snapshot.row.caseTitle,
          wrapping: true,
        }).addStyleClass("sapUiSmallMarginBottom"),
        new Text({
          text: accepting
            ? snapshot.config.acceptance
            : snapshot.config.description,
          wrapping: true,
        }),
      ];
      if (!accepting && snapshot.change)
        content.push(
          new Text({
            text: "Planned time: " + snapshot.change,
            wrapping: true,
          }).addStyleClass("sapUiSmallMarginTop"),
        );
      if (!accepting && snapshot.entity === "DuplicateMaterials")
        content.push(
          new Text({
            text: "Candidate group: " + snapshot.row.materialNumbers,
            wrapping: true,
          }).addStyleClass("sapUiSmallMarginTop"),
        );
      if (!accepting && snapshot.entity === "SupplierPlannedTimes") {
        const duration = new StepInput({
          min: 1,
          max: 365,
          step: 1,
          displayValuePrecision: 0,
          width: "10rem",
          value:
            previous?.parameters.days ??
            snapshot.row.proposedDays ??
            snapshot.row.currentDays ??
            1,
        });
        content.push(
          new Label({
            text: view
              .getModel("i18n")
              .getResourceBundle()
              .getText("supplierSelectedDuration"),
            required: true,
            labelFor: duration,
          }).addStyleClass("sapUiMediumMarginTop"),
          duration,
        );
        inputs.push({ name: "days", control: duration, numeric: true });
      }
      if (!accepting && price) {
        const person = new Input({ width: "100%", maxLength: 120 });
        const message = new TextArea({
          width: "100%",
          rows: 3,
          growing: true,
          growingMaxLines: 6,
          maxLength: 500,
        });
        content.push(
          new Label({
            text: "Responsible person or purchasing group",
            required: true,
            labelFor: person,
          }).addStyleClass("sapUiMediumMarginTop"),
          person,
        );
        content.push(
          new Label({
            text: "Clarification needed",
            required: true,
            labelFor: message,
          }).addStyleClass("sapUiSmallMarginTop"),
          message,
        );
        inputs.push(
          { name: "responsiblePerson", control: person },
          { name: "responsibleMessage", control: message },
        );
      }
      if (accepting) {
        const reason = new TextArea({
          width: "100%",
          rows: 3,
          growing: true,
          growingMaxLines: 6,
          maxLength: 500,
          value: previous?.parameters.note || "",
          placeholder: snapshot.config.message,
        });
        content.push(
          new Label({
            text: "Business reason",
            required: true,
            labelFor: reason,
          }).addStyleClass("sapUiMediumMarginTop"),
          reason,
        );
        inputs.push({ name: "note", control: reason });
      }
      if (previous)
        inputs.forEach(function (input) {
          input.control.setEnabled(false);
        });
      const dialog = new Dialog({
        title: title,
        contentWidth: "34rem",
        stretch: Device.system.phone,
        content: [
          new VBox({ width: "100%", items: content }).addStyleClass(
            "tidePreventionDialog",
          ),
        ],
        beginButton: new Button({
          text: accepting ? "Accept Exception" : "Prepare for Review",
          type: "Emphasized",
          press: function () {
            const parameters = { expectedFingerprint: snapshot.fingerprint };
            let valid = true;
            inputs.forEach(function (input) {
              if (input.numeric) {
                const value = Number(input.control.getValue());
                const allowed =
                  Number.isInteger(value) &&
                  value >= 1 &&
                  value <= 365 &&
                  value !== Number(snapshot.row.currentDays);
                input.control.setValueState(allowed ? "None" : "Error");
                input.control.setValueStateText(
                  view
                    .getModel("i18n")
                    .getResourceBundle()
                    .getText("supplierDurationInvalid"),
                );
                if (!allowed) valid = false;
                parameters[input.name] = value;
                return;
              }
              const value = input.control.getValue().trim();
              input.control.setValueState(value ? "None" : "Error");
              input.control.setValueStateText("This field is required.");
              if (!value) valid = false;
              parameters[input.name] = value;
            });
            if (!valid || dialog.getBusy()) return;
            if (view.getBindingContext()?.getPath() !== context.getPath()) {
              dialog.close();
              return;
            }
            dialog.setBusy(true);
            model.setProperty("/busy", true);
            if (!attempt) {
              attempt = {
                accepting: accepting,
                parameters: {
                  ...parameters,
                  caseID: caseID,
                  expectedModifiedAt: expectedModifiedAt,
                },
              };
              attempts.set(context.getPath(), attempt);
              inputs.forEach(function (input) {
                input.control.setEnabled(false);
              });
            }
            const commandType = supplier ? (accepting
              ? "acceptSupplierPlannedTimeException" : "prepareSupplierPlannedTimeAction")
              : (accepting ? "acceptCaseException" : "prepareCaseAction");
            WorkflowPending.execute(view.getModel("workflow"), "case:" + caseID, caseID,
              commandType, attempt.parameters)
              .catch(function (error) {
                const status = Number(error.status ?? error.statusCode);
                if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
                  attempts.delete(context.getPath());
                  attempt = null;
                  inputs.forEach(function (input) {
                    input.control.setEnabled(true);
                  });
                }
                throw error;
              })
              .then(function () {
                attempts.delete(context.getPath());
                context.getModel().refresh();
                dialog.close();
                MessageToast.show(
                  accepting
                    ? "Exception accepted and decision recorded."
                    : "Review prepared in Approvals. No source data was changed.",
                );
                Workspace.reload(control).catch(function () {
                  MessageBox.warning(
                    "The decision was saved, but the page could not refresh. Reload before continuing.",
                  );
                });
              })
              .catch(function (error) {
                MessageBox.error(
                  error.message || "The decision could not be saved.",
                );
              })
              .finally(function () {
                model.setProperty("/busy", false);
                if (!dialog.isDestroyed()) dialog.setBusy(false);
              });
          },
        }),
        endButton: new Button({
          text: "Cancel",
          press: function () {
            if (!dialog.getBusy()) dialog.close();
          },
        }),
        afterClose: function () {
          dialogs.delete(view);
          dialog.destroy();
        },
      });
      dialogs.set(view, dialog);
      view.addDependent(dialog);
      if (inputs.length) dialog.setInitialFocus(inputs[0].control);
      dialog.open();
    }

    return {
      prepare: function (event) {
        open(event.getSource(), false);
      },
      accept: function (event) {
        open(event.getSource(), true);
      },
    };
  },
);
