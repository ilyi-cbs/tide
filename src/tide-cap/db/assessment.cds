namespace tide.cockpit;

using {managed} from '@sap/cds/common';
using {tide.core as core} from './core';
using {tide.cockpit.Snapshot} from './publication';

@insertonly
entity PreventionAssessment : managed {
    key assessmentID        : UUID;
        caseID              : String(120);
        metric              : String(20);
        status              : String(20);
        source              : String(20);
        generatedAt         : Timestamp;
        summary             : LargeString;
        metrics             : LargeString;
        expectedFingerprint : String(64);
        baseFingerprint     : String(64);
        schemaVersion       : Integer;
        policyVersion       : String(80);
        sourceAsOf          : Date;
        sourceLoadId        : String(36);
        sourceLoadedAt      : Timestamp;
        sourceRevision      : Integer;
        sourceFingerprint   : String(64);
        run                 : Association to core.PredictionRun;
        runs                : LargeString;
        payloadHash         : String(64);
}

entity AssessmentApplicability : managed {
    key assessment          : Association to PreventionAssessment not null;
        caseID              : String(120);
        expectedFingerprint : String(64);
        baseFingerprint     : String(64);
}

type Source     : String(10) enum {
    rule;
    lookup;
    empirical;
    tabpfn;
    fallback;
    none;
}

type ItemStatus : String(12) enum {
    on_time;
    at_risk;
    late;
    overdue;
    no_estimate;
}

type PdtVerdict : String(20) enum {
    not_maintained;
    default;
    placeholder;
    below_range;
    above_range;
    within_range;
    no_range;
}

type ImpactLink : String(12) enum {
    direct;
    upper_bound;
}

entity FindingStatus {
    key code : String(10);
        text : String(40);
}

entity FindingType {
    key code : String(30);
        text : String(40);
}

entity SourceRange {
    key Material     : String(40);
    key Supplier     : String(10);
    key Plant        : String(4);
        snapshot     : Association to Snapshot;
        source       : Source;
        nOwn         : Integer;
        contextLevel : String(40);
        contextRows  : Integer;
        p10          : Double;
        p50          : Double;
        p80          : Double;
        p90          : Double;
        quantiles    : LargeString;
        run          : Association to core.PredictionRun;
        fingerprint  : String(64);
        reusedAt     : Timestamp;
        ownP10       : Double;
        ownP50       : Double;
        ownP80       : Double;
        ownP90       : Double;
        ownQuantiles : LargeString;
        agreement    : String(10) enum {
            aligned;
            divergent;
        };
}

entity OpenItem {
    key PurchaseOrder     : String(10);
    key PurchaseOrderItem : String(5);
        snapshot          : Association to Snapshot;
        Material          : String(40);
        MaterialText      : String(40);
        Supplier          : String(10);
        SupplierName      : String(80);
        Plant             : String(4);
        PurchasingGroup   : String(3);
        MRPController     : String(3);
        PurchaseOrderDate : Date;
        RequestedDate     : Date;
        OpenQuantity      : Double;
        OrderQuantity     : Double;
        Unit              : String(3);
        NetAmount         : Double;
        Currency          : String(5);
        category          : String(12) enum {
            stock;
            third_party;
            consumable;
        };
        plannedDays       : Double;
        plannedFrom       : String(20);
        pdtVerdict        : PdtVerdict;
        requestedGapDays  : Integer;
        ageDays           : Integer;
        expectedP10       : Date;
        expectedP50       : Date;
        expectedP80       : Date;
        expectedP90       : Date;
        delayP50Days      : Integer;
        delayP80Days      : Integer;
        status            : ItemStatus;
        statusCriticality : Integer;
        source            : Source;
        reason            : String(300);
        revenueAtRiskP50  : Double;
        revenueAtRiskP80  : Double;
        customers         : Integer;
        customerNames     : String(300);
        impactLink        : ImpactLink;
        priority          : Integer;
        sourceRange       : Association to SourceRange
                                on  sourceRange.Material = $self.Material
                                and sourceRange.Supplier = $self.Supplier
                                and sourceRange.Plant    = $self.Plant;
        impacts           : Composition of many CustomerImpact
                                on  impacts.PurchaseOrder     = $self.PurchaseOrder
                                and impacts.PurchaseOrderItem = $self.PurchaseOrderItem;
}

entity CustomerImpact {
    key PurchaseOrder     : String(10);
    key PurchaseOrderItem : String(5);
    key SalesOrder        : String(10);
    key SalesOrderItem    : String(6);
        Customer          : String(10);
        CustomerName      : String(80);
        Product           : String(40);
        promisedDate      : Date;
        openAmount        : Double;
        link              : ImpactLink;
        atRiskP50         : Boolean;
        atRiskP80         : Boolean;
}

entity SourceFinding {
    key Material             : String(40);
    key Supplier             : String(10);
    key Plant                : String(4);
        snapshot             : Association to Snapshot;
        MaterialText         : String(40);
        SupplierName         : String(80);
        PurchasingGroup      : String(3);
        MRPController        : String(3);
        PurchasingInfoRecord : String(10);
        infoRecordDays       : Double;
        masterDays           : Double;
        currentDays          : Double;
        currentFrom          : String(20);
        verdict              : PdtVerdict;
        verdictCriticality   : Integer;
        source               : Source;
        nOwn                 : Integer;
        p10                  : Double;
        p50                  : Double;
        p90                  : Double;
        proposalDays         : Integer;
        proposalQuantile     : Double;
        proposalSource       : Source;
        poCount12m           : Integer;
        poValue12m           : Double;
        openItems            : Integer;
        openRevenueAtRiskP80 : Double;
        priority             : Integer;
        tier                 : Integer;
        reason               : String(300);
        range                : Association to SourceRange
                                   on  range.Material = $self.Material
                                   and range.Supplier = $self.Supplier
                                   and range.Plant    = $self.Plant;
        backtest             : Composition of many SourceBacktest
                                   on  backtest.Material = $self.Material
                                   and backtest.Supplier = $self.Supplier
                                   and backtest.Plant    = $self.Plant;
}

entity SourceBacktest {
    key Material       : String(40);
    key Supplier       : String(10);
    key Plant          : String(4);
    key quantile       : Double;
        label          : String(20);
        proposalDays   : Integer;
        shareLateAbove : Double;
        meanBufferDays : Double;
        meanDaysLate   : Double;
        nOlder         : Integer;
        nLater         : Integer;
}

entity ProofResult {
    key method        : String(20);
    key bucket        : String(12);
        snapshot      : Association to Snapshot;
        label         : String(60);
        n             : Integer;
        mae           : Double;
        coverage      : Double;
        lateCaught    : Double;
        lateTotal     : Integer;
        /** Sampled rows left out because some method had no estimate (paired scoring). */
        excluded      : Integer;
        cutoff        : Date;
        evaluatedFrom : Date;
        evaluatedTo   : Date;
        source        : Source;
}

/** Materialized current-dataset facts, rebuilt by prepareDay. */
entity ItemFact {
    key PurchaseOrder        : String(10);
    key PurchaseOrderItem    : String(5);
        Material             : String(40);
        MaterialGroup        : String(9);
        MaterialType         : String(4);
        Plant                : String(4);
        Supplier             : String(10);
        SupplierCountry      : String(3);
        PurchasingGroup      : String(3);
        MRPController        : String(3);
        PurchaseOrderType    : String(4);
        Category             : String(12);
        OrderQuantity        : Double;
        Unit                 : String(3);
        NetAmount            : Double;
        Currency             : String(5);
        NetAmountEUR         : Double;
        PlannedDays          : Double;
        GRDays               : Double;
        PurchasingInfoRecord : String(10);
        PurchaseOrderDate    : Date;
        PurchaseOrderMonth   : Integer;
        RequestedDate        : Date;
        RequestedGapDays     : Integer;
        ArrivalDate          : Date;
        AvailableDate        : Date;
        LeadTimeDays         : Integer;
        ArrivalDays          : Integer;
        ReceivedQuantity     : Double;
        TwoStep              : Integer;
        OpenQuantity         : Double;
        IsOpen               : Boolean;
        PartialFirstReceipt  : Boolean;
}
