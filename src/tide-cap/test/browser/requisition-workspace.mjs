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
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const pageErrors = [];
const failedRequests = [];
let predictionRequests = 0;
page.on("request", (request) => {
  if (
    request.url().endsWith("/$batch") &&
    request.postData()?.includes("predictDraftFieldsV5")
  ) {
    predictionRequests++;
  }
});
page.on("response", async (response) => {
  if (response.status() >= 400 && response.url().includes("/odata/"))
    failedRequests.push({ status: response.status(), url: response.url() });
  if (response.url().endsWith("/$batch")) {
    const body = await response.text().catch(() => "");
    if (/HTTP\/1\.1 [45]\d\d/.test(body))
      failedRequests.push({
        status: response.status(),
        url: response.url(),
        body,
      });
  }
});
page.on("pageerror", (error) => pageErrors.push(error.message));
const uiErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") uiErrors.push(message.text());
});
const root = process.argv[2];
const key =
  "PurchaseRequisition='10006643',PurchaseRequisitionItem='00010',IsActiveEntity=true";
const reviewPath = `/odata/v4/desk/PurchaseRequisitionReviews(${key})`;
const url = `${root}/tide.cockpit/index.html?sap-ui-xx-viewCache=false#/PurchaseRequisitionReviews(${key})`;

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  await page
    .getByRole("button", {
      name: /Open AI assistance for purchasing group/,
    })
    .waitFor();
  assert.equal(
    await page.getByText("Suggestion evidence", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("Services and limits", { exact: true }).count(),
    0,
  );
  const group = page.getByText("Purchasing and classification", {
    exact: true,
  });
  const position = await group.boundingBox();
  assert.ok(
    position && position.y < 1000,
    "The working purchasing-group field is in the first viewport",
  );
  await page.getByText("Valuation", { exact: true }).scrollIntoViewIfNeeded();
  await page
    .getByText(/852\.91/)
    .first()
    .waitFor();
  assert.ok((await page.locator("body").innerText()).includes("852.91"));
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh suggestions", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator(".tideAssistedField").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Review order draft", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("heading", { name: "Actions", exact: true }).count(),
    0,
  );
  const artifacts = process.env.PR_UI_ARTIFACTS || "/tmp/tide-pr-ui";
  await mkdir(artifacts, { recursive: true });
  assert.equal(
    await page
      .getByRole("button", {
        name: /Open AI assistance for material(?! group)/i,
      })
      .count(),
    0,
  );
  for (const width of [1500, 1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    await page.screenshot({
      path: `${artifacts}/display-${width}.png`,
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `No horizontal overflow at ${width}px`,
    );
    for (const target of [
      "material group",
      "purchasing group",
      "supplier",
      "purchasing info record",
      "account assignment category",
    ]) {
      const gap = await page
        .getByRole("button", {
          name: new RegExp("Open AI assistance for " + target, "i"),
        })
        .evaluate((button) => {
          const field = button.closest(".sapMHBox").firstElementChild;
          const value = field.querySelector(".sapMText") || field;
          return (
            button.getBoundingClientRect().left -
            value.getBoundingClientRect().right
          );
        });
      assert.ok(
        gap >= 4 && gap <= 12,
        `${target} icon stays adjacent at ${width}px (gap ${gap}px)`,
      );
    }
    if (width >= 1440) {
      const headings = await Promise.all(
        ["Item and delivery", "Accounting"].map((name) =>
          page.getByText(name, { exact: true }).boundingBox(),
        ),
      );
      assert.ok(headings.every(Boolean));
      assert.ok(
        Math.abs(headings[0].x - headings[1].x) < 8 &&
          headings[0].y < headings[1].y,
        "Native business subsections share a consistent full-width alignment",
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  assert.equal(
    await page
      .getByRole("button", { name: "View original request", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator('[id$="requestWorkingTabs"]').count(), 0);

  await page
    .getByRole("button", { name: "Suggest values", exact: true })
    .click();
  const activeTargets = page.getByRole("dialog", {
    name: "Suggest values",
    exact: true,
  });
  await activeTargets.waitFor();
  assert.equal(
    await activeTargets
      .getByRole("checkbox", { name: "Material", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await activeTargets
      .getByRole("button", { name: "Run selected", exact: true })
      .isEnabled(),
    false,
  );
  const activeMaterialGroup = activeTargets.getByRole("checkbox", {
    name: "Material group",
    exact: true,
  });
  assert.equal(await activeMaterialGroup.isEnabled(), true);
  await activeMaterialGroup.focus();
  await page.keyboard.press("Space");
  const activeRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/$batch") &&
      request.postData()?.includes("predictDraftFieldsV5"),
  );
  await activeTargets
    .getByRole("button", { name: "Run selected", exact: true })
    .click();
  const activeBody = (await activeRequest).postData();
  assert.match(activeBody, /IsActiveEntity=true/);
  assert.match(activeBody, /"expectedDraftUUID"\s*:\s*null/);
  const activeResults = page.getByRole("dialog", {
    name: "Prediction results",
    exact: true,
  });
  await activeResults.waitFor();
  assert.equal(
    await activeResults
      .getByRole("button", { name: "Apply selected", exact: true })
      .isEnabled(),
    false,
  );
  await activeResults
    .getByRole("button", { name: "Close", exact: true })
    .click();
  assert.equal(
    await page.getByRole("button", { name: "Save", exact: true }).count(),
    0,
  );

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "Purchasing Group", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Suggest values", exact: true })
    .click();
  const targets = page.getByRole("dialog", {
    name: "Suggest values",
    exact: true,
  });
  await targets.waitFor();
  assert.equal(
    predictionRequests,
    1,
    "Opening target selection does not start inference",
  );
  const startPrediction = targets.getByRole("button", {
    name: "Run selected",
    exact: true,
  });
  assert.equal(await startPrediction.isEnabled(), false);
  const supplierTarget = targets.getByRole("checkbox", {
    name: "Supplier",
    exact: true,
  });
  await supplierTarget.focus();
  await page.keyboard.press("Space");
  const predictionRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/$batch") &&
      request.postData()?.includes("predictDraftFieldsV5"),
  );
  await startPrediction.click();
  const predictionBody = (await predictionRequest).postData();
  assert.match(predictionBody, /"selectedFields"\s*:\s*\["Supplier"\]/);
  const chooser = page.getByRole("dialog", {
    name: "Prediction results",
    exact: true,
  });
  await chooser.waitFor();
  assert.equal(
    await chooser
      .getByRole("button", { name: "Apply selected", exact: true })
      .isEnabled(),
    false,
  );
  assert.equal(
    await chooser.getByRole("checkbox", { checked: true }).count(),
    0,
  );
  await page.screenshot({
    path: `${artifacts}/prediction-results-1440.png`,
    fullPage: true,
  });
  await chooser.getByRole("button", { name: "Close", exact: true }).click();
  await chooser.waitFor({ state: "hidden" });
  const refreshedDraft = await (
    await page.request.get(
      root + reviewPath.replace("IsActiveEntity=true", "IsActiveEntity=false"),
    )
  ).json();
  assert.equal(
    refreshedDraft.Supplier,
    "19000001",
    "Refresh is evidence-only, not a field mutation",
  );
  await page
    .getByRole("button", {
      name: /Open AI assistance for purchasing group/,
    })
    .waitFor();
  await page.screenshot({ path: `${artifacts}/edit-1440.png`, fullPage: true });
  await page.evaluate(() => {
    document.body.classList.remove("sapUiSizeCompact");
    document.body.classList.add("sapUiSizeCozy");
  });
  await page.screenshot({
    path: `${artifacts}/edit-cozy-1440.png`,
    fullPage: true,
  });
  await page.evaluate(() => {
    document.body.classList.remove("sapUiSizeCozy");
    document.body.classList.add("sapUiSizeCompact");
  });
  await page
    .getByRole("button", {
      name: /Open AI assistance for purchasing group/,
    })
    .click();
  const candidate = page
    .getByRole("listitem")
    .filter({ hasText: "D02 (Plant purchasing)" });
  await page.getByText("Model score 0.99", { exact: true }).waitFor();
  await candidate.click();
  assert.equal(
    await page
      .getByRole("button", { name: "Apply selected", exact: true })
      .count(),
    1,
  );
  let pendingResponse = await page.request.get(
    root + reviewPath.replace("IsActiveEntity=true", "IsActiveEntity=false"),
  );
  assert.equal(
    (await pendingResponse.json()).reviewedPurchasingGroup,
    null,
    "Selecting a candidate is nonmutating",
  );
  await page
    .getByRole("button", { name: "Apply selected", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Open AI assistance for purchasing group/ })
    .click();
  await page
    .getByText("D02 (Plant purchasing)", { exact: true })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Confirm current value", exact: true })
    .click();
  await page
    .getByText("AI suggested - reviewed", { exact: true })
    .waitFor({ state: "attached" });
  if (!(await page.getByRole("dialog").isVisible())) {
    await page
      .getByRole("button", { name: /Open AI assistance for purchasing group/ })
      .click();
  }
  await page.getByText("AI suggested - reviewed", { exact: true }).waitFor();
  await page.screenshot({
    path: `${artifacts}/evidence-1440.png`,
    fullPage: true,
  });
  await page.getByRole("dialog").press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: /Open AI assistance for purchasing group/ })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({
    path: `${artifacts}/evidence-390.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${artifacts}/edit-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  pendingResponse = await page.request.get(
    root + reviewPath.replace("IsActiveEntity=true", "IsActiveEntity=false"),
  );
  assert.equal(pendingResponse.status(), 200);
  assert.equal((await pendingResponse.json()).reviewedPurchasingGroup, "D02");
  const activeResponse = await page.request.get(root + reviewPath);
  assert.equal(
    (await activeResponse.json()).reviewedPurchasingGroup,
    null,
    "Alternative selection only changes the draft",
  );

  await page
    .getByRole("button", { name: "Submit for approval", exact: true })
    .click();
  const finalReview = page.getByRole("dialog", {
    name: "Submit for approval",
    exact: true,
  });
  await finalReview.getByText("852.91 EUR", { exact: true }).waitFor();
  const summary = await finalReview.innerText();
  assert.ok(summary.includes("D02"));
  assert.ok(summary.includes("852.91 EUR"));
  assert.ok(summary.includes("Changes from request"));
  assert.ok(summary.includes("D02"));
  const savedForReview = await (
    await page.request.get(root + reviewPath)
  ).json();
  assert.equal(
    savedForReview.HasDraftEntity,
    false,
    "Submit first saves the editable draft",
  );
  const submissionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/submitRequisitionReview"),
  );
  await page
    .getByRole("dialog", { name: "Submit for approval", exact: true })
    .getByRole("button", { name: "Submit for approval", exact: true })
    .click();
  const committedResponse = await submissionResponse;
  assert.equal(committedResponse.status(), 200);
  const submittedCommand = committedResponse.request().postDataJSON();
  assert.ok(submittedCommand.commandID);
  assert.equal(submittedCommand.expectedModifiedAt, savedForReview.modifiedAt);
  assert.match(submittedCommand.expectedReviewToken, /^[a-f0-9]{64}$/);
  const committedCommand = await committedResponse.json();
  const submitted = await (await page.request.get(root + reviewPath)).json();
  assert.equal(submitted.lifecycleStatus, "awaiting_approval");
  assert.equal(committedCommand.caseID, "requisition:10006643/00010");
  assert.equal(committedCommand.actionID, submitted.actionID);
  assert.ok(committedCommand.submissionID);
  await page
    .getByRole("button", { name: "Open Approval", exact: true })
    .waitFor();
  assert.equal(submitted.reviewedPurchasingGroup, "D02");

  await page.locator(".sapUxAPObjectPageWrapper").evaluate((wrapper) => {
    wrapper.scrollTop = 0;
  });
  await page
    .getByRole("button", { name: "Open Approval", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Approve(?: Change| Follow-up)?$/ })
    .waitFor();
  assert.equal(await page.locator('[id$="approvalRequestFacts"]').isVisible(), true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await page.screenshot({ path: `${artifacts}/approval-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: /^Approve(?: Change| Follow-up)?$/ })
    .click();
  await page
    .getByRole("button", { name: "Log Outcome", exact: true })
    .waitFor();
  assert.equal(await page.locator('[id$="approvalDecisionFacts"]').isVisible(), true);
  await page.screenshot({ path: `${artifacts}/approval-decided.png`, fullPage: true });
  assert.ok(submitted.actionID);
  const instructionResponse = await page.request.get(
    `${root}/odata/v4/desk/Actions(${submitted.actionID})?$expand=items`,
  );
  assert.equal(instructionResponse.status(), 200);
  const approved = await instructionResponse.json();
  assert.equal(approved.kind, "pr_review");
  const payload = approved.items
    .map((item) => JSON.parse(item.data ?? "{}"))
    .find((data) => data.payload)?.payload;
  assert.ok(payload);
  assert.equal(payload.completed.PurchasingGroup, "D02");
  assert.equal(payload.completed.ValuationPrice, 852.91);
  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Open Approval", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Edit", exact: true }).count(),
    0,
    "Approved values are locked",
  );
  await page.goto(url.replace("10006643", "10006644"), {
    waitUntil: "networkidle",
  });
  const allocationReview = await (
    await page.request.get(root + reviewPath.replace("10006643", "10006644"))
  ).json();
  assert.equal(allocationReview.reviewedAccountAssignmentCategory, "K");
  const allocationWorkspace = await (
    await page.request.post(
      root +
        reviewPath.replace("10006643", "10006644") +
        "/PurchasingDeskService.reviewWorkspaceV5",
      { data: {}, headers: { "If-Match": allocationReview["@odata.etag"] } },
    )
  ).json();
  assert.equal(allocationWorkspace.accountCategory, "K");
  assert.equal(allocationWorkspace.allocationCount, 1);
  await page.waitForFunction(() => {
    const controls = Object.values(
      sap.ui.require("sap/ui/core/Element").registry.all(),
    );
    const panel = controls.find((control) =>
      control.getId().endsWith("--accountAssignmentPanel"),
    );
    return (
      panel?.getModel("workspace")?.getProperty("/accountCategory") === "K"
    );
  });
  await page.getByText("CC01", { exact: true }).waitFor();
  await page
    .getByRole("main")
    .getByText(/^G\/L account:?$/)
    .waitFor();
  await page
    .getByRole("main")
    .getByText(/^Cost center:?$/)
    .waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("button", { name: "Split allocation", exact: true })
    .waitFor();
  assert.equal(
    await page.locator('[id$="singleAllocationForm"]').isVisible(),
    true,
  );
  await page
    .getByRole("button", { name: "Split allocation", exact: true })
    .click();
  await page.locator('[id$="reviewAllocationTable-content"]').waitFor();
  assert.equal(
    await page.locator('[id$="reviewAllocationTable-content"]').isVisible(),
    true,
  );
  assert.deepEqual(pageErrors, [], "No page runtime exceptions");
  console.log(
    `Browser journey passed: typed evidence -> explicit Apply/Confirm -> Save -> approval -> immutable export. Screenshots: ${artifacts}`,
  );
} catch (error) {
  console.error(error.stack || error.message);
  await mkdir("/tmp/tide-pr-ui", { recursive: true });
  await page
    .screenshot({
      path: "/tmp/tide-pr-ui/failure.png",
      fullPage: true,
    })
    .catch(() => {});
  console.error(
    JSON.stringify(
      {
        pageErrors,
        failedRequests,
        bindingPath: await page.evaluate(async () => {
          const Element = await new Promise((resolve) =>
            sap.ui.require(["sap/ui/core/Element"], resolve),
          );
          let control = Element.getElementById(
            "tide.cockpit::RequestsReviewObjectPage--fe::CustomSubSection::purchasingClassification--purchasingGroupAssistant",
          );
          const ancestors = [];
          while (control && !control.isA("sap.ui.core.mvc.View")) {
            const label = control.getLabel?.();
            ancestors.push({
              type: control.getMetadata().getName(),
              label: typeof label === "string" ? label : label?.getId?.(),
            });
            control = control.getParent();
          }
          const binding = control?.getBindingContext();
          return {
            path: binding?.getPath(),
            ancestors,
            data: binding?.getObject(),
          };
        }),
        uiErrors: uiErrors.slice(-12),
        assistance: await page
          .locator('[id$="--purchasingGroupAssistant"]')
          .evaluate((button) => button.outerHTML, { timeout: 1000 })
          .catch(() => null),
        workspace: await (
          await page.request.post(
            root +
              reviewPath.replace(
                "IsActiveEntity=true",
                "IsActiveEntity=false",
              ) +
              "/PurchasingDeskService.reviewWorkspaceV5",
            { data: {}, headers: { "If-Match": "*" } },
          )
        )
          .json()
          .then(
            (workspace) =>
              workspace.fields?.find(
                (field) => field.field === "PurchasingGroup",
              ) || workspace,
          ),
        body: (await page.locator("body").innerText()).slice(0, 5000),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
