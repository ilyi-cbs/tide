sap.ui.define(
  [
    "sap/ui/core/Component",
    "sap/m/HBox",
    "sap/m/VBox",
    "sap/m/Title",
    "sap/m/Text",
    "sap/m/Button",
    "sap/m/MessageBox",
  ],
  function (Component, HBox, VBox, Title, Text, Button, MessageBox) {
    "use strict";

    const contexts = new WeakMap();

    function pageView(control) {
      let parent = control;
      while (parent && !parent.isA("sap.ui.core.mvc.View"))
        parent = parent.getParent();
      return parent;
    }

    function invoke(view, definition, context) {
      const controller = view.getController();
      const api = controller.getExtensionAPI();
      if (definition.action) {
        const invokeAction = function (parameters) {
          return api.editFlow
            .invokeAction(definition.action, {
              model: context.getModel(),
              contexts: [context],
              parameterValues: parameters,
            })
            .then(function (result) {
              context.getModel().refresh();
              api.refresh();
              return result;
            });
        };
        if (
          definition.action.endsWith("acceptException") ||
          definition.action.endsWith("prepareAction")
        ) {
          return context
            .requestProperty("header/sourceFingerprint")
            .then(function (fingerprint) {
              return invokeAction([
                { name: "expectedFingerprint", value: fingerprint },
              ]);
            });
        }
        return invokeAction([]);
      }
      if (definition.press.startsWith(".extension.")) {
        const parts = definition.press.slice(1).split(".");
        const method = parts.pop();
        const owner = parts.reduce(function (value, key) {
          return value[key];
        }, controller);
        return owner[method](context);
      }
      const separator = definition.press.lastIndexOf(".");
      const module = definition.press.slice(0, separator).replace(/\./g, "/");
      const method = definition.press.slice(separator + 1);
      return new Promise(function (resolve, reject) {
        sap.ui.require(
          [module],
          function (handlers) {
            Promise.resolve()
              .then(function () {
                return handlers[method].call(api, context, []);
              })
              .then(resolve, reject);
          },
          reject,
        );
      });
    }

    function command(view, box, definition) {
      const button = new Button(box.getId() + "--" + definition.id, {
        text: definition.text,
        icon: definition.icon || "",
        tooltip: definition.tooltip || definition.text,
        type: definition.type || "Default",
        visible: definition.visible === undefined ? true : definition.visible,
        enabled: definition.enabled === undefined ? true : definition.enabled,
        press: function () {
          const context = button.getBindingContext();
          if (!context || button.getBusy()) return;
          button.setBusy(true);
          Promise.resolve()
            .then(function () {
              return invoke(view, definition, context);
            })
            .catch(function (error) {
              MessageBox.error(error.message || String(error));
            })
            .finally(function () {
              if (!button.isDestroyed()) button.setBusy(false);
            });
        },
      });
      return button;
    }

    function row(view, box, definition) {
      const text = new VBox({
        items: [
          new Title({
            text: definition.title || definition.text,
            level: "H4",
            wrapping: true,
          }),
        ],
      });
      if (definition.description) {
        text.addItem(
          new Text({
            text: definition.description,
            wrapping: true,
          }).addStyleClass("sapUiTinyMarginTop"),
        );
      }
      return new HBox({
        width: "100%",
        justifyContent: "SpaceBetween",
        alignItems: "Center",
        wrap: "Wrap",
        visible: definition.visible === undefined ? true : definition.visible,
        items: [text, command(view, box, definition)],
      }).addStyleClass("tideActionRow");
    }

    return {
      onToolbarContextChange: function (event) {
        const toolbar = event.getSource();
        const context = toolbar.getBindingContext();
        if (contexts.has(toolbar) && contexts.get(toolbar) === context) return;
        contexts.set(toolbar, context);
        toolbar.destroyContent();
        if (!context) return;
        const view = pageView(toolbar);
        if (!view) return;
        const component = Component.getOwnerComponentFor(view);
        const app = component.getAppComponent
          ? component.getAppComponent()
          : component;
        const registry = app.getManifestEntry("tide.actions") || {};
        const icons = {
          reviewOrder: "task",
          downloadOrderDraft: "download",
          downloadReviewCsv: "download",
          reconcileSource: "synchronize",
          openApproval: "navigation-right-arrow",
        };
        (registry.PurchaseRequisitionReviews || []).forEach(
          function (definition) {
            toolbar.addContent(
              command(
                view,
                toolbar,
                Object.assign({}, definition, {
                  icon: definition.icon || icons[definition.id] || "",
                }),
              ),
            );
          },
        );
      },
      onContextChange: function (event) {
        const box = event.getSource();
        const context = box.getBindingContext();
        if (contexts.has(box) && contexts.get(box) === context) return;
        contexts.set(box, context);
        box.destroyItems();
        if (!context) return;
        const view = pageView(box);
        if (!view) return;
        const component = Component.getOwnerComponentFor(view);
        const app = component.getAppComponent
          ? component.getAppComponent()
          : component;
        const registry = app.getManifestEntry("tide.actions") || {};
        const entity = context.getPath().split("/")[1].split("(")[0];
        (registry[entity] || []).forEach(function (definition) {
          box.addItem(row(view, box, definition));
        });
      },
    };
  },
);
