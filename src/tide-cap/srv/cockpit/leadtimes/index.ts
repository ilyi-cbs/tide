// Register handlers before kernel stubs so the lead-time implementations take precedence.
import cds from "@sap/cds";
import type { Step, StepContext } from "../kernel/types";
import { asOfDate } from "../kernel/asof";
import { replaceDetectorCases } from "../kernel/detector-writers";
import { modelWork } from "../kernel/model-calls";
import { writePreparation } from "../kernel/publication";
import {
  prepareFindingAction,
  readAction,
  registerFindingActionBuilder,
} from "../kernel/actions";
import type { Meter } from "../kernel/model-calls";
import { bufferSimulator, currentValue } from "./domain/leadtimes";
import { infoRecords, key, masters, ownLeadTimes } from "./data";
import { leadTimeRange } from "./range";
import {
  estimateMedians,
  mmFindings,
  mmInputs,
  pdtFindings,
  pdtInputs,
} from "./lists";
import {
  pdtChangeAction,
  reconcileSupplierPlannedTimes,
  reconcileMaterialPlannedTimes,
} from "./actions";
import { refreshSettingRanges } from "./setting-check";

const LOG = cds.log("cockpit");

export const step: Step = {
  name: "leadtimes",
  async run(ctx: StepContext) {
    const mm = await cds.tx(() => mmInputs(ctx.asOf));
    const supplierInputs = await cds.tx(() => pdtInputs(ctx.asOf));
    const keys = new Map(
      [...supplierInputs.ir.values()].map((entry) => [
        key(entry.Material, entry.Supplier, entry.Plant),
        {
          Material: entry.Material,
          Supplier: entry.Supplier,
          Plant: entry.Plant,
        },
      ]),
    );
    for (const [Plant, sources] of mm.sources)
      for (const source of sources)
        keys.set(key(source.Material, source.Supplier, Plant), {
          Material: source.Material,
          Supplier: source.Supplier,
          Plant,
        });
    const settingRanges = await refreshSettingRanges(
      [...keys.values()],
      ctx.asOf,
      ctx.meter,
      false,
      ctx.dryRun,
    );
    if (ctx.dryRun) {
      await estimateMedians(mm, ctx.meter, true);
      return;
    }
    supplierInputs.settingRanges = settingRanges;
    mm.settingRanges = settingRanges;
    const pdt = pdtFindings(supplierInputs);
    const notes = await estimateMedians(mm, ctx.meter, false);
    const rows = [
      ...pdt,
      ...mmFindings(mm, notes, new Set(pdt.map((r) => `pdt:${r.objectKey}`))),
    ];
    await writePreparation(ctx, async () => {
      await replaceDetectorCases(ctx.snapshotId, ["pdt", "mm_pdt"], rows);
      await reconcileSupplierPlannedTimes();
      await reconcileMaterialPlannedTimes();
    });
    LOG.info(
      `leadtimes: ${pdt.length} pdt, ${rows.length - pdt.length} mm_pdt findings`,
    );
  },
};

const meterOf = (user: cds.User): Meter => ({
  user,
  calls: 0,
  cost: 0,
  runs: [],
  planned: [],
  backend: null,
  failed: [],
});

async function asOfOr409(req: cds.Request): Promise<string> {
  const asOf = await cds.tx(() => asOfDate());
  if (!asOf)
    return req.reject(
      409,
      "No dataset is loaded (run the loader first)",
    ) as never;
  return asOf;
}

const text = (v: unknown) =>
  v === null || v === undefined || v === "" ? null : String(v);

export function register(srv: cds.Service) {
  srv.on("leadTimeRange", async (req: cds.Request) => {
    const Plant = text(req.data.Plant);
    if (!Plant) return req.reject(400, "Plant is required");
    const asOf = await asOfOr409(req);
    if (req.data.asOf && String(req.data.asOf).slice(0, 10) !== asOf)
      return req.reject(409, "Imported source date changed; calculate again");
    const k = {
      Material: text(req.data.Material),
      Supplier: text(req.data.Supplier),
      Plant,
      quantity: req.data.quantity ?? null,
      unit: text(req.data.unit),
      needDate: text(req.data.needDate),
    };
    const r = await modelWork(() => leadTimeRange(k, asOf, meterOf(req.user)));
    const { note: _note, ...out } = r;
    return out;
  });

  srv.on("bufferSimulator", async (req: cds.Request) => {
    const [Material, Supplier, Plant] = [
      text(req.data.Material),
      text(req.data.Supplier),
      text(req.data.Plant),
    ];
    if (!Material || !Supplier || !Plant)
      return req.reject(400, "Material, Supplier and Plant are required");
    const asOf = await asOfOr409(req);
    const k = { Material, Supplier, Plant };
    const [own, ir, master] = await Promise.all([
      ownLeadTimes(asOf, k),
      infoRecords(k),
      masters({ Material, Plant }),
    ]);
    const cur = currentValue(
      ir.get(key(Material, Supplier, Plant))?.MaterialPlannedDeliveryDurn,
      master.get(`${Material}|${Plant}`)?.PlannedDeliveryDurationInDays,
    );
    return bufferSimulator(
      (own.get(key(Material, Supplier, Plant)) ?? []).map((o) => o.lt),
      cur.days,
    );
  });

  /** Finding addToChangeList (bound, multi-select in Prevention): the pdt_change; a pending one is returned. */
  const addToChangeList = async (req: cds.Request) => {
    const [k] = req.params as any[];
    const ID = String(typeof k === "object" ? k.ID : k);
    if (!/^(pdt|mm_pdt):/.test(ID))
      return req.reject(
        400,
        "Only planned delivery time findings go to the change list",
      );
    if (ID.startsWith("pdt:")) {
      const row = await cds.ql.SELECT.one
        .from("tide.cockpit.SupplierPlannedTimes")
        .where({ header_ID: ID });
      if (
        row &&
        (!Number.isInteger(row.proposedDays) ||
          row.proposedDays <= 0 ||
          row.proposedDays > 365)
      )
        return req.reject(
          409,
          "There is no numeric planned-time proposal to add to the change list",
        );
    }
    try {
      return await prepareFindingAction(ID, "app");
    } catch (e: any) {
      if (e?.status === 409 && e.actionID) return readAction(e.actionID);
      throw e;
    }
  };
  srv.on("addToChangeList", "Findings", addToChangeList);
  srv.on("addToChangeList", "SupplierPlannedTimeFindings", addToChangeList);
  srv.on(
    "addToChangeList",
    "MaterialMasterPlannedTimeFindings",
    addToChangeList,
  );

  registerFindingActionBuilder("pdt", pdtChangeAction);
  registerFindingActionBuilder("mm_pdt", pdtChangeAction);
}
