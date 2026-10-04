namespace tide.cockpit;

using {managed} from '@sap/cds/common';
using {tide.s4 as s4} from '../../../db/s4';
using {tide.cockpit as c} from '../db';
using {PurchasingDeskService} from '../../purchasing-desk-service';
using from '../kernel/kernel';

/**
 * Free-text requisition items (no material) of the loaded dataset at the
 * as-of date, rewritten by the morning step. Codes (material group,
 * purchasing group, supplier) are the buyer's final codes from the purchase
 * order the item was converted into before the as-of date; open items have
 * none. `isQuery` rows are transient inputs of proposeCodes.
 */
entity FreetextItem {
    key id                              : String(40); // PR/item, or Q/<uuid> for a query
        PurchaseRequisition             : String(10);
        PurchaseRequisitionItem         : String(5);
        text                            : String(255);
        Plant                           : String(4);
        PurchasingOrganization          : String(4);
        PurchaseOrderType               : String(4);
        date                            : Date; // requisition creation date
        labelDate                       : Date; // final PO label availability date
        DeliveryDate                    : Date;
        MaterialGroup                   : String(9);
        PurchasingGroup                 : String(3);
        Supplier                        : String(10);
        Material                        : String(40);
        PurchasingInfoRecord            : String(10);
        sourceMaterial                  : String(40);
        sourcePurchasingInfoRecord      : String(10);
        RequestedQuantity               : Double;
        BaseUnit                        : String(3);
        CompanyCode                     : String(4);
        PurchaseRequisitionPrice        : Double;
        PurReqnPriceQuantity            : Double;
        PurReqnItemCurrency             : String(5);
        RequestedLeadTimeDays           : Double;
        StorageLocation                 : String(4);
        itemLongText                    : LargeString;
        headerNote                      : LargeString;
        sourceMaterialGroup             : String(9);
        sourcePurchasingGroup           : String(3);
        sourceSupplier                  : String(10);
        sourceAccountAssignmentCategory : String(1);
        sourceItemCategory              : String(1);
        accountingContext               : LargeString;
        AccountAssignmentCategory       : String(1);
        PurchasingDocumentItemCategory  : String(1);
        isOpen                          : Boolean default false;
        isQuery                         : Boolean default false;
        /** Display routing (P-14): the buyer whose inbox shows the request, null = none. */
        routedBuyer                     : String(80);
        routedGroup                     : String(3);
        /** Demo seed: a labelled item shown as an arrived request, its codes hidden (data.ts). */
        demo                            : Boolean default false;
}

/**
 * Model feed of the free-text codes: text column plus plant, purchasing
 * organisation and PO type; one classification per field.
 */
@feed
@feed.key    : 'id'
@feed.dataset: 's4'
define view CockpitFreetextFeed as
    select from FreetextItem {
        key id,
            Plant,
            PurchasingOrganization,
            PurchaseOrderType,
            RequestedQuantity,
            BaseUnit,
            CompanyCode,
            PurchaseRequisitionPrice,
            PurReqnPriceQuantity,
            PurReqnItemCurrency,
            RequestedLeadTimeDays,
            StorageLocation,
            sourceMaterialGroup,
            sourcePurchasingGroup,
            sourceSupplier,
            sourcePurchasingInfoRecord,
            sourceAccountAssignmentCategory,
            sourceItemCategory,
            @feed.kind: 'text'
            accountingContext,
            @feed.kind: 'text'
            itemLongText,
            @feed.kind: 'text'
            headerNote,
            @feed.kind: 'text'
            text,
            @feed.role: #outcome
            date,
            @feed.role: #outcome
            labelDate,
            @feed.role: #target
            MaterialGroup,
            @feed.role: #target
            PurchasingGroup,
            @feed.role: #target
            Supplier,
            @feed.role: #target
            PurchasingInfoRecord,
            @feed.role: #target
            AccountAssignmentCategory,
            @feed.role: #target
            PurchasingDocumentItemCategory,
            @feed.role: #outcome
            routedBuyer,
            @feed.role: #outcome
            routedGroup
    };

entity FreetextAllocationItem {
    key id                        : String(64);
        PurchaseRequisition       : String(10);
        PurchaseRequisitionItem   : String(5);
        text                      : String(255);
        Plant                     : String(4);
        CompanyCode               : String(4);
        PurchasingOrganization    : String(4);
        AccountAssignmentCategory : String(1);
        RequestedQuantity         : Double;
        BaseUnit                  : String(3);
        AllocationCount           : Integer;
        AssignedQuantity          : Double;
        DistributionPercent       : Double;
        sourceGLAccount           : String(10);
        sourceCostCenter          : String(10);
        GLAccount                 : String(10);
        CostCenter                : String(10);
}

@feed
@feed.key    : 'id'
@feed.dataset: 's4'
define view CockpitAllocationFeed as
    select from FreetextAllocationItem {
        key id,
            @feed.role: #outcome
            PurchaseRequisition,
            @feed.role: #outcome
            PurchaseRequisitionItem,
            @feed.kind: 'text'
            text,
            Plant,
            CompanyCode,
            PurchasingOrganization,
            AccountAssignmentCategory,
            RequestedQuantity,
            BaseUnit,
            AllocationCount,
            AssignedQuantity,
            DistributionPercent,
            sourceGLAccount,
            sourceCostCenter,
            @feed.role: #target
            GLAccount,
            @feed.role: #target
            CostCenter
    };

/** One proposal per open requisition item and field (morning step, hook). */
entity FreetextProposal {
    key PurchaseRequisition     : String(10);
    key PurchaseRequisitionItem : String(5);
    key field                   : String(40);
        snapshot                : Association to c.Snapshot;
        rank                    : Integer;
        fieldText               : String(40);
        value                   : String(40);
        confidence              : Double;
        /** prefilled | review | never_automatic | no_threshold */
        status                  : String(20);
        statusText              : String(40);
        statusCriticality       : Integer;
        rightOf100              : Integer;
        words                   : String(200);
        similarSame             : String(80); // "k of n similar items have the same value"
        source                  : c.Source;
        segment                 : String(40);
        alternatives            : LargeString; // JSON [{value, probability}]
        reason                  : String(200);
        computedAt              : Timestamp;
        /** Source facts used for this inference; evidence is invalid when either differs. */
        sourceRevision          : Integer;
        sourceFingerprint       : String(64);
        /** Raw backend score, not a promise that the field is correct. */
        modelScore              : Double;
        /** Measured correctness on the time-separated holdout, if available. */
        historicalReliability   : Double;
        modelVersion            : String(80);
        backend                 : String(40);
        isDemo                  : Boolean default false;
}

/** Durable source facts: unlike FreetextItem this is never replaced by the model feed. */
entity FreetextWorkItem {
    key PurchaseRequisition            : String(10);
    key PurchaseRequisitionItem        : String(5);
        text                           : String(255);
        itemLongText                   : LargeString;
        headerNote                     : LargeString;
        PurchaseRequisitionType        : String(4);
        PurReqnDescription             : String(40);
        RequisitionerName              : String(80);
        CreatedByUser                  : String(12);
        requestedAt                    : Date;
        DeliveryDate                   : Date;
        RequestedQuantity              : Double;
        BaseUnit                       : String(3);
        Plant                          : String(4);
        PurchasingOrganization         : String(4);
        PurchaseOrderType              : String(4);
        PurchasingGroup                : String(3);
        MaterialGroup                  : String(9);
        Supplier                       : String(10);
        FixedSupplier                  : String(10);
        SourceOfSupplyIsAssigned       : Boolean;
        CompanyCode                    : String(4);
        PurchasingDocumentItemCategory : String(1);
        AccountAssignmentCategory      : String(1);
        PurchaseRequisitionPrice       : Double;
        PurReqnPriceQuantity           : Double;
        ItemNetAmount                  : Double;
        PurReqnItemCurrency            : String(5);
        StorageLocation                : String(4);
        Material                       : String(40);
        PurchasingInfoRecord           : String(10);
        OutlineAgreement               : String(10);
        OutlineAgreementItem           : String(5);
        TaxCode                        : String(2);
        GoodsReceiptIsExpected         : Boolean;
        InvoiceIsGoodsReceiptBased     : Boolean;
        IsEvaluatedRcptSettlmtAllowed  : Boolean;
        ServicePerformer               : String(80);
        PerformancePeriodStartDate     : Date;
        PerformancePeriodEndDate       : Date;
        ExpectedOverallLimitAmount     : Double;
        OverallLimitAmount             : Double;
        DeliveryAddressName            : String(80);
        DeliveryAddressStreet          : String(120);
        DeliveryAddressCity            : String(40);
        DeliveryAddressPostalCode      : String(10);
        DeliveryAddressCountry         : String(3);
        UnloadingPoint                 : String(25);
        accountAssignments             : LargeString;
        routedBuyer                    : String(80);
        routedGroup                    : String(3);
        IsDeleted                      : Boolean;
        IsClosed                       : Boolean;
        ProcessingStatus               : String(2);
        PurReqnReleaseStatus           : String(2);
        PurchasingDocument             : String(10);
        PurchasingDocumentItem         : String(5);
        sourceFingerprint              : String(64);
        isOpen                         : Boolean;
        demo                           : Boolean;
        sourceRevision                 : Integer default 1;
        sourceUpdatedAt                : Timestamp;
        enrichmentStatus               : String(12) default 'pending';
        lifecycleStatus                : String(20) default 'needs_review';
        lifecycleText                  : String(40);
        lifecycleCriticality           : Integer;
        readinessSummary               : String(160);
        findingID                      : String(120);
        actionID                       : UUID;
}

/** Immutable, structured source account assignments for a requisition item. */
entity FreetextWorkItemAccountAssignment {
    key PurchaseRequisition          : String(10);
    key PurchaseRequisitionItem      : String(5);
    key PurchaseReqnAcctAssgmtNumber : String(2);
        GLAccount                    : String(10);
        CostCenter                   : String(10);
        SalesOrder                   : String(10);
        SalesOrderItem               : String(6);
        MainAsset                    : String(12);
        AssetSubnumber               : String(4);
        InternalOrder                : String(12);
        WBSElement                   : String(24);
        AssignedQuantity             : Double;
        BaseUnit                     : String(3);
        Currency                     : String(5);
        Amount                       : Double;
        DistributionPercent          : Double;
        IsDeleted                    : Boolean;
}

@readonly
entity FreetextRequester                      as
    select from FreetextWorkItem {
        key RequisitionerName
    }
    where
            RequisitionerName is not null
        and RequisitionerName !=     ''
    group by
        RequisitionerName;

/** Buyer decisions, separate from both original PR facts and model proposals. */
entity FreetextReview : managed {
    key PurchaseRequisition                : String(10);
    key PurchaseRequisitionItem            : String(5);
        Plant                              : String(4)         @readonly;
        PurchasingGroup                    : String(3)         @readonly; // source scope, never the reviewed group
        routedBuyer                        : String(80)        @readonly;
        routedGroup                        : String(3)         @readonly;
        sourceRevision                     : Integer           @readonly;
        workingCopyVersion                 : Integer           @readonly;
        predictionGeneration               : Integer default 0 @readonly;
        allocationPredictionGeneration     : Integer default 0 @readonly;
        fieldOrigins                       : LargeString       @readonly; // JSON property -> source | buyer_changed | buyer_cleared
        requestText                        : String(255)       @readonly;
        itemLongText                       : LargeString       @readonly;
        headerNote                         : LargeString       @readonly;
        RequisitionerName                  : String(80)        @readonly;
        requestedAt                        : Date              @readonly;
        DeliveryDate                       : Date              @readonly;
        RequestedQuantity                  : Double            @readonly;
        BaseUnit                           : String(3)         @readonly;
        PurchasingOrganization             : String(4)         @readonly;
        PurchaseOrderType                  : String(4)         @readonly;
        CompanyCode                        : String(4)         @readonly;
        PurchasingDocumentItemCategory     : String(1)         @readonly;
        AccountAssignmentCategory          : String(1)         @readonly;
        accountAssignments                 : LargeString       @readonly;
        PurchaseRequisitionPrice           : Double            @readonly;
        PurReqnPriceQuantity               : Double            @readonly;
        ItemNetAmount                      : Double            @readonly;
        PurReqnItemCurrency                : String(5)         @readonly;
        StorageLocation                    : String(4)         @readonly;
        Material                           : String(40)        @readonly;
        PurchasingInfoRecord               : String(10)        @readonly;
        OutlineAgreement                   : String(10)        @readonly;
        OutlineAgreementItem               : String(5)         @readonly;
        TaxCode                            : String(2)         @readonly;
        GoodsReceiptIsExpected             : Boolean           @readonly;
        InvoiceIsGoodsReceiptBased         : Boolean           @readonly;
        IsEvaluatedRcptSettlmtAllowed      : Boolean           @readonly;
        ServicePerformer                   : String(80)        @readonly;
        PerformancePeriodStartDate         : Date              @readonly;
        PerformancePeriodEndDate           : Date              @readonly;
        ExpectedOverallLimitAmount         : Double            @readonly;
        OverallLimitAmount                 : Double            @readonly;
        DeliveryAddressName                : String(80)        @readonly;
        DeliveryAddressStreet              : String(120)       @readonly;
        DeliveryAddressCity                : String(40)        @readonly;
        DeliveryAddressPostalCode          : String(10)        @readonly;
        DeliveryAddressCountry             : String(3)         @readonly;
        UnloadingPoint                     : String(25)        @readonly;
        lifecycleStatus                    : String(20)        @readonly;
        lifecycleText                      : String(40)        @readonly;
        lifecycleCriticality               : Integer           @readonly;
        readinessSummary                   : String(160)       @readonly;
        sourceChanged                      : Boolean           @readonly;
        sourceChangeSummary                : String(255)       @readonly;
        sourceChanges                      : LargeString       @readonly;
        enrichmentStatus                   : String(12)        @readonly;
        findingID                          : String(120)       @readonly;
        actionID                           : UUID              @readonly;
        reviewStateText                    : String(160)       @readonly;
        reviewStatusText                   : String(40)        @readonly;
        reviewStatusCriticality            : Integer           @readonly;
        nextStep                           : String(255)       @readonly;
        isReadyToSubmit                    : Boolean           @readonly;
        requiresSourceReconciliation       : Boolean           @readonly;
        isOverdueForReview                 : Boolean           @readonly;
        reviewLocked                       : Boolean = case
                                                           when lifecycleStatus in (
                                                                    'needs_review', 'source_changed'
                                                                )
                                                                then false
                                                           else true
                                                       end;
        MaterialGroup                      : String(9);
        reviewedPurchasingGroup            : String(3);
        Supplier                           : String(10);
        materialGroupText                  : Association to one s4.ProductGroupText
                                                 on  materialGroupText.ProductGroup = $self.MaterialGroup
                                                 and materialGroupText.Language     = 'EN';
        purchasingGroupText                : Association to one s4.PurchasingGroup
                                                 on purchasingGroupText.PurchasingGroup = $self.reviewedPurchasingGroup;
        supplierText                       : Association to one s4.Supplier
                                                 on supplierText.Supplier = $self.Supplier;
        /** Buyer working copy: source values remain read-only above. */
        reviewedShortText                  : String(255);
        reviewedLongText                   : LargeString;
        reviewedHeaderNote                 : LargeString;
        reviewedPrType                     : String(4);
        reviewedItemCategory               : String(1);
        reviewedMaterial                   : String(40);
        reviewedQuantity                   : Double;
        reviewedUnit                       : String(3);
        reviewedDeliveryDate               : Date;
        reviewedPlant                      : String(4);
        reviewedStorageLocation            : String(4);
        reviewedCompanyCode                : String(4);
        reviewedPurchasingOrganization     : String(4);
        reviewedAccountAssignmentCategory  : String(1);
        reviewedValuationPrice             : Double;
        reviewedPriceQuantity              : Double;
        reviewedCurrency                   : String(5);
        reviewedTaxCode                    : String(2);
        reviewedPurchasingInfoRecord       : String(10);
        reviewedOutlineAgreement           : String(10);
        reviewedOutlineAgreementItem       : String(5);
        reviewedReceiptExpected            : Boolean;
        reviewedInvoiceBasedOnReceipt      : Boolean;
        reviewedServicePerformer           : String(80);
        reviewedPerformancePeriodStartDate : Date;
        reviewedPerformancePeriodEndDate   : Date;
        reviewedExpectedOverallLimitAmount : Double;
        reviewedOverallLimitAmount         : Double;
        reviewedDeliveryAddressName        : String(80);
        reviewedDeliveryAddressStreet      : String(120);
        reviewedDeliveryAddressCity        : String(40);
        reviewedDeliveryAddressPostalCode  : String(10);
        reviewedDeliveryAddressCountry     : String(3);
        reviewedUnloadingPoint             : String(25);
        materialGroupState                 : String(20)        @readonly;
        purchasingGroupState               : String(20)        @readonly;
        supplierState                      : String(20)        @readonly;
        accountAssignmentCategoryState     : String(20)        @readonly;
        itemCategoryState                  : String(20)        @readonly;
        materialState                      : String(20)        @readonly;
        infoRecordState                    : String(20)        @readonly;
        buyerNote                          : String(500);
        source                             : Association to one FreetextWorkItem
                                                 on  source.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and source.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
        accountAssignmentRows              : Association to many FreetextWorkItemAccountAssignment
                                                 on  accountAssignmentRows.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and accountAssignmentRows.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
        reviewAccountAssignments           : Composition of many FreetextReviewAccountAssignment
                                                 on  reviewAccountAssignments.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and reviewAccountAssignments.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
        /** Refresh-only evidence owned by the editable CAP draft. */
        draftEvidence                      : Composition of many FreetextDraftEvidence
                                                 on  draftEvidence.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and draftEvidence.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
        /** Buyer Apply/Confirm provenance is independent from the latest evidence. */
        draftDecisions                     : Composition of many FreetextDraftDecision
                                                 on  draftDecisions.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and draftDecisions.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
        allocationEvidence                 : Composition of many FreetextAllocationEvidence
                                                 on  allocationEvidence.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and allocationEvidence.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
        allocationDecisions                : Composition of many FreetextAllocationDecision
                                                 on  allocationDecisions.PurchaseRequisition     = $self.PurchaseRequisition
                                                 and allocationDecisions.PurchaseRequisitionItem = $self.PurchaseRequisitionItem;
}

annotate FreetextReview with {
    modifiedAt @odata.etag;
};

/** Buyer-editable allocation lines. They are copied from the source snapshot,
 * then evolve independently as part of the draft review. */
entity FreetextReviewAccountAssignment : managed {
    key PurchaseRequisition          : String(10);
    key PurchaseRequisitionItem      : String(5);
    key PurchaseReqnAcctAssgmtNumber : String(2);
        GLAccount                    : String(10);
        CostCenter                   : String(10);
        SalesOrder                   : String(10);
        SalesOrderItem               : String(6);
        MainAsset                    : String(12);
        AssetSubnumber               : String(4);
        InternalOrder                : String(12);
        WBSElement                   : String(24);
        AssignedQuantity             : Double;
        BaseUnit                     : String(3);
        Currency                     : String(5);
        Amount                       : Double;
        DistributionPercent          : Double;
        predictionOrigins            : LargeString @readonly;
}

entity FreetextAllocationEvidence : managed {
    key PurchaseRequisition     : String(10);
    key PurchaseRequisitionItem : String(5);
    key allocationNumber        : String(2);
    key generation              : Integer;
    key field                   : String(40);
        inputHash               : String(64);
        sourceRevision          : Integer;
        sourceFingerprint       : String(64);
        status                  : String(20);
        reason                  : String(200);
        candidates              : LargeString;
        backend                 : String(40);
        modelVersion            : String(80);
        runIdentity             : String(120);
        requestedAt             : Timestamp;
        deadlineAt              : Timestamp;
        computedAt              : Timestamp;
        completedAt             : Timestamp;
}

entity FreetextAllocationDecision : managed {
    key PurchaseRequisition     : String(10);
    key PurchaseRequisitionItem : String(5);
    key allocationNumber        : String(2);
    key field                   : String(40);
        value                   : String(10);
        evidenceGeneration      : Integer;
        inputHash               : String(64);
        appliedContextHash      : String(64);
        appliedAt               : Timestamp;
        confirmedAt             : Timestamp;
}

/** A prediction result exists only with its buyer's working draft. */
entity FreetextDraftEvidence : managed {
    key PurchaseRequisition     : String(10);
    key PurchaseRequisitionItem : String(5);
    key generation              : Integer;
    key field                   : String(40);
        inputHash               : String(64);
        sourceRevision          : Integer;
        sourceFingerprint       : String(64);
        status                  : String(20); // pending | available | unavailable | failed | stale | canceled
        reason                  : String(200);
        value                   : String(40);
        candidates              : LargeString; // JSON [{value, probability}]
        modelScore              : Double;
        historicalReliability   : Double;
        calibrationIdentity     : String(120);
        runIdentity             : String(120);
        backend                 : String(40);
        modelVersion            : String(80);
        requestedAt             : Timestamp;
        deadlineAt              : Timestamp;
        computedAt              : Timestamp;
        completedAt             : Timestamp;
}

/** Explicit Apply/Confirm audit trail; refreshing evidence never rewrites it. */
entity FreetextDraftDecision : managed {
    key PurchaseRequisition     : String(10);
    key PurchaseRequisitionItem : String(5);
    key field                   : String(40);
        value                   : String(40);
        evidenceGeneration      : Integer;
        inputHash               : String(64);
        appliedAt               : Timestamp;
        confirmedAt             : Timestamp;
}

/** Immutable payload frozen when the buyer submits the completed requisition. */
entity FreetextSubmission : managed {
    key ID                      : UUID;
        PurchaseRequisition     : String(10);
        PurchaseRequisitionItem : String(5);
        sourceRevision          : Integer;
        submittedBy             : String(80);
        submittedAt             : Timestamp;
        payload                 : LargeString;
        action                  : Association to c.Actions;
}

/** Review threshold per field and segment from the holdout calibration. */
entity FreetextThreshold {
    key field               : String(40);
    key segment             : String(40);
        threshold           : Double;
        accuracyAtThreshold : Double;
        target              : Double;
        contextRows         : Integer;
        holdoutRows         : Integer;
        trainRows           : Integer;
        holdoutAccuracy     : Double;
        coverage            : Double;
        reason              : String(200);
        holdout             : LargeString; // JSON {conf: [], correct: []}
        createdAt           : Timestamp;
}

entity FreetextDetail {
    key finding     : Association to one c.Finding;
        requestedAt : Date;
        requestText : String(255);
        codingText  : String(300);
        segment     : String(40);
        demo        : Boolean;
        contextRows : Integer;
        inputs      : LargeString;
}

extend service PurchasingDeskService with {
    type PredictionValueV5 {
        kind        : String(10) enum {
            code;
            blank;
            missing;
        };
        code        : String(40);
        displayName : String(120);
    }

    type PredictionSelectionV5 {
        allocationNumber : String(2);
        field            : String(40);
        evidenceID       : String(64);
        candidateID      : String(64);
        expectedValue    : PredictionValueV5;
    }

    type PredictionIdentityV5 {
        draftUUID         : UUID;
        modifiedAt        : Timestamp;
        inputHash         : String(64);
        sourceRevision    : Integer;
        sourceFingerprint : String(64);
    }

    type PredictionCapabilitiesV5 {
        canInspect     : Boolean;
        canPredict     : Boolean;
        canApply       : Boolean;
        canEditToApply : Boolean;
        canConfirm     : Boolean;
        canRetry       : Boolean;
        reviewOnly     : Boolean;
        reason         : String(200);
    }

    type PredictionCandidateV5 {
        id         : String(64);
        rank       : Integer;
        value      : PredictionValueV5;
        modelScore : Double;
    }

    type PredictionDecisionV5 {
        evidenceGeneration : Integer;
        inputHash          : String(64);
        appliedAt          : Timestamp;
        confirmedAt        : Timestamp;
    }

    type PredictionEvidenceV5 {
        id                    : String(64);
        generation            : Integer;
        inputHash             : String(64);
        status                : String(20);
        reason                : String(200);
        candidates            : many PredictionCandidateV5;
        historicalReliability : Double;
        evaluationScope       : String(40);
        sampleSize            : Integer;
        calibrationIdentity   : String(120);
        runIdentity           : String(120);
        backend               : String(40);
        modelVersion          : String(80);
        computedAt            : Timestamp;
        supportingHistory     : String(200);
        summary               : String(255);
        staleReasons          : many String(40);
    }

    type PredictionFieldV5 {
        allocationNumber : String(2);
        field            : String(40);
        property         : String(40);
        current          : PredictionValueV5;
        origin           : String(10);
        cleared          : Boolean;
        reviewed         : Boolean;
        capabilities     : PredictionCapabilitiesV5;
        evidence         : PredictionEvidenceV5;
        decision         : PredictionDecisionV5;
    }

    type PredictionWorkspaceV5 {
        schemaVersion      : Integer;
        identity           : PredictionIdentityV5;
        fields             : many PredictionFieldV5;
        allocationIdentity : PredictionIdentityV5;
        allocationFields   : many PredictionFieldV5;
        allocationCount    : Integer;
        accountCategory    : String(1);
        demo               : Boolean;
    }

    type PredictionOutcomeV5 {
        allocationNumber : String(2);
        field            : String(40);
        status           : String(20);
    }

    type PredictionReceiptV5 {
        generation : Integer;
        inputHash  : String(64);
        deadlineAt : Timestamp;
        outcomes   : many PredictionOutcomeV5;
    }

    type AllocationPredictionTargetV5 {
        allocationNumber : String(2);
        field            : String(40);
    }

    @readonly
    entity FreetextWorkItems                  as projection on FreetextWorkItem;

    @readonly
    entity Requisitioners                     as projection on FreetextRequester;

    @odata.draft.enabled
    @Capabilities.InsertRestrictions.Insertable: false
    @Capabilities.DeleteRestrictions.Deletable : false
    entity PurchaseRequisitionReviews         as
        projection on FreetextReview {
            *,
            source                   : redirected to FreetextWorkItems,
            materialGroupText.ProductGroupName      as materialGroupName,
            purchasingGroupText.PurchasingGroupName as purchasingGroupName,
            supplierText.SupplierName               as supplierName,
            accountAssignmentRows    : redirected to FreetextWorkItemAccountAssignments,
            reviewAccountAssignments : redirected to FreetextReviewAccountAssignments,
            proposals                : Association to many PurchasingDeskService.FreetextProposals
                                           on  proposals.PurchaseRequisition     = PurchaseRequisition
                                           and proposals.PurchaseRequisitionItem = PurchaseRequisitionItem
        }
        excluding {
            materialGroupText,
            purchasingGroupText,
            supplierText
        }
        actions {
            action validateReview()                                                                                                                                                                                                    returns PurchaseRequisitionReviews;
            action reviewWorkspace()                                                                                                                                                                                                   returns LargeString;
            action reviewWorkspaceV5()                                                                                                                                                                                                 returns PredictionWorkspaceV5;
            action applyPredictionSelections(selections: many PredictionSelectionV5, expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64))                                                            returns PredictionWorkspaceV5;
            action predictDraftFieldsV5(selectedFields: many String(40), expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64))                                                                        returns PredictionReceiptV5;
            action predictAllocationFieldsV5(selectedTargets: many AllocationPredictionTargetV5, expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64))                                                returns PredictionReceiptV5;
            action applyAllocationSelectionsV5(selections: many PredictionSelectionV5, expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64))                                                          returns PredictionWorkspaceV5;
            action confirmAllocationValueV5(allocationNumber: String(2), field: String(40), expectedValue: PredictionValueV5, expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64))                   returns PredictionWorkspaceV5;
            action applyDraftSuggestionV5(field: String(40), evidenceID: String(64), candidateID: String(64), expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64), expectedValue: PredictionValueV5) returns PredictionWorkspaceV5;
            action confirmDraftValueV5(field: String(40), expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64), expectedValue: PredictionValueV5)                                                     returns PredictionWorkspaceV5;
            /** Apply valid current suggestions only to blank fields in this editable draft. */
            action applyProvisionalSuggestions()                                                                                                                                                                                       returns LargeString;
            action predictDraftFields(selectedFields: LargeString, expectedDraftUUID: UUID, expectedModifiedAt: Timestamp, expectedInputHash: String(64))                                                                              returns LargeString;
            action applyDraftSuggestion(field: String(40), candidate: String(40), evidenceGeneration: Integer, expectedInputHash: String(64), expectedCurrentValue: String(40))                                                        returns LargeString;
            action confirmDraftValue(field: String(40), expectedCurrentValue: String(40))                                                                                                                                              returns LargeString;
            action reviewOrder()                                                                                                                                                                                                       returns LargeString;
            action submitReviewedOrder(expectedModifiedAt: Timestamp, expectedReviewToken: String(64))                                                                                                                                 returns PurchasingDeskService.Actions;
            action exportOrderDraft()                                                                                                                                                                                                  returns LargeString;
            action submitForApproval()                                                                                                                                                                                                 returns PurchasingDeskService.Actions;
            action suggestSupplier()                                                                                                                                                                                                   returns PurchaseRequisitionReviews;
            action reconcileSource()                                                                                                                                                                                                   returns PurchaseRequisitionReviews;
            action confirmCurrentValues()                                                                                                                                                                                              returns PurchaseRequisitionReviews;
        };

    @readonly
    entity RequestPurchasingGroups            as
        select from c.FreetextItem {
            key Plant,
            key PurchasingGroup
        }
        where
                isOpen          =      false
            and Plant           is not null
            and PurchasingGroup is not null
        group by
            Plant,
            PurchasingGroup;

    @readonly
    entity RequestSuppliers                   as
        select from c.FreetextItem {
            key PurchasingOrganization,
            key Supplier
        }
        where
                isOpen                 =      false
            and PurchasingOrganization is not null
            and Supplier               is not null
        group by
            PurchasingOrganization,
            Supplier;

    @readonly
    entity RequestAccountAssignmentCategories as
        select from c.FreetextItem {
            key AccountAssignmentCategory as Category
        }
        where
                isOpen                    =      false
            and AccountAssignmentCategory is not null
        group by
            AccountAssignmentCategory;

    @readonly
    entity RequestItemCategories              as
        select from c.FreetextItem {
            key PurchasingDocumentItemCategory as Category
        }
        where
                isOpen                         =      false
            and PurchasingDocumentItemCategory is not null
        group by
            PurchasingDocumentItemCategory;


    @readonly
    entity MaterialGroups                     as
        projection on s4.ProductGroupText {
            key ProductGroup,
                ProductGroupName
        }
        where
            Language = 'EN';


    @readonly
    entity FreetextProposals                  as projection on c.FreetextProposal;

    @readonly
    entity FreetextThresholds                 as
        projection on c.FreetextThreshold
        excluding {
            holdout
        };

    @readonly
    entity FreetextDetails                    as projection on FreetextDetail;

    @readonly
    entity FreetextWorkItemAccountAssignments as projection on FreetextWorkItemAccountAssignment;

    entity FreetextReviewAccountAssignments   as projection on FreetextReviewAccountAssignment;

    @readonly
    entity FreetextDraftEvidences             as projection on FreetextDraftEvidence;

    @readonly
    entity FreetextDraftDecisions             as projection on FreetextDraftDecision;

    @readonly
    entity FreetextAllocationEvidences        as projection on FreetextAllocationEvidence;

    @readonly
    entity FreetextAllocationDecisions        as projection on FreetextAllocationDecision;

    @readonly
    entity AccountingCompanyCodes             as projection on s4.AccountingCompanyCode;

    @readonly
    entity GLAccountCompanies                 as projection on s4.GLAccountCompany;

    @readonly
    entity AccountingCostCenters              as projection on s4.AccountingCostCenter;

    @readonly
    entity FreetextSubmissions                as projection on FreetextSubmission;

    /** Accept the confident codes of every open free-text request in the user's scope. */
    action acceptAllConfidentCodes()          returns PurchasingDeskService.Actions;
    /** Holdout calibration of the review thresholds (one model call per field and segment). */
    action calibrateFreetext(dryRun: Boolean) returns many PurchasingDeskService.FreetextThresholds;
}

extend PurchasingDeskService.Findings with columns {
    freetextDetail    : Association to one PurchasingDeskService.FreetextDetails
                            on freetextDetail.finding = $self,
    freetextProposals : Association to many PurchasingDeskService.FreetextProposals
                            on  freetextProposals.PurchaseRequisition     = PurchaseRequisition
                            and freetextProposals.PurchaseRequisitionItem = PurchaseRequisitionItem
};
