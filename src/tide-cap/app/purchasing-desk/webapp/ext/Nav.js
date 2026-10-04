sap.ui.define(
  ["tide/cockpit/ext/findingLink", "tide/cockpit/ext/guard/UserMenu"],
  function (findingLink, UserMenu) {
    "use strict";

    /** Header navigation between the cockpit pages (called with this = FE extension API). */
    function go(api, route, query) {
      api
        .getRouting()
        .navigateToRoute(route, query ? { "?query": query } : undefined);
    }

    return {
      overview: function () {
        go(this, "MorningBrief");
      },
      worklist: function () {
        go(this, "DeliveryRisksList");
      },
      findings: function () {
        go(this, "DeliveryRisksList");
      },
      /** Free-text requests with a review lifecycle. */
      requests: function () {
        go(this, "RequestsList");
      },
      /** Prevention and data-quality cases: price, duplicate, rare, and lead-time findings. */
      prevention: function () {
        go(this, "PreventionList");
      },
      simulation: function (query) {
        go(this, "Simulation", query);
      },
      howItWorks: function () {
        go(this, "HowItWorks");
      },
      approvals: function () {
        go(this, "ActionsList");
      },
      proof: function () {
        go(this, "Proof");
      },
      /** Opens a finding's object page by ID (hash in FE's own key form). */
      openFinding: function (id) {
        if (id) {
          window.location.hash = findingLink.findingHash(id);
        }
      },
      /** User menu slot: ext/guard/UserMenu.js (owner guard) renders it when present. */
      userMenu: function (context, selected) {
        const api = this;
        const source = arguments.length > 2 ? arguments[2] : undefined;
        if (UserMenu && typeof UserMenu.open === "function") {
          UserMenu.open(api, source, context, selected);
        }
      },
    };
  },
);
