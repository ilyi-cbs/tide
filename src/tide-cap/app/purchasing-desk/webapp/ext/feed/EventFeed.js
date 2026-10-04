sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Component",
    "sap/ui/core/format/DateFormat",
    "sap/base/i18n/ResourceBundle",
    "sap/base/Log",
    "tide/cockpit/ext/findingLink",
  ],
  function (
    JSONModel,
    Component,
    DateFormat,
    ResourceBundle,
    Log,
    findingLink,
  ) {
    "use strict";

    /** Rows shown; the "new" marker lasts NEW_MS; stored state is polled every POLL_MS. */
    const TOP = 50;
    const NEW_MS = 8000;
    const POLL_MS = 5000;
    // Buyer words of the Source enum (contract section 2).
    const SOURCE_WORDS = {
      rule: "Check",
      lookup: "Master data",
      empirical: "Past deliveries",
      tabpfn: "AI estimate",
      calculation: "Calculated",
      confirmation: "Supplier confirmation",
      fallback: "Past deliveries",
    };
    const TIME = DateFormat.getTimeInstance({ pattern: "HH:mm", UTC: true });

    /** Events seen in this page session: the marker shows once per event and page load. */
    const seen = new Set();

    function bundle() {
      return ResourceBundle.create({
        bundleName: "tide.cockpit.ext.feed.i18n",
        supportedLocales: [""],
        fallbackLocale: "",
        async: true,
      });
    }

    function meta(e) {
      const parts = [];
      const t = e.simTime || e.at;
      if (t) {
        parts.push(TIME.format(new Date(t)));
      }
      if (SOURCE_WORDS[e.source]) {
        parts.push(SOURCE_WORDS[e.source]);
      }
      return parts.join(" · ");
    }

    /** Polling state of one fragment instance (keyed by its panel). */
    function Feed(panel, texts) {
      this.panel = panel;
      this.texts = texts;
      this.lastSeq = 0;
      this.first = true;
      this.events = [];
      this.newUntil = new Map();
      this.model = new JSONModel({
        events: [],
        header: "",
        noData: texts.getText("feedNoData"),
        newText: texts.getText("feedNew"),
      });
      panel.setModel(this.model, "eventFeed");
      this.render();
    }

    Feed.prototype.render = function () {
      const now = Date.now();
      this.newUntil.forEach(function (until, seq, map) {
        if (until <= now) {
          map.delete(seq);
        }
      });
      const rows = this.events.map(function (e) {
        return Object.assign({}, e, {
          meta: meta(e),
          isNew: (this.newUntil.get(e.seq) || 0) > now,
        });
      }, this);
      this.model.setProperty("/events", rows);
      this.model.setProperty(
        "/header",
        this.texts.getText("feedHeader", [rows.length]),
      );
    };

    /** Reads events with seq > last seen (delta polling by sequence). */
    Feed.prototype.poll = function () {
      const odata = this.panel.getModel();
      if (this.panel.isDestroyed() || !odata || !odata.bindList || this.busy) {
        return Promise.resolve();
      }
      this.busy = true;
      const list = odata.bindList("/Events", null, null, null, {
        $filter: "seq gt " + this.lastSeq,
        $orderby: "seq desc",
        $select: "seq,at,simTime,kind,title,findingID,objectKey,source,status",
      });
      return list
        .requestContexts(0, TOP)
        .then(
          function (contexts) {
            if (this.panel.isDestroyed()) return;
            const fresh = contexts.map(function (c) {
              return c.getObject();
            });
            if (fresh.length) {
              const now = Date.now();
              fresh.forEach(function (e) {
                const recent = e.at && now - Date.parse(e.at) < NEW_MS;
                if (!seen.has(e.seq) && (!this.first || recent)) {
                  this.newUntil.set(e.seq, now + NEW_MS);
                }
                seen.add(e.seq);
              }, this);
              this.lastSeq = Math.max(this.lastSeq, fresh[0].seq);
              this.events = fresh.concat(this.events).slice(0, TOP);
            }
            this.first = false;
            this.render();
          }.bind(this),
        )
        .catch(function (error) {
          Log.warning(
            "event feed: " + error,
            undefined,
            "tide.cockpit.ext.feed",
          );
        })
        .finally(
          function () {
            this.busy = false;
            list.destroy();
          }.bind(this),
        );
    };

    Feed.prototype.start = function () {
      if (this.timer) {
        return;
      }
      this.poll();
      this.timer = setInterval(
        function () {
          if (this.panel.isDestroyed()) {
            this.stop();
            return;
          }
          const dom = this.panel.getDomRef();
          if (document.hidden || (dom && !dom.offsetParent)) {
            return;
          }
          // Re-render as well, so markers fade without new events.
          this.poll().then(this.render.bind(this));
        }.bind(this),
        POLL_MS,
      );
      // Markers end on time even between polls.
      this.fader = setInterval(
        function () {
          if (this.panel.isDestroyed()) {
            this.stop();
            return;
          }
          if (this.newUntil.size) {
            this.render();
          }
        }.bind(this),
        1000,
      );
    };

    Feed.prototype.stop = function () {
      clearInterval(this.timer);
      clearInterval(this.fader);
      this.timer = null;
    };

    const feeds = new WeakMap();

    function feedOf(panel) {
      return feeds.get(panel);
    }

    return {
      TOP: TOP,
      NEW_MS: NEW_MS,
      meta: meta,

      /** Starts polling once the default (OData) model reaches the panel. */
      onModelContextChange: function (event) {
        const panel = event.getSource();
        if (
          feeds.has(panel) ||
          !panel.getModel() ||
          !panel.getModel().bindList
        ) {
          return;
        }
        feeds.set(panel, null);
        bundle().then(function (texts) {
          if (panel.isDestroyed()) return;
          const feed = new Feed(panel, texts);
          feeds.set(panel, feed);
          // The poll timer stops itself once the panel is destroyed.
          feed.start();
        });
      },

      /** Opens the finding of the event (FE object page route Findings({key})). */
      onItemPress: function (event) {
        const item = event.getParameter("listItem");
        const ctx = item && item.getBindingContext("eventFeed");
        const id = ctx && ctx.getProperty("findingID");
        if (!id) {
          return;
        }
        // Same hash form as FE's own navigation (ext/findingLink).
        window.location.hash = findingLink.findingHash(id);
      },

      /** Forces a poll; exposed for tests. */
      refresh: function (panel) {
        const feed = feedOf(panel);
        return feed ? feed.poll() : Promise.resolve();
      },
    };
  },
);
