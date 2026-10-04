// Use case "morning run" of the rules: copy SAP confirmations, compute the
// four rule lists at asOf and write them with their detail lines (one transaction).
import cds from "@sap/cds";
import { replaceDetectorCases } from "../kernel/detector-writers";
import { inTx, type Row } from "../kernel/model-calls";
import { writePreparation } from "../kernel/publication";
import type { FindingRow, StepContext } from "../kernel/types";
import {
  NEXT_REMINDER,
  duplicateGroups,
  empiricalPriceDeviations,
  materialActivity,
  overdueItems,
  rareCombinations,
  type ActivityRow,
} from "./domain";
import {
  RULE_LISTS,
  base,
  confirmedKeys,
  copySapConfirmations,
  duplicateFinding,
  itemRefs,
  modelPriceFinding,
  priceFinding,
  rareFinding,
  writeRuleLines,
} from "./rows";
import * as store from "./store";
import { priorityFields } from "../kernel/priority";
import { OVERDUE_ESCALATION_DAYS } from "./domain/constants";
import { reconcileDeliveryProblems } from "../kernel/problem-reconciliation";
import { unlistDeliveryCasesExcept } from "../kernel/delivery-risks";
import {
  assessPriceCandidates,
  preparePurchasePrices,
  syncPriceModelRows,
} from "./price-model";

const LOG = cds.log("cockpit");
const MAX_PRICE_FINDINGS = 6;
const MAX_DUPLICATE_FINDINGS = 5;
const MAX_RARE_FINDINGS = 5;

/** Builds the four rule lists at asOf (pure computation over the loaded data). */
export async function computeRuleFindings(asOf: string) {
  const [n, open, confirmed, activity, mats, planning, groups] =
    await Promise.all([
      store.names(),
      store.openItems(asOf),
      confirmedKeys(),
      store.activityRows(),
      store.materials(),
      store.planningRows(),
      store.purchasingGroups(),
    ]);
  const rows: FindingRow[] = [];
  const lines: Row[] = [];
  type Item = Row & {
    PurchaseOrder: string;
    PurchaseOrderItem: string;
    PurchaseOrderDate: string;
    RequestedDate: string | null;
  };
  const noReceipt = (r: Row): Item => ({
    ...r,
    PurchaseOrder: r.PurchaseOrder,
    PurchaseOrderItem: r.PurchaseOrderItem,
    PurchaseOrderDate: String(r.PurchaseOrderDate).slice(0, 10),
    RequestedDate: r.RequestedDate
      ? String(r.RequestedDate).slice(0, 10)
      : null,
    ReceivedQuantity: r.ArrivalDate
      ? Math.max(Number(r.ReceivedQuantity) || 0, 1)
      : Number(r.ReceivedQuantity) || 0,
  });
  const items = open.map(noReceipt);

  for (const deviation of empiricalPriceDeviations(
    (await store.priceRows()) as any,
    asOf,
  ).slice(0, MAX_PRICE_FINDINGS)) {
    const finding = priceFinding(deviation, n);
    rows.push({
      ...finding.row,
      rank: rows.filter((row) => row.list === "price").length + 1,
    });
    lines.push(...finding.lines);
  }

  overdueItems(items, asOf).forEach((o, i) =>
    rows.push({
      ...base(
        "overdue",
        `${o.row.PurchaseOrder}/${o.row.PurchaseOrderItem}`,
        o.issue,
        o.issueTechnical,
        NEXT_REMINDER,
      ),
      ...itemRefs(o.row, n),
      dueDate: o.dueDate,
      ...priorityFields(null, null, asOf, o.daysOverdue),
      nextStep:
        o.daysOverdue >= OVERDUE_ESCALATION_DAYS
          ? "Escalate overdue delivery"
          : NEXT_REMINDER,
      overdueDetail: {
        daysOverdue: o.daysOverdue,
        overdueCriticality: 1,
        confirmationStatus: confirmed.has(
          `${o.row.PurchaseOrder}/${o.row.PurchaseOrderItem}`,
        )
          ? "Confirmed"
          : "No confirmation",
        confirmationCriticality: confirmed.has(
          `${o.row.PurchaseOrder}/${o.row.PurchaseOrderItem}`,
        )
          ? 3
          : 1,
        netAmount: o.row.NetAmount ?? null,
        currency: o.row.Currency ?? null,
      },
      rank: i + 1,
    }),
  );

  const act = materialActivity(activity as ActivityRow[], asOf);
  for (const g of duplicateGroups(mats as any, act).slice(
    0,
    MAX_DUPLICATE_FINDINGS,
  )) {
    const f = duplicateFinding(g, n, groups);
    rows.push(f.row);
    lines.push(...f.lines);
  }

  rareCombinations(planning as any)
    .slice(0, MAX_RARE_FINDINGS)
    .forEach((c, i) => {
      const f = rareFinding(c, n, groups);
      rows.push({ ...f.row, rank: i + 1 });
      lines.push(...f.lines);
    });
  return { rows, lines, open: items };
}

/** The step body. */
export async function runRules(ctx: StepContext) {
  // Compute candidates outside the final case-write transaction: Core commits
  // its queued run before we wait, which avoids SQLite connection deadlock.
  const candidates = ctx.dryRun
    ? await store.priceRows()
    : await syncPriceModelRows();
  await preparePurchasePrices(
    ctx.user,
    ctx.asOf,
    candidates,
    ctx.meter,
    undefined,
    ctx.dryRun,
  );
  const assessed = await assessPriceCandidates(
    ctx.user,
    ctx.asOf,
    candidates,
    ctx.meter,
    candidates,
    false,
    ctx.dryRun,
  );
  if (ctx.dryRun) return;
  await writePreparation(ctx, async () => {
    const sap = await copySapConfirmations(ctx.asOf);
    const { rows, lines, open } = await computeRuleFindings(ctx.asOf);
    const names = await store.names();
    for (const { row, assessment } of assessed.filter(
      ({ assessment }) =>
        assessment.source === "tabpfn" &&
        assessment.alert &&
        assessment.calibrationStatus === "calibrated",
    )) {
      if (
        rows.filter((candidate) => candidate.list === "price").length >=
        MAX_PRICE_FINDINGS
      )
        break;
      const finding = modelPriceFinding(
        row,
        assessment,
        names,
        false,
        candidates,
      );
      rows.push({
        ...finding.row,
        rank: rows.filter((candidate) => candidate.list === "price").length + 1,
      });
      lines.push(...finding.lines);
    }
    await replaceDetectorCases(ctx.snapshotId, RULE_LISTS, rows);
    const deliveryCaseIDs = new Set<string>();
    for (const row of rows.filter((row) => row.list === "overdue"))
      deliveryCaseIDs.add(
        `delivery:${row.PurchaseOrder}/${row.PurchaseOrderItem}`,
      );
    // At-risk cases are relisted by the preceding detector; this step owns
    // the final delivery selection after overdue classification.
    const atRisk: Array<{ PurchaseOrder: string; PurchaseOrderItem: string }> =
      await cds.ql.SELECT.from(`${"tide.cockpit"}.DeliveryRisks`)
        .columns("PurchaseOrder", "PurchaseOrderItem")
        .where({ phase: "at_risk" });
    for (const row of atRisk)
      deliveryCaseIDs.add(
        `delivery:${row.PurchaseOrder}/${row.PurchaseOrderItem}`,
      );
    await unlistDeliveryCasesExcept(deliveryCaseIDs);
    await writeRuleLines(lines);
    await reconcileDeliveryProblems(open);
    const count = (l: string) => rows.filter((r) => r.list === l).length;
    LOG.info(
      `rules: ${RULE_LISTS.map((l) => `${l} ${count(l)}`).join(", ")}; ${sap} SAP confirmation lines`,
    );
  });
}
