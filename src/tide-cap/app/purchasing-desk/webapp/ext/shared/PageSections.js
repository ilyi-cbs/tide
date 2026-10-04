sap.ui.define([], function () {
  "use strict";

  // Sections that reload from the object page binding; matched by binding path.
  const sections = new Map();

  return {
    register: function (box, reload) {
      sections.set(box, reload);
    },
    refresh: function (path) {
      sections.forEach(function (reload, box) {
        if (box.isDestroyed()) sections.delete(box);
        else if (box.getBindingContext()?.getPath() === path) reload();
      });
    },
  };
});
