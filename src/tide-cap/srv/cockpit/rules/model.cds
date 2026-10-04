namespace tide.cockpit;

using {managed} from '@sap/cds/common';
using {tide.cockpit as c} from '../db';
using {tide.core as core} from '../../../db/core';
using {PurchasingDeskService} from '../../purchasing-desk-service';
using from '../kernel/kernel';
using {tide.s4 as s4} from '../../../db/s4';

@feed
@feed.key    : 'id'
@feed.dataset: 's4'
define view CockpitPlanningFeed as
    select from s4.ProductPlantSupplyPlanning as planning
    inner join s4.Product as product
        on product.Product = planning.Product
    left join s4.ProductPlantProcurement as procurement
        on  procurement.Product = planning.Product
        and procurement.Plant   = planning.Plant
    {
        key planning.Product || '|' || planning.Plant as id : String(80),
            @feed.role: #outcome
            planning.Product                          as Material,
            planning.Plant,
            product.ProductType                       as MaterialType,
            product.ProductGroup                      as MaterialGroup,
            product.BaseUnit,
            procurement.PurchasingGroup,
            @feed.role: #target
            planning.ProcurementType,
            @feed.role: #target
            planning.ProcurementSubType,
            @feed.role: #target
            planning.MRPType,
            @feed.role: #target
            planning.LotSizingProcedure,
            @feed.role: #target
            planning.MRPResponsible
    }
    where
           product.IsMarkedForDeletion =  false
        or product.IsMarkedForDeletion is null;

extend service PurchasingDeskService with {
    type PreventionAssessment {
        assessmentID        : UUID;
        status              : String(20);
        source              : String(20);
        generatedAt         : Timestamp;
        summary             : LargeString;
        metrics             : LargeString;
        expectedFingerprint : String(64);
    }
}

extend PurchasingDeskService.PriceDeviations with columns {
    virtual assessmentJson : LargeString
};

extend PurchasingDeskService.DuplicateMaterials with columns {
    virtual assessmentJson : LargeString
};

extend PurchasingDeskService.UnusualSettings with columns {
    virtual assessmentJson : LargeString
};

extend PurchasingDeskService.SupplierPlannedTimes with columns {
    virtual assessmentJson : LargeString
};

extend PurchasingDeskService.MaterialPlannedTimes with columns {
    virtual assessmentJson : LargeString
};

extend PurchasingDeskService.PriceDeviations with actions {
    action assessPrevention(metric: String, lateDays: Integer, expectedFingerprint: String) returns PurchasingDeskService.PreventionAssessment;
};

extend PurchasingDeskService.DuplicateMaterials with actions {
    action assessPrevention(metric: String, lateDays: Integer, expectedFingerprint: String) returns PurchasingDeskService.PreventionAssessment;
};

extend PurchasingDeskService.UnusualSettings with actions {
    action assessPrevention(metric: String, lateDays: Integer, expectedFingerprint: String) returns PurchasingDeskService.PreventionAssessment;
};

extend PurchasingDeskService.SupplierPlannedTimes with actions {
    action assessPrevention(metric: String, lateDays: Integer, expectedFingerprint: String) returns PurchasingDeskService.PreventionAssessment;
};

extend PurchasingDeskService.MaterialPlannedTimes with actions {
    action assessPrevention(metric: String, lateDays: Integer, expectedFingerprint: String) returns PurchasingDeskService.PreventionAssessment;
};

/** One line of the detail of a rule finding (kind price | member | pair). Writer: rules. */
entity RuleLine {
    key findingID       : String(120);
    key line            : Integer;
        kind            : String(10) enum {
            price;
            member;
            pair;
        };
        /** price: PO/item; member: material; pair: the two fields in buyer words. */
        label           : String(80);
        /** price: currency; member: description; pair: the two values. */
        text            : String(120);
        date            : Date;
        amount          : Double;
        n1              : Integer; // member: POs in 12 months; pair: materials with the first value
        n2              : Integer; // member: movements in 12 months; pair: materials with the second value
        n3              : Integer; // pair: materials with both values (1)
        similarityScore : Double;
        isCurrent       : Boolean; // price: the item of the finding
}

entity OverdueDetail {
    key finding                 : Association to one c.Finding;
        daysOverdue             : Integer;
        overdueCriticality      : Integer;
        confirmationStatus      : String(30);
        confirmationCriticality : Integer;
        netAmount               : Double;
        currency                : String(5);
}

entity PriceDetail {
    key finding             : Association to one c.Finding;
        unitPrice           : Double;
        priorMedian         : Double;
        priorCount          : Integer;
        ratio               : Double;
        factor              : Double;
        direction           : String(10);
        priceKey            : String(120);
        currentPrice        : Double;
        priceQuantity       : Double;
        proposalPrice       : Double;
        potentialDifference : Double;
        currency            : String(5);
}

/** Model assessment stored independently from the retained factor-rule detail. */
entity PriceAssessment : managed {
    key PurchaseOrder             : String(10);
    key PurchaseOrderItem         : String(5);
        expectedP10               : Double;
        expectedP50               : Double;
        expectedP90               : Double;
        actualUnitPrice           : Double;
        historicalMedian          : Double;
        historicalCount           : Integer;
        deviationPercent          : Double;
        tailPosition              : Double;
        alert                     : Boolean;
        source                    : String(20);
        fallbackReason            : String(200);
        backend                   : String(40);
        predictionContractVersion : String(40);
        run                       : Association to core.PredictionRun;
        inputFingerprint          : String(64);
        computedAt                : Timestamp;
        asOf                      : Date;
        trainingRows              : Integer;
        contextScope              : String(200);
        /** JSON quantile levels returned for this regression assessment. */
        rangeLevels               : LargeString;
        validationPeriod          : String(40);
        validation                : Association to one PriceModelValidation;
        /** The record is informative until a time-separated validation is linked. */
        calibrationStatus         : String(20) default 'uncalibrated';
}

/** Time-separated assessment quality; alerts are calibrated only when this exists. */
entity PriceModelValidation : managed {
    key ID                  : String(80);
        contractVersion     : String(40);
        calibrationFrom     : Date;
        calibrationTo       : Date;
        holdoutFrom         : Date;
        holdoutTo           : Date;
        trainingRows        : Integer;
        validationRows      : Integer;
        observedCoverage    : Double;
        medianMae           : Double;
        baselineMae         : Double;
        ordinaryAlertRate   : Double;
        injectedErrorRecall : Double;
        threshold           : Double;
}

entity PurchasePriceEstimate {
    key id     : String(80);
        asOf   : Date;
        result : LargeString;
}

/** Portable materialized source; logarithmic target is calculated in TypeScript. */
entity PriceModelRow {
    key id                     : String(80);
        /** source rows are synchronized from S/4; estimate rows live only until Core snapshots them. */
        rowKind                : String(12) default 'source';
        PurchaseOrder          : String(10);
        PurchaseOrderItem      : String(5);
        PurchaseOrderDate      : Date;
        Material               : String(40);
        MaterialGroup          : String(9);
        MaterialType           : String(4);
        Supplier               : String(10);
        Plant                  : String(4);
        PurchasingOrganization : String(4);
        PurchasingGroup        : String(3);
        OrderQuantity          : Double;
        OrderUnit              : String(3);
        Currency               : String(5);
        DateOffsetDays         : Integer;
        PurchaseOrderMonth     : Integer;
        LogUnitPrice           : Double;
}

@feed
@feed.key    : 'id'
@feed.dataset: 's4'
define view CockpitPriceFeed as
    select from PriceModelRow {
        key id,
            Material,
            MaterialGroup,
            MaterialType,
            Supplier,
            Plant,
            PurchasingOrganization,
            OrderQuantity,
            OrderUnit,
            DateOffsetDays,
            PurchaseOrderMonth,
            @feed.role: #outcome
            PurchasingGroup,
            @feed.role: #outcome
            PurchaseOrder,
            @feed.role: #outcome
            PurchaseOrderDate,
            @feed.role: #outcome
            Currency,
            @feed.role: #target
            LogUnitPrice
    };

entity DuplicateDetail {
    key finding         : Association to one c.Finding;
        groupKey        : String(120);
        activity        : Integer;
        candidateCount  : Integer;
        materialType    : String(20);
        materialNumbers : String(500);
        mainPlant       : String(4);
        purchasingGroup : String(3);
}

entity RareDetail {
    key finding          : Association to one c.Finding;
        groupSize        : Integer;
        materialType     : String(20);
        unusualPairCount : Integer;
        firstPair        : String(200);
}

extend service PurchasingDeskService with {
    @readonly
    entity RuleLines        as projection on RuleLine;

    @readonly
    entity OverdueDetails   as projection on OverdueDetail;

    @readonly
    entity PriceDetails     as projection on PriceDetail;

    @readonly
    entity PriceAssessments as projection on PriceAssessment;

    @readonly
    entity DuplicateDetails as projection on DuplicateDetail;

    @readonly
    entity RareDetails      as projection on RareDetail;

    /** Exact totals for the five Prevention worklists. */
    type PreventionSummary {
        price      : Integer;
        duplicates : Integer;
        unusual    : Integer;
        supplier   : Integer;
        material   : Integer;
    }

    function preventionSummary()               returns PreventionSummary;

    type PurchasePriceEstimate {
        p10                 : Double;
        p50                 : Double;
        p90                 : Double;
        historicalReference : Double;
        historicalCount     : Integer;
        source              : String(20);
        reason              : String(200);
        assumedQuantity     : Double;
        assumedUnit         : String(3);
        assumedCurrency     : String(5);
        backend             : String(40);
        runID               : UUID;
        inputFingerprint    : String(64);
        computedAt          : Timestamp;
        trainingRows        : Integer;
        contextScope        : String(200);
    }

    function estimatePurchasePrice(Material: String,
                                   Plant: String,
                                   Supplier: String,
                                   quantity: Double,
                                   unit: String,
                                   currency: String,
                                   asOf: Date) returns PurchasePriceEstimate;
}

extend PurchasingDeskService.Findings with columns {
    overdueDetail   : Association to one PurchasingDeskService.OverdueDetails
                          on overdueDetail.finding = $self,
    priceDetail     : Association to one PurchasingDeskService.PriceDetails
                          on priceDetail.finding = $self,
    duplicateDetail : Association to one PurchasingDeskService.DuplicateDetails
                          on duplicateDetail.finding = $self,
    rareDetail      : Association to one PurchasingDeskService.RareDetails
                          on rareDetail.finding = $self
};
