sap.ui.define(
  [
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/List",
    "sap/m/StandardListItem",
    "sap/m/VBox",
    "sap/m/Text",
    "sap/m/Title",
    "sap/m/ObjectStatus",
    "sap/m/MessageToast",
    "sap/m/ActionSheet",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/resource/ResourceModel",
  ],
  function (
    Dialog,
    Button,
    List,
    StandardListItem,
    VBox,
    Text,
    Title,
    ObjectStatus,
    MessageToast,
    ActionSheet,
    JSONModel,
    ResourceModel,
  ) {
    "use strict";

    /**
     * Header user menu (slot of ext/Nav.js, owner guard): who is signed in,
     * the buyer switch and the About dialog. Mocked users only: a buyer is
     * user "buyer<purchasing group>" with the same password. Switching sends
     * one request with the new credentials (the browser keeps them for the
     * realm) and reloads the app.
     */
    const SERVICE = "/odata/v4/desk/";
    const bundle = new ResourceModel({
      bundleName: "tide.cockpit.ext.guard.i18n",
      supportedLocales: [""],
      fallbackLocale: "",
    }).getResourceBundle();
    const t = (k, a) => bundle.getText(k, a);

    function get(path, user) {
      return new Promise(function (resolve, reject) {
        const xhr = new XMLHttpRequest();
        if (user)
          xhr.open(
            "GET",
            SERVICE + path,
            true,
            user,
            user === "ilyesse.hettenbach@cbs-consulting.de" ? "alice" : user,
          );
        else xhr.open("GET", SERVICE + path, true);
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300)
            resolve(JSON.parse(xhr.responseText || "{}"));
          else reject(new Error(String(xhr.status)));
        };
        xhr.onerror = reject;
        xhr.send();
      });
    }

    function switchTo(userId) {
      get("me()", userId)
        .then(function () {
          window.location.reload();
        })
        .catch(function () {
          MessageToast.show(t("switchFailed"));
        });
    }

    function buyersDialog(me) {
      const model = new JSONModel({ buyers: [] });
      const dialog = new Dialog({
        title: t("switchTitle"),
        contentWidth: "24rem",
        content: [
          new List({
            id: "guardBuyerList",
            items: {
              path: "/buyers",
              template: new StandardListItem({
                title: "{name}",
                description: {
                  parts: ["PurchasingGroup", "Plant"],
                  formatter: function (g, p) {
                    return t("buyerScope", [g, p || t("allPlants")]);
                  },
                },
                type: "Active",
                press: function (e) {
                  const b = e.getSource().getBindingContext().getObject();
                  dialog.close();
                  switchTo(b.userId);
                },
              }),
            },
          }),
        ],
        endButton: new Button({
          text: t("close"),
          press: () => dialog.close(),
        }),
        afterClose: () => dialog.destroy(),
      });
      dialog.setModel(model);
      get("Buyers?$orderby=PurchasingGroup").then(function (r) {
        const list = (r.value || []).slice();
        if (me && me.isAdmin === false)
          list.unshift({
            userId: "ilyesse.hettenbach@cbs-consulting.de",
            name: t("allBuyers"),
            PurchasingGroup: "–",
            Plant: null,
          });
        model.setProperty("/buyers", list);
      });
      dialog.open();
    }

    function about(me) {
      const line = (label, value) =>
        new Text({
          text: label + ": " + (value == null || value === "" ? "–" : value),
        });
      const dialog = new Dialog({
        title: t("aboutTitle"),
        contentWidth: "30rem",
        content: [
          new VBox({
            items: [
              new Title({ text: t("aboutWhat"), level: "H3" }),
              new Text({ text: t("aboutText") }),
              new Title({ text: t("aboutSources"), level: "H3" }).addStyleClass(
                "sapUiSmallMarginTop",
              ),
              new Text({ text: t("aboutSourcesText") }),
              new Title({ text: t("aboutData"), level: "H3" }).addStyleClass(
                "sapUiSmallMarginTop",
              ),
              line(t("dataset"), me.datasetName),
              line(t("asOf"), me.asOf),
              line(t("prepared"), me.preparedAt),
              line(t("snapshot"), me.snapshotId),
              line(t("model"), me.backend),
              new Title({ text: t("aboutNever"), level: "H3" }).addStyleClass(
                "sapUiSmallMarginTop",
              ),
              new Text({ text: t("aboutNeverText") }),
            ],
          }).addStyleClass("sapUiSmallMargin"),
        ],
        endButton: new Button({
          text: t("close"),
          press: () => dialog.close(),
        }),
        afterClose: () => dialog.destroy(),
      });
      dialog.open();
    }

    return {
      open: function (_api, source) {
        get("me()")
          .then(function (me) {
            const who = me.isAdmin
              ? t("allBuyers")
              : t("buyerScope", [
                  me.PurchasingGroup,
                  me.Plant || t("allPlants"),
                ]);
            const sheet = new ActionSheet({
              id: "guardUserMenu",
              title: me.name,
              showCancelButton: true,
              buttons: [
                new Button({ text: me.name + " · " + who, enabled: false }),
                ...(me.mockAuthentication === true
                  ? [
                      new Button({
                        id: "guardSwitchBuyer",
                        text: t("switch"),
                        icon: "sap-icon://switch-views",
                        press: () => buyersDialog(me),
                      }),
                    ]
                  : []),
                new Button({
                  id: "guardAbout",
                  text: t("about"),
                  icon: "sap-icon://hint",
                  press: () => about(me),
                }),
              ],
              afterClose: () => sheet.destroy(),
            });
            if (source) sheet.openBy(source);
            else sheet.openBy(document.body);
          })
          .catch(function () {
            MessageToast.show(t("meFailed"));
          });
      },
    };
  },
);
