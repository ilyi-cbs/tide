sap.ui.define([], function () {
  "use strict";

  /** Extract a row index from a JSONModel list-binding path for sparkline x values. */
  function indexOf(modelName) {
    const context = this.getBindingContext(modelName);
    if (!context) {
      return 0;
    }
    const path = context.getPath();
    const tail = path.slice(path.lastIndexOf("/") + 1);
    const index = parseInt(tail, 10);
    return Number.isNaN(index) ? 0 : index;
  }

  return {
    /** Bind as formatter: '.formatter.ovIndex' from a control inside a list bound to the "ov" model. */
    ovIndex: function () {
      return indexOf.call(this, "ov");
    },

    /** Hide the sparkline unless every point is finite; expression bindings cannot call this predicate. */
    trendHasData: function (trend) {
      return (
        Array.isArray(trend) &&
        trend.length > 0 &&
        trend.every(function (p) {
          return (
            p &&
            typeof p.revenueAtRisk === "number" &&
            isFinite(p.revenueAtRisk)
          );
        })
      );
    },
  };
});
