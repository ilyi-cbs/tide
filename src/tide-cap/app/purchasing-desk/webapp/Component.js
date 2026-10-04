sap.ui.define(
  [
    "sap/fe/core/AppComponent",
    "sap/f/ShellBar",
    "tide/cockpit/ext/shared/WorkflowPending",
  ],
  function (AppComponent, ShellBar, WorkflowPending) {
    "use strict";

    return AppComponent.extend("tide.cockpit.Component", {
      metadata: {
        manifest: "json",
      },

      /**
       * Disable app-state handling in standalone mode because the FE navigation
       * mock lacks inner-state storage.
       */
      initializeFeatureToggles: function () {
        if (!sap.ui.require("sap/ushell/Container")) {
          this.getEnvironmentCapabilities().setCapability("AppState", false);
        }
        return AppComponent.prototype.initializeFeatureToggles.apply(
          this,
          arguments,
        );
      },

      init: function () {
        const identity = fetch("/odata/v4/desk/me()", {
          credentials: "same-origin",
        }).then(function (response) {
          return response.ok ? response.json() : null;
        });
        WorkflowPending.initialize(
          identity.then(function (me) {
            return { userId: me?.userId, origin: window.location.origin };
          }),
        );
        AppComponent.prototype.init.apply(this, arguments);
        const appComponent = this;
        const shellBar = new ShellBar({
          title: "TIDE",
          homeIcon: "images/cbs-logo.png",
          homeIconTooltip: "CBS",
          homeIconPressed: function () {
            appComponent.getRouter().navTo("Home");
          },
          showNavButton: true,
          navButtonPressed: function () {
            window.history.back();
          },
        }).addStyleClass("tideShellBar");
        const assistant = document.querySelector("tide-assistant");
        if (assistant) {
          // Chat goes to the same origin (CAP proxy /agent/*, attribute in
          // index.html); the browser's CAP session authenticates it.
          // Dev override for a separately running agent:
          // index.html?agentUrl=http://localhost:8281 — only then, and only on a
          // local host, the mocked CAP user is sent as a token.
          const agentUrl = new URLSearchParams(window.location.search).get(
            "agentUrl",
          );
          const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
            window.location.hostname,
          );
          if (local && agentUrl) {
            try {
              const target = new URL(agentUrl);
              if (
                /^https?:$/.test(target.protocol) &&
                /^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname) &&
                !target.username &&
                !target.password
              ) {
                assistant.setAttribute("agent-url", target.href);
              }
            } catch (e) {
              // Ignore malformed development overrides.
            }
          }
          identity
            .then(function (me) {
              if (!me || !me.userId) return;
              assistant.userId = me.userId;
              if (local && me.mockAuthentication === true)
                assistant.authToken =
                  "Basic " +
                  btoa(
                    me.userId +
                      ":" +
                      (me.userId === "ilyesse.hettenbach@cbs-consulting.de"
                        ? "alice"
                        : me.userId),
                  );
            })
            .catch(function () {
              /* Normal sign-in remains available. */
            });
          // Stable page context follows UI5 route changes while ChatUI is open.
          const surfaces = {
            MorningBrief: "cockpit.overview",
            Home: "cockpit.delivery-risk-list",
            FindingsList: "cockpit.delivery-risk-list",
            DeliveryRisksList: "cockpit.delivery-risk-list",
            DeliveryRiskCaseObjectPage: "cockpit.delivery-risk-detail",
            PreventionList: "cockpit.prevention-list",
            PriceDeviationObjectPage: "cockpit.prevention-case",
            DuplicateMaterialsObjectPage: "cockpit.prevention-case",
            UnusualSettingsObjectPage: "cockpit.prevention-case",
            SupplierPlannedTimesObjectPage: "cockpit.prevention-case",
            MaterialPlannedTimesObjectPage: "cockpit.prevention-case",
            ActionsList: "cockpit.approvals",
            ActionsObjectPage: "cockpit.approvals",
            QuestionsObjectPage: "cockpit.approvals",
            RequestsList: "cockpit.requests",
            RequestsObjectPage: "cockpit.requests",
            Simulation: "cockpit.planning",
            Planning: "cockpit.planning",
            Proof: "cockpit.proof",
            HowItWorks: "cockpit.help",
          };
          let listeners = [];
          function decodeKey(key) {
            let value = String(key || "");
            for (let pass = 0; pass < 2; pass++) {
              try {
                const decoded = decodeURIComponent(value);
                if (decoded === value) break;
                value = decoded;
              } catch (e) {
                break; /* Preserve malformed keys without throwing. */
              }
            }
            return value;
          }
          function contextForRoute(routeName, args) {
            const surface = surfaces[routeName] || "cockpit.overview";
            const context = {
              version: 1,
              app: "cockpit",
              surface: surface,
              title: routeName || "Buyer cockpit",
            };
            const key = args && args.key;
            if (routeName === "DeliveryRiskCaseObjectPage" && key) {
              const value = decodeKey(key);
              const match = /'((?:''|[^'])*)'/.exec(value);
              const id = match
                ? match[1].replace(/''/g, "'")
                : value.replace(/^\(|\)$/g, "");
              if (id) context.entity = { kind: "case", id: id };
            } else if (routeName === "RequestsObjectPage" && key) {
              const value = decodeKey(key);
              const requisition = /PurchaseRequisition='((?:''|[^'])*)'/.exec(
                value,
              );
              const item = /PurchaseRequisitionItem='((?:''|[^'])*)'/.exec(
                value,
              );
              if (requisition && item)
                context.entity = {
                  kind: "case",
                  id:
                    "requisition:" +
                    requisition[1].replace(/''/g, "'") +
                    "/" +
                    item[1].replace(/''/g, "'"),
                };
            } else if (
              /^(PriceDeviation|DuplicateMaterials|UnusualSettings|SupplierPlannedTimes|MaterialPlannedTimes)ObjectPage$/.test(
                routeName || "",
              ) &&
              key
            ) {
              const value = decodeKey(key);
              const id = /'((?:''|[^'])*)'/.exec(value);
              if (id)
                context.entity = {
                  kind: "case",
                  id: id[1].replace(/''/g, "'"),
                };
            }
            return context;
          }
          let currentContext = contextForRoute("Home", {});
          assistant.contextProvider = {
            getContext: function () {
              return currentContext;
            },
            subscribe: function (listener) {
              listeners.push(listener);
              return function () {
                listeners = listeners.filter(function (item) {
                  return item !== listener;
                });
              };
            },
          };
          const router = this.getRouter();
          this._assistantRouteHandler = function (event) {
            currentContext = contextForRoute(
              event.getParameter("name"),
              event.getParameter("arguments"),
            );
            listeners.slice().forEach(function (listener) {
              listener();
            });
          };
          router.attachRouteMatched(this._assistantRouteHandler);
          this._assistant = assistant;
          this._assistantChangeHandler = function (event) {
            const result = event.detail && event.detail.summary;
            // Read-only tools return no case/action identity.
            if (!result || (!result.caseID && !result.actionID)) return;
            const root =
              appComponent.getRootControl && appComponent.getRootControl();
            const container = root && root.byId && root.byId("appContent");
            const page =
              container &&
              container.getCurrentPage &&
              container.getCurrentPage();
            const component =
              page && page.getComponentInstance && page.getComponentInstance();
            const view =
              component &&
              component.getRootControl &&
              component.getRootControl();
            const controller =
              view && view.getController && view.getController();
            const api =
              controller &&
              controller.getExtensionAPI &&
              controller.getExtensionAPI();
            if (api && typeof api.refresh === "function") api.refresh();
          };
          assistant.addEventListener(
            "tide:assistant-data-changed",
            this._assistantChangeHandler,
          );
        }
        if (document.getElementById("shellbar")) shellBar.placeAt("shellbar");
        this._shellBar = shellBar;
      },

      exit: function () {
        if (this._assistantRouteHandler && this.getRouter())
          this.getRouter().detachRouteMatched(this._assistantRouteHandler);
        if (this._assistant && this._assistantChangeHandler)
          this._assistant.removeEventListener(
            "tide:assistant-data-changed",
            this._assistantChangeHandler,
          );
        if (this._shellBar) this._shellBar.destroy();
        if (AppComponent.prototype.exit)
          AppComponent.prototype.exit.apply(this, arguments);
      },
    });
  },
);
