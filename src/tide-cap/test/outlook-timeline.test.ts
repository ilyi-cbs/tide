import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const outlook = {
  markers: [{ kind: "ordered", date: "2026-10-04" }],
  requiredDate: "2026-10-05",
  asOf: "2026-10-05",
  plannedDays: 3,
  mostLikelyDate: "2026-10-17",
  earliestCredibleDate: "2026-10-13",
  lateRiskDate: "2026-11-06",
  forecastKind: "empirical",
};
test("the controller uses container width and today's date without refetching on resize", async () => {
  let width = 900;
  let requests = 0;
  let resize = () => {};
  let afterRendering = () => {};
  let beforeRendering = () => {};
  let destroyed = 0;
  let chartWidth = 0;
  let chartOutlook: Record<string, unknown> = {};
  let controller: {
    onContextChange: (event: { getSource: () => unknown }) => void;
  };
  let rendered: Record<string, unknown> = {};
  let loaded = () => {};
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const model = {
    setData: (value: Record<string, unknown>) => {
      rendered = value;
      loaded();
    },
    setProperty: (path: string, value: string) => {
      rendered[path.slice(1)] = value;
    },
  };
  const context = {
    getPath: () => "/forecast-width-check",
    requestProperty: () => Promise.resolve(),
    getModel: () => backend,
  };
  const backend = {
    bindContext: () => ({
      invoke: () => {
        requests += 1;
        return Promise.resolve();
      },
      getBoundContext: () => ({
        requestObject: () =>
          Promise.resolve({
            ...outlook,
            forecastKind: "tabpfn",
            scenarios: [],
          }),
      }),
    }),
  };
  const metadata = new Map<string, unknown>();
  const box = {
    getBindingContext: () => context,
    getModel: (name: string) =>
      name === "i18nOutlook"
        ? {
            getResourceBundle: () => ({
              getText: (key: string) =>
                key === "aiProvenance" ? "Source: TabPFN by PriorLabs" : key,
            }),
          }
        : model,
    data: (name: string, value?: unknown) =>
      value === undefined ? metadata.get(name) : metadata.set(name, value),
    getDomRef: () => ({ querySelector: () => ({ clientWidth: width }) }),
    isDestroyed: () => false,
    addEventDelegate: (delegate: {
      onBeforeRendering: () => void;
      onAfterRendering: () => void;
    }) => {
      beforeRendering = delegate.onBeforeRendering;
      afterRendering = delegate.onAfterRendering;
    },
  };
  class Clock extends Date {
    constructor(value?: number) {
      super(value ?? Date.UTC(2027, 2, 12, 12));
    }
  }
  runInNewContext(
    readFileSync("app/purchasing-desk/webapp/ext/outlook/Outlook.js", "utf8"),
    {
      Date: Clock,
      sap: {
        ui: {
          define: (
            dependencies: string[],
            factory: (...modules: unknown[]) => typeof controller,
          ) => {
            controller = factory(
              ...dependencies.map((name) => {
                if (name.endsWith("/HighchartsPreview"))
                  return {
                    render: (_host: unknown, data: Record<string, unknown>) => {
                      chartWidth = width;
                      chartOutlook = data;
                      return {
                        reflow: () => {
                          chartWidth = width;
                        },
                        destroy: () => {
                          destroyed += 1;
                        },
                      };
                    },
                  };
                if (name.endsWith("/DateFormat"))
                  return {
                    getDateInstance: () => ({
                      format: (date: Date) => date.toISOString().slice(0, 10),
                    }),
                  };
                if (name.endsWith("/NumberFormat"))
                  return {
                    getPercentInstance: () => ({
                      format: (value: number) => value * 100 + "%",
                    }),
                  };
                if (name.endsWith("/ResizeHandler"))
                  return {
                    register: (_control: unknown, handler: () => void) => {
                      resize = handler;
                    },
                  };
                if (name.endsWith("/PageSections"))
                  return { register: () => {}, refresh: () => {} };
                return {};
              }),
            );
          },
        },
      },
    },
  );
  controller!.onContextChange({ getSource: () => box });
  await ready;
  assert.equal(rendered.provenanceText, "Source: TabPFN by PriorLabs");
  assert.equal(rendered.svg, undefined);
  assert.equal(rendered.hasTimeline, true);
  assert.equal(chartWidth, 900);
  assert.equal(chartOutlook.today, "2027-03-12");
  width = 350;
  resize();
  assert.equal(chartWidth, 350);
  width = 640;
  beforeRendering();
  afterRendering();
  assert.equal(chartWidth, 640);
  assert.equal(destroyed, 1);
  assert.equal(requests, 1);
});

test("delivery forecast uses one Highcharts host without a duplicate SVG or preview", () => {
  const fragment = readFileSync(
    "app/purchasing-desk/webapp/ext/finding/DeliveryStory.fragment.xml",
    "utf8",
  );
  assert.equal((fragment.match(/tideForecastChartHost/g) || []).length, 1);
  assert.doesNotMatch(
    fragment,
    /out>\/svg|HighchartsPreview|highchartsPreviewTitle|highchartsPreviewNote/,
  );
  assert.match(fragment, /visible="\{out>\/hasTimeline\}"/);
});
