using {CockpitMcpService} from '../cockpit-mcp-service';
using {tide.cockpit as c} from './db';
using from './kernel/kernel';

// Cockpit chat tools (app `cockpit`), implemented in ./mcp.ts. Functions are
// read tools; actions need the user's consent in the chat. No approve, reject
// or send tool exists.
extend service CockpitMcpService with {
    type CockpitCount {
        list    : String;
        text    : String;
        meaning : String;
        count   : Integer;
    }

    /** A default-work-list summary. Typed details are loaded with get_case. */
    type CockpitCaseWork {
        caseID         : String;
        kind           : String;
        attention      : String;
        title          : String;
        typedEntitySet : String;
        typedKey       : String;
        link           : String;
    }

    type CockpitCaseWorkList {
        source : String;
        total  : Integer;
        cases  : many CockpitCaseWork;
    }

    /** Typed case detail. Only fields applicable to the case kind are populated. */
    type CockpitCaseDetail {
        caseID            : String;
        kind              : String;
        status            : String;
        listing           : String;
        attention         : String;
        sourceRevision    : Integer;
        modifiedAt        : Timestamp;
        sourceFingerprint : String(64);
        sourceChanged     : Boolean;
        evidence          : LargeString;
        link              : String;
        closure           : String;
        typedEntitySet    : String;
        typedKey          : String;
        phase             : String;
        PurchaseOrder     : String;
        PurchaseOrderItem : String;
        Material          : String;
        Supplier          : String;
        Plant             : String;
        PurchasingGroup   : String;
        dueDate           : Date;
        predictedArrival  : Date;
        revenueAtRisk     : Double;
        nextActionKind    : String;
        /** Why the case is listed, in plain words. */
        issue             : String;
        steps             : many String;
        nextStep          : String;
        /** Suppliers behind a material planned-time case. */
        materialSources   : many CockpitMaterialSource;
        actions           : many CockpitPublicAction;
    }

    type CockpitToday {
        source          : String;
        asOf            : Date;
        preparedAt      : Timestamp;
        user            : String;
        PurchasingGroup : String;
        Plant           : String;
        lists           : many CockpitCount;
        pendingActions  : Integer;
        kpis            : CockpitKpis;
        dayLines        : many CockpitDayLine;
        note            : String;
    }

    /** A Finding in buyer words (contract §3), expert fields removed. */
    type CockpitRow {
        ID                      : String;
        rank                    : Integer;
        list                    : String;
        listText                : String;
        objectKey               : String;
        PurchaseOrder           : String;
        PurchaseOrderItem       : String;
        PurchaseRequisition     : String;
        PurchaseRequisitionItem : String;
        Material                : String;
        Supplier                : String;
        Plant                   : String;
        PurchasingGroup         : String;
        freetextText            : String;
        freetextCodes           : String;
        itemTitle               : String;
        itemSubtitle            : String;
        issue                   : String;
        impactLevel             : String;
        impactText              : String;
        revenueAtRisk           : Double;
        dueDate                 : Date;
        nextStep                : String;
        nextActionKind          : String;
        source                  : String;
        sourceText              : String;
        chain                   : String;
        status                  : String;
        trigger                 : String;
        link                    : String;
    }

    type CockpitImpact {
        level             : String;
        impactText        : String;
        materialKind      : String;
        expectedDate      : Date;
        cautiousDate      : Date;
        confirmedDate     : Date;
        needDate          : Date;
        delayDays         : Integer;
        customerDelayDays : Integer;
        revenueAtRisk     : Double;
        shortageFrom      : Date;
        shortageDays      : Integer;
        coverageDays      : Double;
        productionOrders  : Integer;
        salesOrders       : Integer;
        customers         : many String;
        note              : String;
        source            : String;
    }

    type CockpitGrid {
        source      : String;
        sourceText  : String;
        nOwn        : Integer;
        p10         : Double;
        p50         : Double;
        p80         : Double;
        p90         : Double;
        plannedDays : Double;
    }

    /** List-specific facts of a row, in buyer words (only the fields of its list are set). */
    type CockpitRowFacts {
        daysOverdue       : Integer;
        workingDays       : Integer;
        PurchaseOrderDate : Date;
        unitPrice         : Double;
        usualPrice        : Double;
        nPrior            : Integer;
        direction         : String;
        members           : many String;
        activity          : Integer;
        groupSize         : Integer;
        currentDays       : Double;
        currentFrom       : String;
        proposalDays      : Integer;
        masterDays        : Double;
        nOwn              : Integer;
        orders            : Integer;
        rule              : String;
        text              : String;
        date              : Date;
    }

    type CockpitConfirmation {
        date     : Date;
        quantity : Double;
        origin   : String;
    }

    /** A detail line of a rule row: price history, duplicate member or rare setting. */
    type CockpitRuleLine {
        label               : String;
        text                : String;
        date                : Date;
        amount              : Double;
        currency            : String;
        isCurrent           : Boolean;
        orders              : Integer;
        movements           : Integer;
        materialsWithFirst  : Integer;
        materialsWithSecond : Integer;
        materialsWithBoth   : Integer;
    }

    /** One supplier source of a material master row (mm_pdt). */
    type CockpitMaterialSource {
        Supplier       : String;
        SupplierName   : String;
        orders         : Integer;
        orderShare     : Double;
        nOwn           : Integer;
        typicalDays    : Double;
        infoRecordDays : Double;
        source         : String;
        sourceText     : String;
        link           : String;
    }

    type CockpitRowCode {
        field       : String;
        fieldText   : String;
        value       : String;
        status      : String;
        statusText  : String;
        similarSame : String;
        source      : String;
        sourceText  : String;
    }

    type CockpitRowDetail {
        row           : CockpitRow;
        facts         : CockpitRowFacts;
        confirmations : many CockpitConfirmation;
        lines         : many CockpitRuleLine;
        sources       : many CockpitMaterialSource;
        codes         : many CockpitRowCode;
        impact        : CockpitImpact;
        grid          : CockpitGrid;
        events        : many String;
        actions       : many String;
        recomputable  : Boolean;
    }

    type CockpitPriorityRow {
        rank              : Integer;
        ID                : String;
        PurchaseOrder     : String;
        PurchaseOrderItem : String;
        Material          : String;
        Supplier          : String;
        Plant             : String;
        itemTitle         : String;
        impactLevel       : String;
        impactText        : String;
        revenueAtRisk     : Double;
        currency          : String;
        expectedDate      : Date;
        needDate          : Date;
        delayDays         : Integer;
        shortageDays      : Integer;
        productionOrders  : Integer;
        customers         : many String;
        link              : String;
    }

    type CockpitPriorities {
        source       : String;
        sourceText   : String;
        order        : String;
        atRiskTotal  : Integer;
        bySeverity   : many CockpitCount;
        revenueTotal : Double;
        currency     : String;
        rows         : many CockpitPriorityRow;
        note         : String;
    }

    type CockpitLeadTimeRange {
        Material     : String;
        Supplier     : String;
        Plant        : String;
        source       : String;
        sourceText   : String;
        n            : Integer;
        p10          : Double;
        p50          : Double;
        p80          : Double;
        p90          : Double;
        sentence     : String;
        contextLevel : String;
        warnings     : many String;
    }

    type CockpitCode {
        field  : String;
        value  : String;
        text   : String;
        status : String;
        source : String;
    }

    type CockpitCodes {
        source : String;
        fields : many CockpitCode;
    }

    type CockpitThreshold {
        threshold      : Double;
        prefilledShare : Double;
        accuracy       : Double;
        low            : Double;
        high           : Double;
        n              : Integer;
        isStored       : Boolean;
    }

    type CockpitThresholds {
        source  : String;
        field   : String;
        segment : String;
        rows    : many CockpitThreshold;
    }

    type CockpitBuffer {
        quantile       : Double;
        label          : String;
        proposalDays   : Integer;
        lateShare      : Double;
        meanBufferDays : Double;
        meanDaysLate   : Double;
        nOlder         : Integer;
        nLater         : Integer;
        isCurrent      : Boolean;
    }

    type CockpitBuffers {
        source   : String;
        Material : String;
        Supplier : String;
        Plant    : String;
        rows     : many CockpitBuffer;
    }

    type CockpitPlanRow {
        quantile         : Double;
        leadTimeDays     : Double;
        latestOrderDate  : Date;
        earliestDelivery : Date;
        reachable        : Boolean;
        safetyDays       : Double;
        within           : Integer;
        ![of]            : Integer;
        safetyStock      : Double;
        safetyStockValue : Double;
    }

    type CockpitPlan {
        Material     : String;
        Plant        : String;
        Supplier     : String;
        supplierFrom : String;
        needDate     : Date;
        asOf         : Date;
        source       : String;
        sourceText   : String;
        n            : Integer;
        plannedDays  : Double;
        plannedFrom  : String;
        sapOrderDate : Date;
        sapLateDays  : Integer;
        warnings     : many String;
        dailyDemand  : Double;
        unit         : String;
        unitPrice    : Double;
        currency     : String;
        rows         : many CockpitPlanRow;
    }

    type CockpitActionLine {
        line      : Integer;
        objectKey : String;
        field     : String;
        oldValue  : String;
        newValue  : String;
        text      : String;
    }

    /** Public view of a prepared action. */
    type CockpitPublicAction {
        ID          : UUID;
        caseID      : String;
        kind        : String;
        status      : String;
        objectKey   : String;
        title       : String;
        summary     : String;
        preparedVia : String;
        findingID   : String;
        createdAt   : Timestamp;
        items       : many CockpitActionLine;
        link        : String;
        ![where]    : String;
    }

    type CockpitPending {
        source  : String;
        total   : Integer;
        pending : many CockpitPublicAction;
        note    : String;
    }

    type CockpitSimilarRequest {
        rank                    : Integer;
        PurchaseRequisition     : String;
        PurchaseRequisitionItem : String;
        text                    : String;
        MaterialGroup           : String;
        PurchasingGroup         : String;
        Supplier                : String;
    }

    type CockpitKpis {
        atRisk           : Integer;
        revenueAtRisk    : Double;
        codesPrefilled   : Integer;
        codesTotal       : Integer;
        pdtFindings      : Integer;
        pendingApprovals : Integer;
        currency         : String;
    }

    type CockpitDayLine {
        ![key]   : String;
        text     : String;
        count    : Integer;
        amount   : Double;
        list     : String;
        listText : String;
    }

    type CockpitOverview {
        source     : String;
        sourceText : String;
        asOf       : Date;
        kpis       : CockpitKpis;
        dayLines   : many CockpitDayLine;
    }

    type CockpitPredictKey {
        material : String not null;
        supplier : String not null;
        plant    : String not null;
    }

    type CockpitPredictFilters {
        buyer           : String;
        purchasingGroup : String;
        plant           : String;
        supplier        : String;
        /** domestic | eu | overseas */
        supplierRegion  : String;
        materialType    : String;
        materialGroup   : String;
        /** YYYY-MM-DD */
        poDateFrom      : String;
        /** YYYY-MM-DD */
        poDateTo        : String;
    }

    type CockpitPredictRow {
        rank              : Integer;
        PurchaseOrder     : String;
        PurchaseOrderItem : String;
        Material          : String;
        Supplier          : String;
        SupplierRegion    : String;
        PurchasingGroup   : String;
        PurchaseOrderDate : Date;
        RequestedDate     : Date;
        p10Days           : Double;
        p50Days           : Double;
        p90Days           : Double;
        link              : String;
    }

    type CockpitPredictResult {
        ID           : UUID;
        source       : String;
        target       : String;
        targetText   : String;
        lateDays     : Integer;
        filters      : LargeString;
        realityCheck : String;
        /** pass | fail | too little */
        verdict      : String;
        answer       : String;
        evaluated    : Integer;
        notEvaluated : String;
        openItems    : Integer;
        alreadyLate  : Integer;
        rowsInCard   : Integer;
        rowsShown    : Integer;
        rows         : many CockpitPredictRow;
        warnings     : many String;
        /** JSON of the results card (the chat shows it; the model does not see it). */
        card         : LargeString;
    }

    // ------------------------------------------------------------ tools

    /** Today at a glance for the buyer's scope: as-of date of the morning run, open rows per list, pending approvals, key figures and the day's lines. No model call */
    function get_today()                                            returns CockpitToday;

    /** Open, listed cases in the buyer's scope, most urgent first (first rows only; the result says how many). No model call */
    function list_cases(
                        /** delivery | price | duplicate | unusual_setting | supplier_planned_time | material_planned_time | requisition_review */
                        kind: String,
                        plant: String,
                        purchasingGroup: String,
                        /** Matches any part of the case ID or title, e.g. a material, supplier or PO number. */
                        search: String)                             returns CockpitCaseWorkList;

    /** Complete current detail of one case from list_cases: evidence, why it is listed, linked actions, and the version (modifiedAt, sourceFingerprint) needed to prepare an action. No model call */
    function get_case(caseID: String not null)                      returns CockpitCaseDetail;

    /** The deliveries at risk that matter most: impact severity, then revenue at risk, then affected production orders and shortage days, then delay. Each row names the customers. Calculated from the stock and requirements list, no model call */
    function list_priorities(
                             /** Number of rows (default and maximum: the tool's row limit). */
                             limit: Integer,
                             plant: String,
                             purchasingGroup: String)               returns CockpitPriorities;

    /** Delivery time range in days for a material, supplier and plant: own past deliveries when there are enough, otherwise an AI estimate */
    function get_lead_time_range(Material: String not null,
                                 Plant: String not null,
                                 Supplier: String)                  returns CockpitLeadTimeRange;

    /** Latest order date and buffer for a material that must be available on needDate (YYYY-MM-DD); supplier defaults to the source of the latest PO */
    function plan_order(Material: String not null,
                        Plant: String not null,
                        needDate: Date not null,
                        Supplier: String)                           returns CockpitPlan;

    /** Material group and purchasing group for a free-text purchase requisition item, proposed from similar coded items, with the status its threshold gives (prefilled, review) */
    function propose_freetext_codes(text: String not null,
                                    Plant: String not null,
                                    PurchasingOrganization: String,
                                    PurchaseOrderType: String)      returns CockpitCodes;

    /** For a free-text code field (MaterialGroup, PurchasingGroup) and segment: the share prefilled and the accuracy of the prefilled codes per threshold */
    function simulate_thresholds(field: String not null,
                                 segment: String)                   returns CockpitThresholds;

    /** For a source (material, supplier, plant): per planned delivery time proposal, how many later own deliveries were late with it. Historical view */
    function simulate_planned_delivery_time(Material: String not null,
                                            Supplier: String not null,
                                            Plant: String not null) returns CockpitBuffers;

    /** Actions waiting for a person's decision in Approvals. Nothing is written to SAP */
    function list_pending_actions()                                 returns CockpitPending;

    /** Checked summary of a requisition_review case with the exact expectedModifiedAt and expectedReviewToken to submit */
    function get_review_summary(caseID: String(160) not null)       returns LargeString;

    /** Prediction on request for open PO items, checked on recent weeks first. target: late_by_days (needs lateDays), lead_time_days (optional key: all of material, supplier and plant, taken from rows already looked up; otherwise ask the user), partial_delivery. Scores are not calibrated probabilities */
    @assistant.action
    action   predict_orders(target: String not null,
                            lateDays: Integer,
                            key: CockpitPredictKey,
                            filters: CockpitPredictFilters)         returns CockpitPredictResult;

    /** Prepares the case's next action for a decision in Approvals, guarded by the version from get_case. Price cases need responsiblePerson and responsibleMessage; supplier_planned_time cases may take days */
    @assistant.action
    action   prepare_case_action(caseID: String(160) not null,
                                 expectedModifiedAt: Timestamp not null,
                                 expectedFingerprint: String(64) not null,
                                 responsiblePerson: String(255),
                                 responsibleMessage: String(2000),
                                 days: Integer,
                                 /** Idempotency key; the same key with the same arguments returns the same result. */
                                 commandID: String(128) not null)   returns CockpitMcpService.WorkflowCommandResult;

    /** Submits the exact summary from get_review_summary for approval; it does not approve the requisition */
    @assistant.action
    action   submit_review(caseID: String(160) not null,
                           expectedModifiedAt: Timestamp not null,
                           expectedReviewToken: String(64) not null,
                           /** Idempotency key; the same key with the same arguments returns the same result. */
                           commandID: String(128) not null)         returns CockpitMcpService.WorkflowCommandResult;
}
