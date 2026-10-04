sap.ui.define(
  ["sap/m/MessageToast", "sap/m/MessageBox", "tide/cockpit/ext/findingLink"],
  function (MessageToast, MessageBox, findingLink) {
    "use strict";

    function invoke(api, context, action) {
      return api.editFlow
        .invokeAction(action, {
          model: api.getModel(),
          contexts: [context],
          parameterValues: [],
          skipParameterDialog: true,
        })
        .then(function (result) {
          context.getModel().refresh();
          api.refresh();
          return result;
        });
    }

    function text(api, key) {
      return api.getModel("i18nFreetext").getResourceBundle().getText(key);
    }

    return {
      openSourceFinding: function (context) {
        if (context && context.getProperty("findingID")) {
          window.location.hash = findingLink.findingHash(
            context.getProperty("findingID"),
          );
        }
      },
      openApproval: function (context) {
        if (context && context.getProperty("actionID"))
          window.location.hash =
            "#/Actions('" +
            encodeURIComponent(context.getProperty("actionID")) +
            "')";
      },
      submitForApproval: function (context) {
        if (!context || context.getProperty("IsActiveEntity") === false) {
          MessageBox.information(text(this, "saveReviewFirst"));
          return Promise.resolve();
        }
        return invoke(this, context, "PurchasingDeskService.submitForApproval")
          .then((approval) => {
            if (!approval) {
              throw new Error(text(this, "approvalNotCreated"));
            }
            MessageToast.show(text(this, "reviewSubmitted"));
          })
          .catch((error) => MessageBox.error(error.message || String(error)));
      },
      validateReview: function (context) {
        if (!context || context.getProperty("IsActiveEntity") === false) {
          MessageBox.information(text(this, "saveReviewFirst"));
          return Promise.resolve();
        }
        return invoke(this, context, "PurchasingDeskService.validateReview")
          .then(() => {
            MessageBox.information(text(this, "validationPassed"));
          })
          .catch((error) => MessageBox.error(error.message || String(error)));
      },
      submitReview: function (context) {
        if (!context || context.getProperty("IsActiveEntity") === false) {
          MessageBox.information(text(this, "saveReviewFirst"));
          return Promise.resolve();
        }
        return invoke(this, context, "PurchasingDeskService.submitReview")
          .then(() => {
            MessageToast.show(text(this, "reviewSubmitted"));
          })
          .catch((error) => MessageBox.error(error.message || String(error)));
      },
      suggestSupplier: function (context) {
        if (!context) return Promise.resolve();
        return invoke(this, context, "PurchasingDeskService.suggestSupplier")
          .then(() => {
            MessageToast.show(text(this, "supplierSuggested"));
          })
          .catch((error) => MessageBox.error(error.message || String(error)));
      },
      confirmCurrentValues: function (context) {
        if (!context) return Promise.resolve();
        return invoke(this, context, "PurchasingDeskService.confirmCurrentValues")
          .then(() => {
            MessageToast.show(text(this, "suggestionsConfirmed"));
          })
          .catch((error) => MessageBox.error(error.message || String(error)));
      },
      reconcileSource: function (context) {
        if (!context) return Promise.resolve();
        return invoke(this, context, "PurchasingDeskService.reconcileSource")
          .then(() => {
            MessageToast.show(text(this, "sourceReconciled"));
          })
          .catch((error) => MessageBox.error(error.message || String(error)));
      },
    };
  },
);
