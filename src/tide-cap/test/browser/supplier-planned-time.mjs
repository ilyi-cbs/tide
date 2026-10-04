import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  httpCredentials: {
    username: "ilyesse.hettenbach@cbs-consulting.de",
    password: "alice",
  },
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(25000);
const errors = [];
const commands = [];
const decisions = [];
let discardedResponse = false;
let receiptRequests = 0;
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes("/workflow/commandResult")) receiptRequests += 1;
  if (
    request.method() === "POST" &&
    request.url().includes("/workflow/prepareSupplierPlannedTimeAction")
  )
    commands.push(request.postDataJSON());
  if (
    request.method() === "POST" &&
    request.url().includes("/workflow/approveAction")
  )
    decisions.push(request.postDataJSON());
});
const [root, caseID] = process.argv.slice(2);
const key = encodeURIComponent(encodeURIComponent(caseID));
const screenshots = "/tmp/tide-supplier-pilot";

try {
  await mkdir(screenshots, { recursive: true });
  await page.route(/\/odata\/v4\/workflow\/commandResult/, (route) =>
    route.abort("failed"),
  );
  await page.route(
    /\/odata\/v4\/workflow\/prepareSupplierPlannedTimeAction(?:\?|$)/,
    async (route) => {
      const committed = await route.fetch();
      assert.equal(committed.status(), 200, await committed.text());
      discardedResponse = true;
      await route.abort("failed");
    },
  );
  await page.goto(
    `${root}/tide.cockpit/index.html?sap-ui-xx-viewCache=false#/Prevention`,
    { waitUntil: "networkidle", timeout: 90000 },
  );
  await page
    .getByText("Planned Delivery Times", { exact: true })
    .first()
    .click();
  await page.getByText("PILOT", { exact: true }).first().waitFor();
  await page.getByText("PILOT", { exact: true }).first().click();
  await page.waitForURL(/SupplierPlannedTimes/);
  const prepare = page.getByRole("button", {
    name: "Prepare Supplier Lead-Time Change",
    exact: true,
  });
  await prepare.waitFor();
  await prepare.click();
  const dialog = page.getByRole("dialog", {
    name: "Prepare Supplier Lead-Time Change",
    exact: true,
  });
  const duration = dialog.getByRole("spinbutton", {
    name: "Selected planned time (days)",
    exact: true,
  });
  await duration.fill("21");
  await duration.press("Tab");
  await page.screenshot({
    path: `${screenshots}/desktop-selection.png`,
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Prepare for Review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  assert.equal(discardedResponse, true);
  assert.equal(commands.length, 1);
  assert.ok(
    await page.evaluate(
      (commandID) =>
        Object.keys(sessionStorage).some((storageKey) =>
          sessionStorage.getItem(storageKey)?.includes(commandID),
        ),
      commands[0].commandID,
    ),
  );
  await page.unroute(/\/odata\/v4\/workflow\/commandResult/);
  await page.unroute(
    /\/odata\/v4\/workflow\/prepareSupplierPlannedTimeAction(?:\?|$)/,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByText("Awaiting approval decision", { exact: true })
    .first()
    .waitFor();
  assert.ok(
    receiptRequests >= 2,
    "reload reconciles the retained command identity",
  );
  assert.equal(commands.length, 1, "reload must not send another preparation");
  assert.equal(
    await page.evaluate(
      (commandID) =>
        Object.keys(sessionStorage).some((storageKey) =>
          sessionStorage.getItem(storageKey)?.includes(commandID),
        ),
      commands[0].commandID,
    ),
    false,
  );
  const response = await context.request.get(
    `${root}/odata/v4/desk/Actions?$expand=items`,
  );
  assert.equal(response.status(), 200);
  const action = (await response.json()).value.find(
    (row) => row.problemKey === caseID,
  );
  assert.ok(action);
  assert.equal(action.items[0].newValue, "21");
  assert.equal(action.items[0].objectKey, "5500000001");
  assert.equal(discardedResponse, true);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].commandID);
  assert.ok(commands[0].expectedModifiedAt);
  const receipt = await context.request.get(
    `${root}/odata/v4/workflow/commandResult(commandID='${encodeURIComponent(commands[0].commandID)}')`,
  );
  assert.equal(receipt.status(), 200, await receipt.text());
  assert.equal((await receipt.json()).actionID, action.ID);
  await page.goto(`${root}/tide.cockpit/index.html#/Actions('${action.ID}')`, {
    waitUntil: "networkidle",
  });
  await page
    .getByText(/5500000001/)
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Approve Change", exact: true })
    .first()
    .click();
  const approvalDialog = page.getByRole("dialog");
  if (await approvalDialog.count())
    await approvalDialog
      .getByRole("button", { name: /^Approve/ })
      .first()
      .click();
  await page.getByText("Approved", { exact: true }).first().waitFor();
  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].commandID);
  assert.ok(decisions[0].expectedModifiedAt);
  assert.equal(decisions[0].actionID, action.ID);
  const approvedResponse = await context.request.get(
    `${root}/odata/v4/desk/Actions('${action.ID}')`,
  );
  assert.equal(approvedResponse.status(), 200);
  assert.equal((await approvedResponse.json()).status, "waiting");
  assert.equal(
    await page
      .getByRole("button", { name: "Download CSV", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: `${screenshots}/desktop-approval.png`,
    fullPage: true,
  });
  const headerResponse = await context.request.get(
    `${root}/odata/v4/desk/Cases('${encodeURIComponent(caseID)}')`,
  );
  assert.equal((await headerResponse.json()).status, "open");
  await page
    .getByRole("button", { name: "Log Outcome", exact: true })
    .first()
    .click();
  const reportDialog = page.getByRole("dialog");
  await reportDialog
    .getByRole("textbox")
    .fill("External posting status is not yet known");
  const observationResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/workflow/recordSupplierPosting") &&
      response.request().method() === "POST",
  );
  await reportDialog
    .getByRole("button", { name: "Log Outcome", exact: true })
    .click();
  assert.equal((await observationResponse).status(), 200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${root}/tide.cockpit/index.html#/SupplierPlannedTimes('${key}')`,
    { waitUntil: "networkidle" },
  );
  await page
    .getByText("Awaiting approval decision", { exact: true })
    .or(page.getByText("Waiting for review outcome", { exact: true }))
    .first()
    .waitFor();
  await page.screenshot({
    path: `${screenshots}/mobile-case.png`,
    fullPage: true,
  });
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.content <= dimensions.width + 1,
    JSON.stringify(dimensions),
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS supplier browser: hard-reload lost-response recovery without repeated write, frozen proposal, versioned approval, typed unknown posting stays waiting, open Case, desktop/mobile; screenshots ${screenshots}`,
  );
} catch (error) {
  console.error(
    "Rendered supplier pilot failure:",
    (await page.locator("body").innerText()).slice(0, 10000),
    "Page errors:",
    errors,
  );
  await page.screenshot({ path: `${screenshots}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
