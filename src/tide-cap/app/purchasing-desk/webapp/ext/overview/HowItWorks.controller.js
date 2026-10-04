sap.ui.define(
    [
        "sap/fe/core/PageController",
        "sap/ui/model/json/JSONModel",
        "sap/ui/model/resource/ResourceModel",
        "tide/cockpit/ext/overview/openList",
    ],
    function (PageController, JSONModel, ResourceModel, openList) {
        "use strict";

        // list key, i18n prefix; texts only, nothing is read from the server.
        const LISTS = [
            ["at_risk", "hiwAtRisk"],
            ["overdue", "hiwOverdue"],
            ["price", "hiwPrice"],
            ["pdt", "hiwPdt"],
            ["mm_pdt", "hiwMmPdt"],
            ["freetext", "hiwFreetext"],
            ["duplicate", "hiwDuplicate"],
            ["rare", "hiwRare"],
        ];
        const SOURCES = [
            ["srcCheck", "srcCheckTip", "Information"],
            ["srcMaster", "srcMasterTip", "None"],
            ["srcPast", "srcPastTip", "Success"],
            ["srcAi", "srcAiTip", "Indication06"],
            ["srcCalc", "srcCalcTip", "Indication07"],
            ["srcConf", "srcConfTip", "Indication08"],
        ];

        return PageController.extend("tide.cockpit.ext.overview.HowItWorks", {
            onInit: function () {
                PageController.prototype.onInit.apply(this, arguments);
                this.getView().setModel(new JSONModel({ lists: [], sources: [] }), "hiw");
            },

            onBeforeRendering: function () {
                if (this._filled) return;
                this._filled = true;
                const view = this.getView();
                let model = view.getModel("i18nOverview") || this.getAppComponent().getModel("i18nOverview");
                if (!model) {
                    model = new ResourceModel({ bundleName: "tide.cockpit.ext.overview.i18n", async: true });
                    view.setModel(model, "i18nOverview");
                }
                Promise.resolve(model.getResourceBundle()).then(function (b) {
                    view.getModel("hiw").setData({
                        lists: LISTS.map(function (l) {
                            return {
                                key: l[0],
                                name: b.getText(l[1]),
                                check: b.getText(l[1] + "Check"),
                                result: b.getText(l[1] + "Result"),
                                next: b.getText(l[1] + "Next"),
                            };
                        }),
                        sources: SOURCES.map(function (s) {
                            return { word: b.getText(s[0]), tip: b.getText(s[1]), state: s[2] };
                        }),
                    });
                });
            },

            onOpenList: function (event) {
                const list = event.getSource().getBindingContext("hiw").getProperty("key");
                openList(this.getAppComponent().getRouter(), list);
            },

            onOpenOverview: function () {
                this.getAppComponent().getRouter().navTo("MorningBrief");
            },
        });
    },
);
