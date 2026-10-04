import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const root = (process.argv[2] || "http://localhost:4404").replace(/\/$/, "");
const screenshots = process.env.ASSISTANT_SCREENSHOTS || "/tmp/tide-assistant-recovery";
const context = await browser.newContext({
  httpCredentials: { username: "buyerD01", password: "buyerD01" },
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
let liveCalls = 0;
page.on("request", (request) => {
  if (request.url().endsWith("/agent") && !request.url().includes("/__agent_test/")) liveCalls++;
});
let posts = 0;
let note = "";
let savedMessages = [];
await page.route("**/__agent_test/**", async (route) => {
  const request = route.request();
  if (request.url().endsWith("/healthz")) return route.fulfill({ json: { status: "ok" } });
  if (request.url().endsWith("/title")) return route.fulfill({ json: { title: "Recovery test" } });
  if (request.url().includes("/threads/")) return route.fulfill({ json: {
    messages: savedMessages, pending_interrupt: false, interrupt: null,
  } });
  assert.ok(request.url().endsWith("/agent"), request.url());
  posts++;
  const body = request.postDataJSON();
  savedMessages = [...(body.messages || []), {
    id: "answer", role: "assistant", content: `All done.\n\n${note}`,
  }];
  const events = [
    { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "All done." },
    { type: "TEXT_MESSAGE_END", messageId: "answer" },
    { type: "CUSTOM", name: "tide.turn", value: { messageId: "answer", append: note } },
    { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
  ];
  await route.fulfill({ contentType: "text/event-stream", body: events.map(event =>
    `data: ${JSON.stringify(event)}\n\n`).join("") });
});

try {
  await page.goto(`${root}/tide.cockpit/index.html`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForFunction(() => !!customElements.get("tide-assistant"));
  const lifecycle = await page.evaluate(() => {
    const host = document.createElement("tide-assistant");
    const first = new Set();
    const second = new Set();
    const provider = (listeners) => ({
      getContext: () => ({ version: 1, app: "cockpit", surface: "cockpit.overview", title: "Test" }),
      subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    });
    host.contextProvider = provider(first);
    host.setAttribute("app-id", "cockpit");
    host.hidden = true;
    document.body.append(host);
    const mounted = first.size;
    host.contextProvider = provider(second);
    const replaced = [first.size, second.size];
    host.remove();
    const disconnected = second.size;
    document.body.append(host);
    const remounted = second.size;
    host.setAttribute("user-id", "assistant-lifecycle-test");
    const changed = second.size;
    host.remove();
    return { mounted, replaced, disconnected, remounted, changed, final: second.size };
  });
  assert.deepEqual(lifecycle, { mounted: 1, replaced: [0, 1], disconnected: 0, remounted: 1, changed: 1, final: 0 });

  for (const status of ["pending", "unknown"]) {
    await page.setViewportSize(status === "pending"
      ? { width: 1440, height: 1000 }
      : { width: 390, height: 844 });
    note = `Verification: outcome ${status}; do not claim successful completion.`;
    savedMessages = [];
    const user = `assistant-recovery-${status}-${Date.now()}`;
    await page.evaluate(({ root, user }) => {
      const host = document.createElement("tide-assistant");
      host.id = "recovery-host";
      host.setAttribute("app-id", "cockpit");
      host.setAttribute("user-id", user);
      host.setAttribute("agent-url", `${root}/__agent_test`);
      document.body.append(host);
      host.openAssistant();
    }, { root, user });
    await page.waitForFunction(() => document.querySelector("#recovery-host").controller.snapshot.connected);
    const before = posts;
    await page.evaluate(() => {
      const host = document.querySelector("#recovery-host");
      host.remove();
      document.body.append(host);
      host.openAssistant();
    });
    await page.waitForFunction(() => document.querySelector("#recovery-host").controller.snapshot.connected);
    await page.evaluate(() => {
      const input = document.querySelector("#recovery-host ui5-textarea");
      input.value = "check the outcome";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await page.waitForFunction((note) => document.querySelector("#recovery-host .assistantMessages").textContent.includes(note), note);
    assert.equal(posts, before + 1);
    const layout = await page.evaluate(() => {
      const host = document.querySelector("#recovery-host");
      const panel = host.querySelector(".assistantPanel").getBoundingClientRect();
      const messages = host.querySelector(".assistantMessages");
      return { left: panel.left, right: panel.right, width: innerWidth,
        content: messages.scrollWidth, available: messages.clientWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.content <= layout.available + 1, JSON.stringify(layout));
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: `${screenshots}/${status}.png`, fullPage: true });
    await page.evaluate(() => document.querySelector("#recovery-host").closeAssistant());
    await page.evaluate(() => document.querySelector("#recovery-host").openAssistant());
    await page.waitForFunction((note) => {
      const host = document.querySelector("#recovery-host");
      return host.controller.snapshot.connected && host.querySelector(".assistantMessages").textContent.includes(note);
    }, note);
    assert.equal(posts, before + 1);
    await page.evaluate(() => document.querySelector("#recovery-host").remove());
  }
  assert.equal(liveCalls, 0);
  console.log("PASS: shipped assistant lifecycle, single-send remount, pending/unknown SSE and reconnect history; zero live agent calls.");
} finally {
  await browser.close();
}