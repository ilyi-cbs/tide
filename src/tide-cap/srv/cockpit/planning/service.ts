// Planning reads lead-time ranges through the leadtimes service, not its implementation.
import cds from "@sap/cds";
import { asOfDate } from "../kernel/asof";
import { sourceText } from "../kernel/findings";
import { sourceIdentity } from "../kernel/publication";
import { inCommandScope, scopeOf } from "../kernel/auth";
import { fail } from "../kernel/errors";
import {
  PlanningInputError,
  PlanningForecastError,
  buildPlan,
  dailyDemand,
  defaultNeedDate,
  defaultSupplier,
  maintainedDays,
  unitPrice,
  validate,
  type InfoRecordRow,
  type IssueRow,
  type PlanResult,
  type PoRow,
  type RangeInput,
} from "./domain/logic";

const { SELECT } = cds.ql;
type Row = Record<string, any>;

export interface PlanOrderInput {
  Material: string;
  Plant: string;
  Supplier?: string | null;
  needDate?: string | null;
  quantity?: number | null;
  unit?: string | null;
  currency?: string | null;
}

/** Range source: the service call by default; tests may replace it. */
export type RangeFetcher = (key: {
  Material: string;
  Supplier: string;
  Plant: string;
  quantity?: number | null;
  unit?: string | null;
  needDate?: string | null;
  asOf?: string | null;
}) => Promise<RangeInput | null>;
export type PriceFetcher = (input: {
  Material: string;
  Plant: string;
  Supplier: string;
  quantity: number;
  unit: string;
  currency: string;
  asOf: string;
}) => Promise<Row | null>;

const statusOf = (e: any) => Number(e?.status ?? e?.statusCode ?? e?.code) || 0;

export const serviceRange: RangeFetcher = async (key) => {
  const srv = await cds.connect.to("PurchasingDeskService");
  try {
    const r: Row | null = await srv.send("leadTimeRange", key);
    if (!r) return null;
    return {
      source: r.source,
      n: r.n ?? null,
      contextLevel: r.contextLevel ?? null,
      contextRows: r.contextRows ?? null,
      levels: r.levels ?? null,
      ownLevels: r.ownLevels ?? null,
      agreement: r.agreement ?? null,
      modelRunID: r.modelRunID ?? null,
      modelBackend: r.modelBackend ?? null,
      modelTrainingRows: r.modelTrainingRows ?? null,
      modelFallback: r.modelFallback ?? null,
    };
  } catch (e: any) {
    const status = statusOf(e);
    if (status === 404) return null;
    // Fall back to the prepared range if the leadtimes handler is unavailable.
    if (status === 501 || e?.notImplemented)
      return storedRange({
        Material: key.Material,
        Supplier: key.Supplier,
        Plant: key.Plant,
      });
    throw e;
  }
};

export const servicePrice: PriceFetcher = async (input) => {
  const srv = await cds.connect.to("PurchasingDeskService");
  return srv.send("estimatePurchasePrice", input);
};

/** Prepared range for this source; does not trigger a model call. */
export async function storedRange(key: {
  Material: string;
  Supplier: string;
  Plant: string;
}): Promise<RangeInput | null> {
  const r: Row | null = await SELECT.one
    .from("tide.cockpit.SourceRange")
    .where(key);
  if (!r?.quantiles) return null;
  let levels: string | null = r.quantiles;
  if (r.quantiles && r.quantiles.includes('"grid"')) {
    try {
      levels = JSON.stringify(JSON.parse(r.quantiles).grid ?? null);
    } catch {
      levels = null;
    }
  }
  if (!levels) return null;
  return {
    source: r.source,
    n: r.source === "empirical" ? r.nOwn : r.contextRows,
    contextLevel: r.contextLevel ?? null,
    contextRows: r.contextRows ?? null,
    levels,
  };
}

async function currentAsOf(): Promise<string> {
  const asOf = await asOfDate();
  if (!asOf) throw new PlanningInputError("No dataset loaded");
  return String(asOf).slice(0, 10);
}

async function plantKnown(plant: string): Promise<boolean> {
  const hit =
    (await SELECT.one
      .from("tide.s4.ProductPlantSupplyPlanning")
      .columns("Plant")
      .where({ Plant: plant })) ??
    (await SELECT.one
      .from("tide.s4.PurchaseOrderItem")
      .columns("Plant")
      .where({ Plant: plant }));
  return !!hit;
}

/** A supplier is known from the supplier master, a PO or an info record. */
async function supplierKnown(supplier: string, asOf: string): Promise<boolean> {
  const hit =
    (await SELECT.one
      .from("tide.s4.Supplier")
      .columns("Supplier")
      .where({ Supplier: supplier })) ??
    (await SELECT.one.from("tide.s4.PurchaseOrder").columns("Supplier")
      .where`Supplier = ${supplier} and PurchaseOrderDate < ${asOf}`) ??
    (await SELECT.one
      .from("tide.s4.PurgInfoRecdOrgPlantData")
      .columns("Supplier")
      .where({ Supplier: supplier }));
  return !!hit;
}

async function materialText(material: string): Promise<string | null> {
  const r: Row | null = await SELECT.one
    .from("tide.s4.ProductDescription")
    .columns("ProductDescription")
    .where({ Product: material, Language: "EN" });
  return r?.ProductDescription ?? null;
}

async function plantName(plant: string): Promise<string | null> {
  const r: Row | null = await SELECT.one
    .from("tide.s4.Plant")
    .columns("PlantName")
    .where({ Plant: plant });
  return r?.PlantName ?? null;
}

async function supplierName(supplier: string): Promise<string | null> {
  const r: Row | null = await SELECT.one
    .from("tide.s4.Supplier")
    .columns("SupplierName")
    .where({ Supplier: supplier });
  return r?.SupplierName ?? null;
}

/** Product master creation date: how long this material has been known in the system. */
async function materialSince(material: string): Promise<string | null> {
  const r: Row | null = await SELECT.one
    .from("tide.s4.Product")
    .columns("CreationDate")
    .where({ Product: material });
  return r?.CreationDate ? String(r.CreationDate).slice(0, 10) : null;
}

/** Earliest order or info record date of this material + supplier + plant: since when this source is on record. */
function earliestSourceDate(
  pos: PoRow[],
  irs: InfoRecordRow[],
  supplier: string,
): string | null {
  const dates = [
    ...pos
      .filter((p) => p.Supplier === supplier)
      .map((p) => p.PurchaseOrderDate),
    ...irs
      .filter((r) => r.Supplier === supplier && r.PurchasingDocumentDate)
      .map((r) => r.PurchasingDocumentDate as string),
  ].filter(Boolean);
  return dates.length ? dates.sort()[0] : null;
}

/** POs of the material in the plant before the as-of date (not deleted). */
async function orders(
  material: string,
  plant: string,
  asOf: string,
): Promise<PoRow[]> {
  const rows: Row[] = await SELECT.from("tide.s4.PurchaseOrderItem").columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "header.PurchaseOrderDate as PurchaseOrderDate",
    "header.Supplier as Supplier",
    "header.PurchasingGroup as PurchasingGroup",
    "OrderQuantity",
    "PurchaseOrderQuantityUnit",
    "NetPriceAmount",
    "NetPriceQuantity",
    "DocumentCurrency",
    "PurchasingDocumentDeletionCode",
  )
    .where`Material = ${material} and Plant = ${plant} and header.PurchaseOrderDate < ${asOf}`;
  return rows
    .filter(
      (r) =>
        !r.PurchasingDocumentDeletionCode &&
        inCommandScope(cds.context?.user ?? {}, {
          Plant: plant,
          PurchasingGroup: r.PurchasingGroup,
        }),
    )
    .map((r) => ({
      ...r,
      PurchaseOrderDate: String(r.PurchaseOrderDate).slice(0, 10),
    })) as PoRow[];
}

async function infoRecords(
  material: string,
  plant: string,
  asOf: string,
): Promise<InfoRecordRow[]> {
  const rows: Row[] = await SELECT.from("tide.s4.PurgInfoRecdOrgPlantData")
    .columns(
      "PurchasingInfoRecord",
      "Supplier",
      "PurchasingGroup",
      "PurchasingDocumentDate",
      "MaterialPlannedDeliveryDurn",
      "IsMarkedForDeletion",
    )
    .where({ Material: material, Plant: plant });
  return rows
    .filter(
      (r) =>
        !r.IsMarkedForDeletion &&
        (!r.PurchasingDocumentDate ||
          String(r.PurchasingDocumentDate) < asOf) &&
        inCommandScope(cds.context?.user ?? {}, {
          Plant: plant,
          PurchasingGroup: r.PurchasingGroup,
        }),
    )
    .map((r) => ({
      PurchasingInfoRecord: r.PurchasingInfoRecord,
      Supplier: r.Supplier,
      PurchasingDocumentDate: r.PurchasingDocumentDate
        ? String(r.PurchasingDocumentDate).slice(0, 10)
        : null,
      MaterialPlannedDeliveryDurn: r.MaterialPlannedDeliveryDurn,
    }));
}

/** Own lead times (> 0 days, received before the as-of date) of the source. */
async function history(
  material: string,
  supplier: string,
  plant: string,
  asOf: string,
): Promise<number[]> {
  const rows: Row[] = await SELECT.from("tide.cockpit.ItemFact").columns(
    "LeadTimeDays",
  )
    .where`Material = ${material} and Supplier = ${supplier} and Plant = ${plant} and LeadTimeDays > 0 and AvailableDate < ${asOf}`;
  return rows.map((r) => Number(r.LeadTimeDays));
}

/** Goods issues of the material in the plant in base unit (the document carries no entry unit). */
async function issues(
  material: string,
  plant: string,
  asOf: string,
): Promise<{ rows: IssueRow[]; unit: string | null }> {
  const product = await SELECT.one
    .from("tide.s4.Product")
    .columns("BaseUnit")
    .where({ Product: material });
  const unit: string | null = product?.BaseUnit ?? null;
  const rows: Row[] = await SELECT.from("tide.s4.MaterialDocumentItem").columns(
    "PostingDate",
    "GoodsMovementType",
    "GoodsMovementIsCancelled",
    "QuantityInBaseUnit",
    "QuantityInEntryUnit",
  )
    .where`Material = ${material} and Plant = ${plant} and GoodsMovementType in ('201','261','601') and PostingDate < ${asOf}`;
  return {
    unit,
    rows: rows.map((r) => ({
      PostingDate: String(r.PostingDate).slice(0, 10),
      GoodsMovementType: String(r.GoodsMovementType),
      cancelled: !!r.GoodsMovementIsCancelled,
      quantity: Number(r.QuantityInBaseUnit ?? r.QuantityInEntryUnit ?? 0),
      unit,
    })),
  };
}

/** Buyer-facing reason why the lead-time range carries no TabPFN forecast. */
function forecastGap(lt: RangeInput | null, infoRecordOnly: boolean): string {
  if (infoRecordOnly)
    return "it has an info record but no purchase order for this material in this plant yet, so there is no delivery history to learn from. Pick a supplier with order history or use Compare suppliers.";
  switch (lt?.contextLevel) {
    case "no purchase order of this key":
      return "no purchase order of this material from this supplier in this plant before the forecast date. Pick a supplier with order history or use Compare suppliers.";
    case "too little context":
      return "too few completed orders in this plant before the forecast date to train a forecast.";
    case "stock transfer":
      return "the material is procured by stock transfer; the supplying plant determines the lead time.";
    case "unsupported prediction provider":
      return "the prediction service is unavailable or not configured. Try again later or contact your administrator.";
  }
  if (!lt) return "no lead-time range could be determined for this supplier.";
  return `only ${lt.source} lead-time evidence is available; the prediction service returned no forecast. Try Force re-prediction.`;
}

/** Validates before model calls, then calculates the plan from the supplier range. */
export async function planOrder(
  input: PlanOrderInput,
  range: RangeFetcher = serviceRange,
  priceFetcher: PriceFetcher = servicePrice,
  origin?: string,
): Promise<
  Omit<PlanResult, "masterData"> & {
    sourceText: string;
    MaterialText: string | null;
    PlantName: string | null;
    SupplierName: string | null;
    materialSince: string | null;
    supplierSince: string | null;
    masterDataDirection: string | null;
    masterDataTypicalDays: number | null;
    masterDataP80Days: number | null;
    masterDataGapDays: number | null;
  }
> {
  const Material = String(input.Material ?? "").trim();
  const Plant = String(input.Plant ?? "").trim();
  const entered = String(input.Supplier ?? "").trim() || null;
  if (!Material || !Plant)
    throw new PlanningInputError("Material and plant are required");
  const callerScope = scopeOf(cds.context?.user ?? {});
  if (
    !callerScope.isAdmin &&
    !callerScope.grants?.some((grant) => grant.Plant === Plant)
  )
    throw fail(404, "Planning context not found");
  const asOf = await currentAsOf();
  if (origin && origin !== asOf)
    throw new PlanningInputError(
      "Source date changed during supplier comparison; calculate again",
    );
  const source = await sourceIdentity();
  // No need date (page opened without a row): as-of + NEED_DATE_DAYS.
  const needDate = input.needDate
    ? String(input.needDate).slice(0, 10)
    : defaultNeedDate(null, null, asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(needDate))
    throw new PlanningInputError("Need date must be a date (YYYY-MM-DD)");
  const parsedNeedDate = new Date(`${needDate}T00:00:00Z`);
  if (
    !Number.isFinite(parsedNeedDate.getTime()) ||
    parsedNeedDate.toISOString().slice(0, 10) !== needDate
  )
    throw new PlanningInputError("Need date must be a valid calendar date");
  if (needDate < asOf)
    throw new PlanningInputError(
      `Need date ${needDate} is in the past (today is ${asOf})`,
    );
  const requestedContext =
    input.quantity != null || input.unit != null || input.currency != null;
  if (
    requestedContext &&
    (!Number.isFinite(input.quantity) ||
      Number(input.quantity) <= 0 ||
      !String(input.unit ?? "").trim() ||
      !String(input.currency ?? "").trim())
  )
    throw new PlanningInputError(
      "Requested quantity, unit and currency must be supplied together; quantity must be positive",
    );

  const pKnown = await plantKnown(Plant);
  const mKnown =
    pKnown &&
    !!(await SELECT.one
      .from("tide.s4.Product")
      .columns("Product")
      .where({ Product: Material }));
  const master = mKnown
    ? await SELECT.one
        .from("tide.s4.ProductPlantSupplyPlanning")
        .columns("PlannedDeliveryDurationInDays", "GoodsReceiptDuration")
        .where({ Product: Material, Plant })
    : null;
  const pos = master ? await orders(Material, Plant, asOf) : [];
  const irs = master ? await infoRecords(Material, Plant, asOf) : [];
  const sKnown =
    entered && master ? await supplierKnown(entered, asOf) : undefined;
  const warnings = validate(
    {
      plantKnown: pKnown,
      materialKnown: mKnown,
      materialInPlant: !!master,
      supplierKnown: sKnown,
      pairHasSource: entered
        ? pos.some((p) => p.Supplier === entered) ||
          irs.some((r) => r.Supplier === entered)
        : undefined,
    },
    { Material, Plant, Supplier: entered },
  );

  const def = defaultSupplier(pos, irs);
  const Supplier = entered ?? def.supplier;
  const supplierFrom = entered ? "entered" : (def.from ?? "none");
  const maintained = maintainedDays(
    Supplier ? irs.filter((r) => r.Supplier === Supplier) : [],
    master?.PlannedDeliveryDurationInDays,
  );
  if (!Supplier)
    warnings.push(
      "No supplier: no order and no info record of this material in this plant",
    );

  const compatible = pos
    .filter(
      (row) =>
        row.Supplier === Supplier &&
        row.PurchaseOrderQuantityUnit &&
        row.DocumentCurrency &&
        Number(row.OrderQuantity) > 0,
    )
    .sort((a, b) => b.PurchaseOrderDate.localeCompare(a.PurchaseOrderDate));
  const assumed = requestedContext
    ? {
        OrderQuantity: Number(input.quantity),
        PurchaseOrderQuantityUnit: String(input.unit).trim(),
        DocumentCurrency: String(input.currency).trim(),
      }
    : compatible[0];
  const lt = Supplier
    ? await range({
        Material,
        Supplier,
        Plant,
        quantity: assumed ? Number(assumed.OrderQuantity) : undefined,
        unit: assumed?.PurchaseOrderQuantityUnit,
        needDate,
        asOf,
      })
    : null;
  if (Supplier && lt?.source !== "tabpfn") {
    const infoRecordOnly =
      irs.some((r) => r.Supplier === Supplier) &&
      !pos.some((p) => p.Supplier === Supplier);
    throw new PlanningForecastError(
      `TabPFN delivery forecast unavailable for this supplier: ${forecastGap(lt, infoRecordOnly)}`,
    );
  }
  const hist =
    Supplier && lt?.source === "empirical"
      ? await history(Material, Supplier, Plant, asOf)
      : [];
  const gi = await issues(Material, Plant, asOf);
  const demand = dailyDemand(gi.rows, asOf);
  let price: Row = {
    source: "unavailable",
    reason: "No compatible purchase-order price assumption",
  };
  if (Supplier && assumed) {
    price = {
      historicalReference: unitPrice(
        pos.filter(
          (row) =>
            row.Supplier === Supplier &&
            row.DocumentCurrency === assumed.DocumentCurrency,
        ),
        String(assumed.PurchaseOrderQuantityUnit),
      ).unitPrice,
      source: "fallback",
      reason: "Price estimate unavailable",
      assumedQuantity: Number(assumed.OrderQuantity),
      assumedUnit: assumed.PurchaseOrderQuantityUnit,
      assumedCurrency: assumed.DocumentCurrency,
    };
    if (priceFetcher) {
      try {
        const estimate = await priceFetcher({
          Material,
          Plant,
          Supplier,
          quantity: Number(assumed.OrderQuantity),
          unit: String(assumed.PurchaseOrderQuantityUnit),
          currency: String(assumed.DocumentCurrency),
          asOf,
        });
        if (estimate?.source === "tabpfn") price = estimate;
        else if (estimate?.reason) price.reason = estimate.reason;
      } catch {
        price.reason = "TabPFN price estimate unavailable";
      }
    }
    if (price.source !== "tabpfn") {
      price = {
        source: "unavailable",
        reason: price.reason || "TabPFN price estimate unavailable",
        assumedQuantity: price.assumedQuantity,
        assumedUnit: price.assumedUnit,
        assumedCurrency: price.assumedCurrency,
      };
    }
  }

  const result = buildPlan({
    Material,
    Plant,
    Supplier,
    supplierFrom,
    needDate,
    asOf,
    warnings,
    maintained,
    goodsReceiptDays: master?.GoodsReceiptDuration ?? null,
    range: lt,
    history: hist,
    demand,
    price,
  });
  const [MaterialText, PlantName, SupplierName, matSince] = await Promise.all([
    materialText(Material),
    plantName(Plant),
    Supplier ? supplierName(Supplier) : Promise.resolve(null),
    materialSince(Material),
  ]);
  const supSince = Supplier ? earliestSourceDate(pos, irs, Supplier) : null;
  const { masterData, ...rest } = result;
  if (JSON.stringify(await sourceIdentity()) !== JSON.stringify(source))
    throw new PlanningInputError(
      "Imported source changed during planning; calculate again",
    );
  return {
    ...rest,
    sourceText: sourceText(result.source),
    MaterialText,
    PlantName,
    SupplierName,
    materialSince: matSince,
    supplierSince: supSince,
    masterDataDirection: masterData?.direction ?? null,
    masterDataTypicalDays: masterData?.typicalDays ?? null,
    masterDataP80Days: masterData?.p80Days ?? null,
    masterDataGapDays: masterData?.gapDays ?? null,
  };
}

/** Sources (from purchase orders and info records) of a material in a plant, for the supplier value help. */
export async function planningSources(input: {
  Material: string;
  Plant: string;
}): Promise<
  Array<{
    Supplier: string;
    SupplierName: string | null;
    from: string;
    lastDate: string | null;
  }>
> {
  const Material = String(input.Material ?? "").trim();
  const Plant = String(input.Plant ?? "").trim();
  if (!Material || !Plant) return [];
  const callerScope = scopeOf(cds.context?.user ?? {});
  if (
    !callerScope.isAdmin &&
    !callerScope.grants?.some((grant) => grant.Plant === Plant)
  )
    return [];
  const asOf = await currentAsOf();
  const [pos, irs] = await Promise.all([
    orders(Material, Plant, asOf),
    infoRecords(Material, Plant, asOf),
  ]);
  const latest = new Map<string, { from: string; lastDate: string | null }>();
  for (const p of pos) {
    if (!p.Supplier) continue;
    const prev = latest.get(p.Supplier);
    if (!prev || (prev.lastDate ?? "") < p.PurchaseOrderDate)
      latest.set(p.Supplier, {
        from: "latest order",
        lastDate: p.PurchaseOrderDate,
      });
  }
  for (const r of irs) {
    if (!r.Supplier || latest.has(r.Supplier)) continue;
    latest.set(r.Supplier, {
      from: "latest info record",
      lastDate: r.PurchasingDocumentDate ?? null,
    });
  }
  const suppliers = [...latest.keys()];
  const names = await Promise.all(suppliers.map((s) => supplierName(s)));
  return suppliers
    .map((s, i) => ({
      Supplier: s,
      SupplierName: names[i],
      from: latest.get(s)!.from,
      lastDate: latest.get(s)!.lastDate,
    }))
    .sort((a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? ""));
}

/** Calculates all known supplier options on the server so delivery and price use one snapshot. */
export async function compareSuppliers(
  input: Omit<PlanOrderInput, "Supplier">,
) {
  const Material = String(input.Material ?? "").trim();
  const Plant = String(input.Plant ?? "").trim();
  if (!Material || !Plant)
    throw new PlanningInputError("Material and plant are required");
  const asOf = await currentAsOf();
  const generation = await sourceIdentity();
  const pos = await orders(Material, Plant, asOf);
  const reference = pos
    .filter(
      (row) =>
        row.PurchaseOrderQuantityUnit &&
        row.DocumentCurrency &&
        Number(row.OrderQuantity) > 0,
    )
    .sort(
      (first, second) =>
        second.PurchaseOrderDate.localeCompare(first.PurchaseOrderDate) ||
        first.PurchaseOrder.localeCompare(second.PurchaseOrder) ||
        String(first.PurchaseOrderItem ?? "").localeCompare(
          String(second.PurchaseOrderItem ?? ""),
        ),
    )[0];
  const explicit =
    input.quantity != null || input.unit != null || input.currency != null;
  const context = explicit
    ? {
        quantity: input.quantity,
        unit: input.unit,
        currency: input.currency,
      }
    : reference
      ? {
          quantity: Number(reference.OrderQuantity),
          unit: reference.PurchaseOrderQuantityUnit,
          currency: reference.DocumentCurrency,
        }
      : {};
  const sources = await planningSources({ Material, Plant });
  const options = await Promise.all(
    sources.map(async (source) => {
      try {
        if (!explicit && !reference)
          throw new PlanningForecastError(
            "No common quantity, unit and currency context; supply an explicit scenario",
          );
        const result = await planOrder(
          {
            Material,
            Plant,
            Supplier: source.Supplier,
            needDate: input.needDate ?? null,
            ...context,
          },
          serviceRange,
          servicePrice,
          asOf,
        );
        const byQuantile = (quantile: number) =>
          result.rows.find((row) => Math.abs(row.quantile - quantile) < 1e-9);
        const p50 = byQuantile(0.5);
        const p80 = byQuantile(0.8);
        const p90 = byQuantile(0.9);
        return {
          Supplier: source.Supplier,
          SupplierName: source.SupplierName,
          source: source.from,
          forecastSource: result.source,
          error: null,
          p50Date: p50?.earliestDelivery ?? null,
          p80Date: p80?.earliestDelivery ?? null,
          p90Date: p90?.earliestDelivery ?? null,
          p50Reachable: p50?.reachable ?? false,
          p80Reachable: p80?.reachable ?? false,
          p90Reachable: p90?.reachable ?? false,
          priceP10: result.priceP10,
          priceP50: result.priceP50,
          priceP90: result.priceP90,
          priceSource: result.priceSource,
          priceReason: result.priceReason,
          priceTrainingRows: result.priceTrainingRows,
          priceContextScope: result.priceContextScope,
          assumedPriceCurrency: result.assumedPriceCurrency,
          assumedPriceUnit: result.assumedPriceUnit,
          assumedPriceQuantity: result.assumedPriceQuantity,
        };
      } catch (error: any) {
        return {
          Supplier: source.Supplier,
          SupplierName: source.SupplierName,
          source: source.from,
          error: error?.message ?? "Supplier simulation unavailable",
        };
      }
    }),
  );
  if (
    (await currentAsOf()) !== asOf ||
    JSON.stringify(await sourceIdentity()) !== JSON.stringify(generation)
  )
    throw new PlanningInputError(
      "Imported source changed during supplier comparison; calculate again",
    );
  const needDate = input.needDate
    ? String(input.needDate).slice(0, 10)
    : defaultNeedDate(null, null, asOf);
  return { asOf, needDate, options };
}
