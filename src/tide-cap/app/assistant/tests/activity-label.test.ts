import assert from "node:assert/strict";
import { test } from "node:test";
import { activityHeader } from "../src/activity-label";
import type { AssistantActivity } from "../src/AssistantController";

function activity(overrides: Partial<AssistantActivity> = {}): AssistantActivity {
  return {
    id: "call-1",
    turnId: "turn-1",
    order: 1,
    tool: "get_case",
    state: "complete",
    text: "",
    time: 0,
    ...overrides,
  };
}

test("tool labels are the tool name in words with the call state", () => {
  assert.equal(activityHeader(activity()), "get case · Complete");
  assert.equal(
    activityHeader(activity({ tool: "predict_orders", state: "started" })),
    "predict orders · In progress",
  );
});
