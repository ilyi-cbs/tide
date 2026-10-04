import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiContext,
  defaultPageContext,
  promptsForContext,
} from "../src/context";

test("API context strips display-only and unknown fields and bounds selection", () => {
  const context = apiContext({
    version: 1,
    app: "cockpit",
    surface: "cockpit.open-item",
    title: "Visible label only",
    itemIDs: Array.from({ length: 22 }, (_, index) => `4500000001/${index}`),
    prompt: "untrusted override",
    extra: "discard",
  });

  assert.deepEqual(context, {
    version: 1,
    app: "cockpit",
    surface: "cockpit.open-item",
    entity: { kind: "purchase-order-item", id: "4500000001/0" },
    selection: {
      itemIds: Array.from({ length: 20 }, (_, index) => `4500000001/${index}`),
    },
  });
});

test("unsupported surfaces do not cross the agent boundary and templates vary by surface", () => {
  assert.equal(
    apiContext({
      version: 1,
      app: "cockpit",
      surface: "cockpit.untrusted",
    } as never),
    null,
  );
  assert.match(
    promptsForContext({
      version: 1,
      app: "cockpit",
      surface: "cockpit.prevention-case",
    })[0].prompt,
    /case/,
  );
  assert.notEqual(
    promptsForContext({
      version: 1,
      app: "cockpit",
      surface: "cockpit.prevention-case",
    })[0].prompt,
    promptsForContext({
      version: 1,
      app: "cockpit",
      surface: "cockpit.overview",
    })[0].prompt,
  );
});

test("only the cockpit gets a default context", () => {
  assert.equal(defaultPageContext("cockpit")?.surface, "cockpit.overview");
  assert.equal(defaultPageContext("lead-time"), null);
  assert.equal(defaultPageContext("tabpfn-playground"), null);
  assert.equal(defaultPageContext("unknown"), null);
});
