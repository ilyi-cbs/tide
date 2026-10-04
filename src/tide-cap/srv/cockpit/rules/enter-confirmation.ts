// Use case "enter a supplier confirmation" (PurchasingDeskService.enterConfirmation):
// validate, record (origin app), then run the confirmation hooks (impact
// recomputes the arrival estimate). A confirmation is a recorded fact, not a
// proposed action, so it never creates an Approval record.
import cds from "@sap/cds";
import { asOfDate } from "../kernel/asof";
import { emit } from "../kernel/events";
import { runHooks } from "../kernel/hooks";
import { NS, inTx, type Meter } from "../kernel/model-calls";
import type { StepContext } from "../kernel/types";
import { validateConfirmation } from "./domain";
import { addConfirmation, eq } from "./rows";
import * as store from "./store";
import { fail as reject } from "../kernel/errors";
import { reconcileDeliveryProblem } from "../kernel/problem-reconciliation";

const { SELECT } = cds.ql;

export async function enterConfirmation(req: cds.Request) {
  const po = String(req.data.PurchaseOrder ?? "").trim();
  const item = store.stripZeros(String(req.data.PurchaseOrderItem ?? "").trim());
  const date = req.data.date ? String(req.data.date).slice(0, 10) : "";
  const quantity = req.data.quantity == null ? null : Number(req.data.quantity);
  const asOf = await asOfDate();
  if (!asOf) throw reject(409, "No dataset is loaded.");
  const fact = po && item ? await store.itemFact(po, item) : null;
  const problem = validateConfirmation(
    {
      exists: !!fact,
      open: !!fact?.IsOpen,
      openQuantity: fact?.OpenQuantity == null ? null : Number(fact.OpenQuantity),
      PurchaseOrderDate: fact?.PurchaseOrderDate ? String(fact.PurchaseOrderDate).slice(0, 10) : null,
    },
    date,
    quantity,
  );
  if (problem) throw reject(fact ? 400 : 404, problem);
  const key = `${po}/${item}`;
  const user = (req.user as any)?.id ?? "anonymous";
  const findingOf = async () =>
    (await SELECT.one.from(`${NS}.Finding`).where(eq({ list: "at_risk", PurchaseOrder: po, PurchaseOrderItem: item, status: "open" }))) ??
    (await SELECT.one.from(`${NS}.Finding`).where(eq({ list: "overdue", PurchaseOrder: po, PurchaseOrderItem: item, status: "open" })));
  // Write in one short transaction; the hooks (impact may wait for a model
  // run) run after it has committed, outside any transaction.
  const before = await inTx(async () => {
    await addConfirmation(po, item, date, quantity, "app", user);
    const found = await findingOf();
    return found;
  });
  {
    const snapshot = await SELECT.one.from(`${NS}.Snapshot`).columns("ID").where({ status: "done" }).orderBy("startedAt desc");
    const meter: Meter = { user: req.user, calls: 0, cost: 0, runs: [], planned: [], backend: null, failed: [] };
    const ctx: StepContext = { user: req.user, snapshotId: snapshot?.ID ?? "", asOf, dryRun: false, meter };
    const events = await runHooks(
      {
        kind: "confirmation",
        at: new Date().toISOString(),
        rows: { Confirmation: [{ PurchaseOrder: po, PurchaseOrderItem: item, date, quantity, origin: "app" }] },
      },
      ctx,
    );
    for (const e of events) await emit({ ...e, kind: (e.kind ?? "confirmation") as any, title: e.title ?? "Confirmation recorded" });
    await reconcileDeliveryProblem(po, item, "confirmation");
    if (!events.length)
      await emit({
        kind: "confirmation",
        title: `Confirmation recorded for PO ${po} item ${item}: delivery on ${date}`,
        objectKey: key,
        findingID: before?.ID ?? null,
        source: "confirmation",
        status: "recorded",
      });
    const after = await findingOf();
    return after ? SELECT.one.from("PurchasingDeskService.Findings").where({ ID: after.ID }) : null;
  }
}
