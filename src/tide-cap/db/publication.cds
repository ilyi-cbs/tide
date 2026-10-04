namespace tide.cockpit;

using {cuid} from '@sap/cds/common';

/** One prepareDay run: the snapshot every other row belongs to. */
entity Snapshot : cuid {
    asOf             : Date;
    datasetName      : String;
    loadId           : String(36);
    sourceLoadedAt   : Timestamp;
    source           : String(30);
    policyVersion    : String(80);
    publishedAt      : Timestamp;
    completeness     : String(20);
    workerToken      : UUID;
    observationType  : String(20);
    status           : String(12) enum {
        running;
        done;
        failed;
    };
    startedAt        : Timestamp;
    finishedAt       : Timestamp;
    backend          : String(20);
    modelCalls       : Integer default 0;
    costUnits        : Double default 0;
    runs             : LargeString; // JSON array of prediction run IDs
    message          : String;
    openItems        : Integer;
    atRisk           : Integer;
    late             : Integer;
    overdue          : Integer;
    revenueAtRiskP50 : Double;
    revenueAtRiskP80 : Double;
    sourcesToFix     : Integer;
    currency         : String(5);
    /** Sources (material x supplier x plant) whose range was reused from the prior run (fingerprint unchanged, no model call). */
    rangesReused     : Integer default 0;
    /** Sources whose range was freshly computed (TabPFN called or empirical fallback) this run. */
    rangesComputed   : Integer default 0;
    /** Open items with no sales-order link at all (no direct account assignment, no FIFO match): revenueAtRisk is structurally 0 for these. */
    itemsWithoutLink : Integer default 0;
    /** Open items whose promised demand came from the direct PO-to-SalesOrder account assignment (third-party/MTO chain). */
    itemsDirectLink  : Integer default 0;
    /** Open items whose promised demand came from the FIFO upper_bound heuristic (stock items matched by material+plant). */
    itemsUpperBound  : Integer default 0;
}

entity PreparationPhase {
    key snapshot   : Association to Snapshot;
    key name       : String(40);
        required   : Boolean;
        status     : String(20);
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : LargeString;
}

entity PublishedCockpit {
    key ID          : String(20);
        snapshot    : Association to Snapshot;
        publishedAt : Timestamp;
}

@insertonly
entity CaseObservation {
    key snapshot        : Association to Snapshot;
    key caseID          : String(160);
        kind            : String(40);
        status          : String(20);
        listing         : String(20);
        priority        : Integer;
        sourceRevision  : Integer;
        sourceFingerprint : String(64);
        Plant           : String(4);
        PurchasingGroup : String(3);
        observedAt      : Timestamp;
}

@insertonly
entity ExposureObservation {
    key snapshot          : Association to Snapshot;
    key caseID            : String(160);
    key SalesOrder        : String(10);
    key SalesOrderItem    : String(6);
        Plant             : String(4);
        PurchasingGroup   : String(3);
        revenueAtRisk     : Double;
        currency          : String(5);
        valuationStatus   : String(20);
}

entity CustomerRisk {
    key Customer         : String(10);
        CustomerName     : String(80);
        snapshot         : Association to Snapshot;
        revenueAtRiskP50 : Double;
        revenueAtRiskP80 : Double;
        openAmount       : Double;
        items            : Integer;
        salesItems       : Integer;
        worstDelayDays   : Integer;
        directShare      : Double;
}
