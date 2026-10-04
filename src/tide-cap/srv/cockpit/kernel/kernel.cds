namespace tide.cockpit;

using {
    cuid,
    managed
} from '@sap/cds/common';
using {tide.cockpit as c} from '../db';
using {PurchasingDeskService} from '../../purchasing-desk-service';

// Shared types, entities, and service operations; features extend entities in their own model.cds.

// ------------------------------------------------------------------ types

/** Every result carries its source (§2); buyer words via kernel/findings.ts sourceText(). */
extend c.Source with (length : 20);

extend c.Source with enum {
    calculation;
    confirmation;
}

type FindingList    : String(30) enum {
    at_risk;
    overdue;
    price;
    pdt;
    mm_pdt;
    freetext;
    duplicate;
    rare;
}

/** P-2 impact levels, most severe first (rank 0..4). */
type ImpactLevel    : String(30) enum {
    customer_order_late;
    production_affected;
    stock_uncovered;
    covered_by_stock;
    no_impact;
}

type ActionKind     : String(20) enum {
    reminder;
    pdt_change;
    worklist;
    code_list;
    pr_review;
    post_confirmation;
    price_check;
    price_clarification;
    mdg_case;
    planner_review;
}

type OperationKey   : String(40) enum {
    delivery_intervention;
    delivery_escalation;
    pdt_change;
    price_clarification;
    master_data_duplicate_review;
    planner_review;
    requisition_review;
    code_list;
    prediction_worklist;
    price_check;
    post_confirmation;
}

/** Stable category of a case; it selects its typed current-state row and object page. */
type CaseKind       : String(30) enum {
    delivery;
    price;
    duplicate;
    unusual_setting;
    supplier_planned_time;
    material_planned_time;
    requisition_review;
}

type CaseStatus     : String(10) enum {
    open;
    closed;
}

type CaseClosure    : String(30) enum {
    resolved_at_source;
    action_completed;
    exception_accepted;
    superseded;
    obsolete;
}

type CaseListing    : String(10) enum {
    listed;
    unlisted;
}

/** Derived queue state. Feature handlers must never assign this field directly. */
type AttentionState : String(30) enum {
    done;
    source_changed;
    needs_review;
    in_progress;
    awaiting_decision;
    follow_up_overdue;
    waiting_external;
    awaiting_source;
    needs_attention;
}

type ReviewStatus   : String(20) enum {
    new;
    in_progress;
    submitted;
    done;
    cancelled;
}

type ExportFormat   : String(20) enum {
    reminder;
    csv;
}

// ------------------------------------------------------- shared entities

/** The one first-look row model of every list (§3). ID = `<list>:<objectKey>`. */
entity Finding {
    key ID                          : String(120);
        snapshot                    : Association to c.Snapshot;
        lifecycle                   : Association to one Cases
                                          on lifecycle.ID = ID;
        list                        : FindingList;
        // Buyer word + traffic light of `list` (§Type column, icon+red);
        // filled centrally by kernel/findings.ts complete(), never by writers.
        listText                    : String(20);
        listCriticality             : Integer;
        objectKey                   : String(80);
        /** Durable business issue; unlike Finding.ID this survives list transitions. */
        problemKey                  : String(160);
        PurchaseOrder               : String(10);
        PurchaseOrderItem           : String(5);
        Material                    : String(40);
        Supplier                    : String(10);
        // "<code> – <name>" combined display, built by each list's writer
        // from a master-data name lookup (atrisk/grids.ts names()).
        supplierDisplay             : String(120);
        Plant                       : String(4);
        plantDisplay                : String(120);
        PurchasingGroup             : String(3);
        MRPController               : String(3);
        PurchaseRequisition         : String(10);
        PurchaseRequisitionItem     : String(5);
        itemTitle                   : String(120);
        itemSubtitle                : String(200);
        issue                       : String(300);
        issueTechnical              : String(300);
        impactLevel                 : ImpactLevel;
        impactCriticality           : Integer; // 1 red, 2 yellow, 3 green, 0 neutral
        impactText                  : String(200);
        deliveryPriority            : String(10);
        deliveryPriorityOrder       : Integer;
        deliveryPriorityCriticality : Integer;
        predictedArrival            : Date;
        arrivalSource               : String(20);
        revenueAtRisk               : Double;
        dueDate                     : Date;
        nextStep                    : String(120);
        nextActionKind              : ActionKind;
        /** Whether the finding has enough evidence for its proposed change. */
        changeAvailable             : Boolean default false;
        source                      : c.Source;
        sourceText                  : String(40);
        chain                       : String(1000);
        technicalChain              : String(1000);
        trigger                     : String(10) enum {
            morning;
            arrived;
        } default 'morning';
        status                      : String(10) enum {
            open;
            closed;
        } default 'open';
        statusCriticality           : Integer;
        arrivedAt                   : Timestamp;
        rank                        : Integer;
        /** Deprecated migration source. New writers store type-specific facts in detail entities. */
        expert                      : LargeString;
        impact                      : Association to ItemImpact
                                          on  impact.PurchaseOrder     = $self.PurchaseOrder
                                          and impact.PurchaseOrderItem = $self.PurchaseOrderItem;
        /** The one approval currently blocking a new proposal for this finding
         * (§Work Item 1: worklist action-state visibility). Source screens use
         * it to open the request instead of offering duplicate preparation. */
        activeAction                : Association to one c.Actions
                                          on  activeAction.findingID =  $self.ID
                                          and activeAction.status    in (
                                              'needs_decision', 'waiting'
                                          );
        // Flattened for worklist rows (buyer badge): avoids an $expand on
        // every list just to show whether an action is already in flight.
        activeActionStatus          : String(20) = activeAction.status;
        activeActionOverdue         : Boolean    = activeAction.overdue;
}

/** Durable business issue. Source facts, not approval state, decide when it is resolved. */
entity Problem : managed {
    key problemKey        : String(160);
        type              : String(40);
        sourceObjectKey   : String(120);
        status            : String(20) enum {
            open;
            resolved;
        } default 'open';
        sourceFingerprint : String(64);
        resolvedAt        : Timestamp;
        resolutionReason  : String(500);
}

// ---------------------------------------------------------------- case kernel (v4)
// These entities are additive while the v3 Finding read model is migrated feature
// by feature. Cases own business lifecycle; Actions own approval/execution state.

entity Cases : managed {
    key ID                : String(160);
        kind              : CaseKind;
        status            : CaseStatus default 'open';
        closure           : CaseClosure;
        closureNote       : String(500);
        resolvedAt        : Timestamp;
        listing           : CaseListing default 'listed';
        lastListedAt      : Timestamp;
        attention         : AttentionState default 'needs_attention';
        sourceRevision    : Integer default 1;
        sourceFingerprint : String(64);
        /** Set by recordSourceChange(), cleared only after the review/reconciliation rule accepts it. */
        sourceChanged     : Boolean default false;
        Plant             : String(4);
        PurchasingGroup   : String(3);
        title             : String(200);
        priority          : Integer;
        dueDate           : Date;
}

/** Current delivery condition. At-risk and overdue are phases of one case, never separate cases. */
entity DeliveryRisks {
    key header            : Association to one Cases not null;
        PurchaseOrder     : String(10);
        PurchaseOrderItem : String(5);
        phase             : String(10) enum {
            at_risk;
            overdue;
        };
        Material          : String(40);
        Supplier          : String(10);
        Plant             : String(4);
        PurchasingGroup   : String(3);
        dueDate           : Date;
        predictedArrival  : Date;
        /** Whether the arrival is a supplier confirmation, forecast, or requested date. */
        arrivalSource     : String(20);
        revenueAtRisk     : Double;
        nextActionKind    : ActionKind;
        source            : c.Source;
        sourceFingerprint : String(64);
        detail            : LargeString;
}

entity PriceDeviations {
    key header              : Association to one Cases not null;
        PurchaseOrder       : String(10);
        PurchaseOrderItem   : String(5);
        Material            : String(40);
        Supplier            : String(10);
        Plant               : String(4);
        PurchasingGroup     : String(3);
        unitPrice           : Double;
        priorCount          : Integer;
        currentPrice        : Double;
        priorMedian         : Double;
        ratio               : Double;
        factor              : Double;
        potentialDifference : Double;
        currency            : String(5);
        detail              : LargeString;
        assessment          : Association to one c.PriceAssessment
                                  on  assessment.PurchaseOrder     = PurchaseOrder
                                  and assessment.PurchaseOrderItem = PurchaseOrderItem;
}

entity DuplicateMaterials {
    key header          : Association to one Cases not null;
        Material        : String(40);
        Plant           : String(4);
        groupKey        : String(120);
        activity        : Integer;
        candidateCount  : Integer;
        materialType    : String(20);
        materialNumbers : String(500);
        mainPlant       : String(4);
        PurchasingGroup : String(3);
        detail          : LargeString;
}

entity UnusualSettings {
    key header           : Association to one Cases not null;
        Material         : String(40);
        Plant            : String(4);
        MRPController    : String(3);
        groupSize        : Integer;
        materialType     : String(20);
        unusualPairCount : Integer;
        summary          : String(300);
        detail           : LargeString;
}

entity SupplierPlannedTimes {
    key header               : Association to one Cases not null;
        Material             : String(40);
        Plant                : String(4);
        supplier             : String(10);
        purchasingInfoRecord : String(20);
        currentDays          : Double;
        proposedDays         : Integer;
        p50                  : Double;
        ownDeliveries        : Integer;
        value12mEUR          : Double;
        proposalRule         : String(300);
        detail               : LargeString;
}

entity MaterialPlannedTimes {
    key header        : Association to one Cases not null;
        material      : String(40);
        plant         : String(4);
        MRPController : String(3);
        currentDays   : Double;
        proposedDays  : Integer;
        masterFlag    : String(20);
        orders12m     : Integer;
        difference    : Double;
        tolerance     : Double;
        detail        : LargeString;
}

/** Typed current review state and authoritative buyer review aggregate. */
entity RequisitionReviews : managed {
    key header                    : Association to one Cases not null;
        PurchaseRequisition       : String(10);
        PurchaseRequisitionItem   : String(5);
        MaterialGroup             : String(9);
        reviewedPurchasingGroup   : String(3);
        Supplier                  : String(10);
        buyerNote                 : String(500);
        reviewStatus              : ReviewStatus default 'new';
        materialGroupState        : String(20);
        purchasingGroupState      : String(20);
        supplierState             : String(20);
        reviewStateText           : String(160);
        readinessSummary          : String(160);
        enrichmentStatus          : String(12);
        routedBuyer               : String(80);
        routedGroup               : String(3);
        sourceRevision            : Integer;
        sourceChanged             : Boolean;
        requestedAt               : Date;
        requestText               : String(255);
        RequisitionerName         : String(80);
        Plant                     : String(4);
        DeliveryDate              : Date;
        RequestedQuantity         : Double;
        BaseUnit                  : String(3);
        PurchasingOrganization    : String(4);
        CompanyCode               : String(4);
        AccountAssignmentCategory : String(1);
        PurchaseRequisitionPrice  : Double;
        PurReqnItemCurrency       : String(5);
        accountAssignments        : LargeString;
        proposals                 : LargeString;
}

entity CaseEvents : cuid {
    header            : Association to one Cases not null;
    occurredAt        : Timestamp;
    event             : String(40);
    fromStatus        : CaseStatus;
    toStatus          : CaseStatus;
    sourceRevision    : Integer;
    sourceFingerprint : String(64);
    actor             : String(80);
    reason            : String(500);
}

/** Explicit n:m relationship; an action can affect more than one case. */
entity CaseActions : managed {
    key header            : Association to one Cases not null;
    key action            : Association to one c.Actions not null;
        operation         : OperationKey;
        sourceFingerprint : String(64);
        role              : String(20) enum {
            primary;
            affected;
        } default 'primary';
        resolution        : String(30);
        resolvedAt        : Timestamp;
}

/** Technical uniqueness guard for a non-terminal action on a case operation. */
entity OperationLocks {
    key header    : Association to one Cases not null;
    key operation : OperationKey;
        action    : Association to one c.Actions not null;
}

/** Action aggregate history, kept separate from business-case history. */
entity ActionEvents : cuid {
    action     : Association to one c.Actions not null;
    occurredAt : Timestamp;
    event      : String(40);
    fromStatus : String(20);
    toStatus   : String(20);
    actor      : String(80);
    note       : String(500);
    source     : String(30);
}

/** Immutable evidence versions retained when the current Finding projection is rebuilt. */
entity FindingEvidence : managed {
    key problemKey  : String(160);
    key list        : FindingList;
    key fingerprint : String(64);
        findingID   : String(120);
        snapshotID  : UUID;
        disposition : String(30) enum {
            current;
            superseded_by_overdue;
            out_of_window;
            not_selected;
            resolved_from_source;
        } default 'current';
        reason      : String(500);
        evidence    : LargeString;
}

/** Morning lead-time grid per open PO item (P-1). Writer: atrisk. */
entity LineGrid {
    key PurchaseOrder     : String(10);
    key PurchaseOrderItem : String(5);
        snapshot          : Association to c.Snapshot;
        Material          : String(40);
        Supplier          : String(10);
        Plant             : String(4);
        source            : c.Source;
        nOwn              : Integer;
        levels            : LargeString; // JSON {"0.05": d, …, "0.95": d}, 19 levels
        p10               : Double;
        p50               : Double;
        p80               : Double;
        p90               : Double;
        contextLevel      : String(40);
}

/** Impact of one open PO item (P-2). Writer: impact. */
entity ItemImpact {
    key PurchaseOrder          : String(10);
    key PurchaseOrderItem      : String(5);
        snapshot               : Association to c.Snapshot;
        level                  : ImpactLevel;
        rank                   : Integer;
        materialKind           : String(20); // trading_goods | spare_part | non_stock | make_to_stock | make_to_order
        kindNote               : String(200);
        expectedDate           : Date;
        cautiousDate           : Date;
        confirmedDate          : Date;
        arrivalSource          : String(20);
        needDate               : Date;
        delayDays              : Integer;
        customerDelayDays      : Integer;
        revenueAtRisk          : Double;
        revenueCautious        : Double;
        shortageFrom           : Date;
        shortageDays           : Integer;
        coverageDays           : Double;
        stock                  : Double;
        productionOrders       : Integer;
        salesOrders            : Integer;
        note                   : String(300);
        scenarios              : LargeString; // JSON [{level, arrival, revenue, customerDelayDays}]
        md04                   : LargeString; // JSON [{date, element, id, qty, available, own, affected}]
        chain                  : LargeString; // JSON MTO chain
        source                 : c.Source default 'calculation';
        salesOrderImpacts      : Composition of many SalesOrderImpact
                                     on  salesOrderImpacts.PurchaseOrder     = $self.PurchaseOrder
                                     and salesOrderImpacts.PurchaseOrderItem = $self.PurchaseOrderItem;
        productionOrderImpacts : Composition of many ProductionOrderImpact
                                     on  productionOrderImpacts.PurchaseOrder     = $self.PurchaseOrder
                                     and productionOrderImpacts.PurchaseOrderItem = $self.PurchaseOrderItem;
}

/** Typed buyer-facing impact rows. Rebuilt with ItemImpact by the impact step. */
entity SalesOrderImpact {
    key PurchaseOrder      : String(10);
    key PurchaseOrderItem  : String(5);
    key SalesOrder         : String(10);
    key SalesOrderItem     : String(6);
        Customer           : String(10);
        CustomerName       : String(120);
        RequiredDate       : Date;
        PredictedDelayDays : Integer;
        RevenueAtRisk      : Double;
        Currency           : String(3);
}

/** Typed production exposure for a delayed PO item. */
entity ProductionOrderImpact {
    key PurchaseOrder         : String(10);
    key PurchaseOrderItem     : String(5);
    key ProductionOrder       : String(12);
        FinishedProduct       : String(40);
        RequiredDate          : Date;
        PredictedShortageDays : Integer;
        AffectedQuantity      : Double;
        Unit                  : String(3);
}

/** Supplier confirmations (order acknowledgments) per PO item. Writer: rules. */
entity Confirmation {
    key PurchaseOrder     : String(10);
    key PurchaseOrderItem : String(5);
    key line              : Integer;
        date              : Date;
        quantity          : Double;
        enteredBy         : String(80);
        enteredAt         : Timestamp;
        origin            : String(10) enum {
            sap;
            app;
            feeder;
        };
}

/** Event log of the day; written only by kernel/events.ts emit(). */
entity Event {
    key seq        : Integer;
        at         : Timestamp;
        simTime    : Timestamp;
        kind       : String(20) enum {
            morning;
            po_item;
            goods_receipt;
            confirmation;
            freetext;
            action;
            recompute;
            why;
        };
        title      : String(300);
        findingID  : String(120);
        objectKey  : String(80);
        source     : c.Source;
        status     : String(20);
        modelCalls : Integer;
        costUnits  : Double;
        latencyMs  : Integer;
}

/** A buyer and the scope they see (null = all). Writer: guard. */
entity Buyer {
    key userId          : String(80);
        name            : String(80);
        PurchasingGroup : String(3);
        Plant           : String(4);
}

/**
 * A buyer decision which must survive replacement of the daily finding rows.
 * `fingerprint` scopes an accepted exception to the evidence that was reviewed;
 * changed evidence produces an open finding again.
 */
entity PreventionDisposition : managed {
    key list        : FindingList;
    key objectKey   : String(80);
        fingerprint : String(64);
        outcome     : String(30) enum {
            accepted;
            keep_current;
            ignored;
        };
        note        : String(500);
        reviewOn    : Date;
}

extend c.Actions with {
    extend preparedVia with enum {
        feeder;
        mcp;
    };
    /** Durable issue and business operation identities. */
    problemKey          : String(160);
    operationKey        : OperationKey;
    exportFormat        : ExportFormat;
    findingID           : String(120);
    /** Buyer-facing classification of the business source that prepared this request. */
    requestType         : String(80);
    /** Approval is blocked until the prepared request has enough buyer decision context. */
    decisionReady       : Boolean default true;
    decisionBlockReason : String(500);
    chain               : String(1000);
    /** Recipient selected by the buyer for a clarification or review request. */
    responsiblePerson   : String(120);
    responsibleMessage  : String(1000);
    // Cooldown (kernel/expire.ts): set when a decide() moves the action to
    // waiting; cleared/unused once resolved or declined.
    waitingSince        : Timestamp;
    expectedBy          : Date;
    overdue             : Boolean default false;
    // Persist here because Finding rows are rebuilt, while Actions are durable.
    resolution          : String(20) enum {
        confirmed;
        posted;
        resolved_elsewhere;
        escalated;
    };
    resolutionNote      : String(500);
    resolvedBy          : String(80);
    resolvedAt          : Timestamp;
}

extend c.ActionItems with {
    problemKey   : String(160);
    operationKey : OperationKey;
    findingID    : String(120);
    resolution   : String(20);
    resolvedAt   : Timestamp;
    data         : LargeString;
}

/** Database-enforced active approval invariant, including every line of a batch. */
entity ApprovalLock {
    key problemKey   : String(160);
    key operationKey : OperationKey;
        approval     : Association to c.Actions not null;
}

/** Immutable approval transition history. */
entity ApprovalEvent : cuid {
    approval   : Association to c.Actions not null;
    at         : Timestamp;
    event      : String(30);
    fromStatus : String(20);
    toStatus   : String(20);
    actor      : String(80);
    note       : String(500);
    source     : String(30);
}

/** Durable source-fact and lifecycle history of a Problem. */
entity ProblemEvent : cuid {
    problemKey : String(160);
    at         : Timestamp;
    event      : String(40);
    reason     : String(500);
    findingID  : String(120);
    source     : String(30);
}

// ------------------------------------------------------------- service

extend service PurchasingDeskService with {
    @readonly
    entity Cases                             as projection on c.Cases;

    /**
     * Typed delivery case read model. Keep lifecycle fields flat for Fiori
     * Elements: filter metadata does not reliably resolve nested paths.
     */
    @readonly
    entity DeliveryRisks                     as
        projection on c.DeliveryRisks {
            *,
            header                                     : redirected to Cases,
            header.ID             as caseID,
            header.title          as caseTitle,
            header.priority       as casePriority,
            header.status         as caseStatus,
            header.listing        as caseListing,
            header.attention      as caseAttention,
            case
                when header.status = 'open'
                     then 'Open'
                when header.status = 'closed'
                     then 'Closed'
                else 'In progress'
            end                   as caseStatusText    : String(20),
            case
                when header.attention = 'needs_attention'
                     then 'Needs attention'
                when header.attention = 'awaiting_decision'
                     then 'Awaiting decision'
                when header.attention = 'waiting_external'
                     then 'Waiting for supplier'
                when header.attention = 'awaiting_source'
                     then 'Waiting for source confirmation'
                when header.attention = 'source_changed'
                     then 'Source evidence changed'
                when header.attention = 'follow_up_overdue'
                     then 'Follow-up overdue'
                when header.attention = 'done'
                     then 'No further action'
                else 'In progress'
            end                   as caseAttentionText : String(40),
            header.sourceRevision as caseSourceRevision,
            header.sourceChanged  as caseSourceChanged,
            header.closure        as caseClosure,
            case
                when header.closure = 'resolved_at_source'
                     then 'Resolved at source'
                when header.closure = 'exception_accepted'
                     then 'Exception accepted'
                when header.closure = 'superseded'
                     then 'Superseded'
                when header.closure = 'obsolete'
                     then 'No longer relevant'
                else null
            end                   as caseClosureText   : String(30),
            header.modifiedAt     as caseUpdatedAt,
            case
                when phase = 'at_risk'
                     then 'At risk'
                when phase = 'overdue'
                     then 'Overdue'
                else 'In progress'
            end                   as phaseText         : String(20),
            case
                when arrivalSource = 'confirmation'
                     then 'Supplier confirmation'
                when arrivalSource = 'forecast'
                     then 'Delivery forecast'
                when arrivalSource = 'requested'
                     then 'Requested date'
                when arrivalSource = 'sap_planned'
                     then 'Planned delivery date'
                else 'Delivery forecast'
            end                   as arrivalSourceText : String(30),
            impact                                     : Association to one PurchasingDeskService.ItemImpacts
                                                             on  impact.PurchaseOrder     = PurchaseOrder
                                                             and impact.PurchaseOrderItem = PurchaseOrderItem,
            caseEvents                                 : Association to many PurchasingDeskService.CaseEvents
                                                             on caseEvents.header = $self.header,
            caseActions                                : Association to many PurchasingDeskService.CaseActions
                                                             on caseActions.header = $self.header
        };

    @readonly
    entity PriceDeviations                   as
        projection on c.PriceDeviations {
            *,
            header                                     : redirected to Cases,
            header.ID             as caseID,
            header.title          as caseTitle,
            header.priority       as casePriority,
            header.status         as caseStatus,
            header.listing        as caseListing,
            header.attention      as caseAttention,
            case
                when header.attention = 'needs_attention'
                     then 'Needs review'
                when header.attention = 'awaiting_decision'
                     then 'Awaiting decision'
                when header.attention = 'waiting_external'
                     then 'Waiting for outcome'
                when header.attention = 'awaiting_source'
                     then 'Waiting for source confirmation'
                when header.attention = 'source_changed'
                     then 'Source evidence changed'
                when header.attention = 'follow_up_overdue'
                     then 'Follow-up overdue'
                when header.attention = 'done'
                     then 'No further action'
                else 'In progress'
            end                   as caseAttentionText : String(32),
            header.sourceRevision as caseSourceRevision,
            header.sourceChanged  as caseSourceChanged,
            header.closure        as caseClosure,
            header.modifiedAt     as caseUpdatedAt,
            caseEvents                                 : Association to many PurchasingDeskService.CaseEvents
                                                             on caseEvents.header = $self.header,
            caseActions                                : Association to many PurchasingDeskService.CaseActions
                                                             on caseActions.header = $self.header,
            /** Retained detector observations; only normalized comparable prices are written here. */
            priceHistory                               : Association to many PurchasingDeskService.RuleLines
                                                             on priceHistory.findingID = $self.caseID,
            assessment                                 : Association to one PurchasingDeskService.PriceAssessments
                                                             on  assessment.PurchaseOrder     = PurchaseOrder
                                                             and assessment.PurchaseOrderItem = PurchaseOrderItem
        };

    type DuplicatePlanningRow {
        Material           : String(40);
        Plant              : String(4);
        BaseUnit           : String(3);
        ProcurementType    : String(1);
        ProcurementSubType : String(2);
        MRPType            : String(2);
        LotSizingProcedure : String(2);
        MRPResponsible     : String(3);
    }

    @readonly
    entity DuplicateMaterials                as
        projection on c.DuplicateMaterials {
            *,
            header                                     : redirected to Cases,
            header.ID             as caseID,
            header.title          as caseTitle,
            header.priority       as casePriority,
            header.status         as caseStatus,
            header.listing        as caseListing,
            header.attention      as caseAttention,
            case
                when header.attention = 'needs_attention'
                     then 'Needs review'
                when header.attention = 'awaiting_decision'
                     then 'Awaiting decision'
                when header.attention = 'waiting_external'
                     then 'Waiting for outcome'
                when header.attention = 'awaiting_source'
                     then 'Waiting for source confirmation'
                when header.attention = 'source_changed'
                     then 'Source evidence changed'
                when header.attention = 'follow_up_overdue'
                     then 'Follow-up overdue'
                when header.attention = 'done'
                     then 'No further action'
                else 'In progress'
            end                   as caseAttentionText : String(32),
            header.sourceRevision as caseSourceRevision,
            header.sourceChanged  as caseSourceChanged,
            header.closure        as caseClosure,
            header.modifiedAt     as caseUpdatedAt,
            caseEvents                                 : Association to many PurchasingDeskService.CaseEvents
                                                             on caseEvents.header = $self.header,
            caseActions                                : Association to many PurchasingDeskService.CaseActions
                                                             on caseActions.header = $self.header,
            candidates                                 : Association to many PurchasingDeskService.RuleLines
                                                             on candidates.findingID = $self.caseID,
            virtual currentPlanning                    : many DuplicatePlanningRow
        };

    @readonly
    entity UnusualSettings                   as
        projection on c.UnusualSettings {
            *,
            header                                     : redirected to Cases,
            header.ID             as caseID,
            header.title          as caseTitle,
            header.priority       as casePriority,
            header.status         as caseStatus,
            header.listing        as caseListing,
            header.attention      as caseAttention,
            case
                when header.attention = 'needs_attention'
                     then 'Needs review'
                when header.attention = 'awaiting_decision'
                     then 'Awaiting decision'
                when header.attention = 'waiting_external'
                     then 'Waiting for outcome'
                when header.attention = 'awaiting_source'
                     then 'Waiting for source confirmation'
                when header.attention = 'source_changed'
                     then 'Source evidence changed'
                when header.attention = 'follow_up_overdue'
                     then 'Follow-up overdue'
                when header.attention = 'done'
                     then 'No further action'
                else 'In progress'
            end                   as caseAttentionText : String(32),
            header.sourceRevision as caseSourceRevision,
            header.sourceChanged  as caseSourceChanged,
            header.closure        as caseClosure,
            header.modifiedAt     as caseUpdatedAt,
            caseEvents                                 : Association to many PurchasingDeskService.CaseEvents
                                                             on caseEvents.header = $self.header,
            caseActions                                : Association to many PurchasingDeskService.CaseActions
                                                             on caseActions.header = $self.header,
            settingPairs                               : Association to many PurchasingDeskService.RuleLines
                                                             on settingPairs.findingID = $self.caseID
        };

    @readonly
    entity SupplierPlannedTimes              as
        projection on c.SupplierPlannedTimes {
            *,
            supplier              as Supplier,
            header                                     : redirected to Cases,
            virtual null          as rangeP10          : Double,
            virtual null          as rangeP50          : Double,
            virtual null          as rangeP80          : Double,
            virtual null          as rangeP90          : Double,
            virtual null          as rangeSource       : String(30),
            header.ID             as caseID,
            header.title          as caseTitle,
            header.priority       as casePriority,
            header.status         as caseStatus,
            header.listing        as caseListing,
            header.attention      as caseAttention,
            case
                when header.attention = 'needs_attention'
                     then 'Needs review'
                when header.attention = 'awaiting_decision'
                     then 'Awaiting decision'
                when header.attention = 'waiting_external'
                     then 'Waiting for outcome'
                when header.attention = 'awaiting_source'
                     then 'Waiting for source confirmation'
                when header.attention = 'source_changed'
                     then 'Source evidence changed'
                when header.attention = 'follow_up_overdue'
                     then 'Follow-up overdue'
                when header.attention = 'done'
                     then 'No further action'
                else 'In progress'
            end                   as caseAttentionText : String(32),
            header.sourceRevision as caseSourceRevision,
            header.sourceChanged  as caseSourceChanged,
            header.closure        as caseClosure,
            header.modifiedAt     as caseUpdatedAt,
            caseEvents                                 : Association to many PurchasingDeskService.CaseEvents
                                                             on caseEvents.header = $self.header,
            caseActions                                : Association to many PurchasingDeskService.CaseActions
                                                             on caseActions.header = $self.header
        };

    @readonly
    entity MaterialPlannedTimes              as
        projection on c.MaterialPlannedTimes {
            *,
            material              as Material,
            plant                 as Plant,
            header                                     : redirected to Cases,
            virtual null          as proposalRule      : String(300),
            header.ID             as caseID,
            header.title          as caseTitle,
            header.priority       as casePriority,
            header.status         as caseStatus,
            header.listing        as caseListing,
            header.attention      as caseAttention,
            case
                when header.attention = 'needs_attention'
                     then 'Needs review'
                when header.attention = 'awaiting_decision'
                     then 'Awaiting decision'
                when header.attention = 'waiting_external'
                     then 'Waiting for outcome'
                when header.attention = 'awaiting_source'
                     then 'Waiting for source confirmation'
                when header.attention = 'source_changed'
                     then 'Source evidence changed'
                when header.attention = 'follow_up_overdue'
                     then 'Follow-up overdue'
                when header.attention = 'done'
                     then 'No further action'
                else 'In progress'
            end                   as caseAttentionText : String(32),
            header.sourceRevision as caseSourceRevision,
            header.sourceChanged  as caseSourceChanged,
            header.closure        as caseClosure,
            header.modifiedAt     as caseUpdatedAt,
            caseEvents                                 : Association to many PurchasingDeskService.CaseEvents
                                                             on caseEvents.header = $self.header,
            caseActions                                : Association to many PurchasingDeskService.CaseActions
                                                             on caseActions.header = $self.header
        };

    @odata.draft.enabled
    @Capabilities.InsertRestrictions.Insertable: false
    @Capabilities.DeleteRestrictions.Deletable : false
    entity RequisitionReviews                as
        projection on c.RequisitionReviews {
            *,
            header : redirected to Cases
        }
        actions {
            action submitReview()    returns RequisitionReviews;
            action reconcileSource() returns RequisitionReviews;
        };

    @readonly
    entity CaseEvents                        as
        projection on c.CaseEvents {
            *,
            case
                when event = 'case_detected'
                     then 'Delivery risk identified'
                when event = 'relisted'
                     then 'Returned to the active worklist'
                when event = 'unlisted'
                     then 'Removed from the active worklist'
                when event = 'source_changed'
                     then 'Source evidence changed'
                when event = 'source_change_reviewed'
                     then 'Source evidence reviewed'
                when event = 'source_resolved'
                     then 'Resolved at source'
                when event = 'exception_accepted'
                     then 'Exception accepted'
                when event = 'case_reopened'
                     then 'Reopened because evidence changed'
                when event = 'delivery_phase_changed'
                     then 'Delivery condition changed'
                when event = 'action_prepared'
                     then 'Approval prepared'
                when event = 'action_approved'
                     then 'Approval approved'
                when event = 'action_resolved'
                     then 'Approval completed'
                when event = 'action_declined'
                     then 'Approval declined'
                when event = 'action_superseded'
                     then 'Approval cancelled because source evidence changed'
                when event = 'action_follow_up_overdue'
                     then 'Approval follow-up overdue'
                else 'Case updated'
            end as eventText : String(80)
        };

    @readonly
    entity CaseActions                       as projection on c.CaseActions;

    @readonly
    entity OperationLocks                    as projection on c.OperationLocks;

    @readonly
    entity ActionEvents                      as projection on c.ActionEvents;

    @readonly
    entity Findings                          as
        projection on c.Finding {
            *,
            case
                when list = 'pdt'
                     then coalesce(
                              lifecycle.status, 'open'
                          )
                else status
            end as status            : String(20),
            case
                when list = 'pdt'
                     then case
                              when lifecycle.status = 'closed'
                                   then 3
                              else 2
                          end
                else statusCriticality
            end as statusCriticality : Integer,
            impact                   : redirected to ItemImpacts,
            actions                  : Association to many PurchasingDeskService.Actions
                                           on actions.problemKey = problemKey,
            /** Timeline of everything recorded for this finding (reminders,
             *  goods receipts, confirmations, recomputes) — feeds the
             *  Activity Log section on the object page. */
            events                   : Association to many PurchasingDeskService.Events
                                           on events.findingID = ID,
            evidenceHistory          : Association to many PurchasingDeskService.FindingEvidence
                                           on evidenceHistory.problemKey = problemKey,
            problemEvents            : Association to many PurchasingDeskService.ProblemEvents
                                           on problemEvents.problemKey = problemKey,
            /** The open PO item of the finding (requested date for "Plan this item"). */
            openItem                 : Association to one PurchasingDeskService.OpenItems
                                           on  openItem.PurchaseOrder     = PurchaseOrder
                                           and openItem.PurchaseOrderItem = PurchaseOrderItem
        }
        actions {
            /**
             * Prepares the finding's next step and leaves it `needs_decision`
             * in Approvals. Decisions are made only from the Approval List.
             */
            action queueForLater(note: String) returns PurchasingDeskService.Actions;
        };

    /** Main buyer worklist: restricted to At Risk and Overdue, independent of UI filters. */
    @readonly
    entity FulfillmentRisks                  as projection on PurchasingDeskService.Findings
                                                where
                                                    list in (
                                                        'at_risk', 'overdue'
                                                    )
        actions {
            action queueForLater(note: String)   returns PurchasingDeskService.Actions;
            /** Close a delivery finding when a supplier confirmation resolves it. */
            action ignoreConfirmed(note: String) returns PurchasingDeskService.Findings;
        };

    /** Type-specific prevention worklists keep object-page contracts focused. */
    @readonly
    entity PriceFindings                     as projection on PurchasingDeskService.Findings
                                                where
                                                    list = 'price'
        actions {
            action prepareFindingAction()                                                         returns PurchasingDeskService.Actions;
            action acceptException(note: String, reviewOn: Date, expectedFingerprint: String(64)) returns PriceFindings;
        };

    @readonly
    entity DuplicateFindings                 as projection on PurchasingDeskService.Findings
                                                where
                                                    list = 'duplicate'
        actions {
            action prepareFindingAction()                                                         returns PurchasingDeskService.Actions;
            action acceptException(note: String, reviewOn: Date, expectedFingerprint: String(64)) returns DuplicateFindings;
        };

    @readonly
    entity RareSettingFindings               as projection on PurchasingDeskService.Findings
                                                where
                                                    list = 'rare'
        actions {
            action prepareFindingAction()                                                         returns PurchasingDeskService.Actions;
            action acceptException(note: String, reviewOn: Date, expectedFingerprint: String(64)) returns RareSettingFindings;
        };

    @readonly
    entity SupplierPlannedTimeFindings       as projection on PurchasingDeskService.Findings
                                                where
                                                    list = 'pdt'
        actions {
            action prepareFindingAction()                                                         returns PurchasingDeskService.Actions;
            action acceptException(note: String, reviewOn: Date, expectedFingerprint: String(64)) returns SupplierPlannedTimeFindings;
        };

    @readonly
    entity MaterialMasterPlannedTimeFindings as projection on PurchasingDeskService.Findings
                                                where
                                                    list = 'mm_pdt'
        actions {
            action prepareFindingAction()                                                         returns PurchasingDeskService.Actions;
            action acceptException(note: String, reviewOn: Date, expectedFingerprint: String(64)) returns MaterialMasterPlannedTimeFindings;
        };

    @readonly
    entity PreventionDispositions            as projection on c.PreventionDisposition;

    @readonly
    entity LineGrids                         as projection on c.LineGrid;

    @readonly
    entity SalesOrderImpacts                 as projection on SalesOrderImpact;

    @readonly
    entity ProductionOrderImpacts            as projection on ProductionOrderImpact;

    @readonly
    entity ItemImpacts                       as
        projection on c.ItemImpact {
            *,
            salesOrderImpacts      : redirected to SalesOrderImpacts,
            productionOrderImpacts : redirected to ProductionOrderImpacts
        };

    @readonly
    entity Confirmations                     as projection on c.Confirmation;

    @readonly
    entity Events                            as projection on c.Event;

    @readonly
    entity Buyers                            as projection on c.Buyer;

    type BufferRow {
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

    type LeadTimeRange {
        Material     : String;
        Supplier     : String;
        Plant        : String;
        source       : String;
        n            : Integer;
        contextLevel : String;
        contextRows  : Integer;
        p10          : Double;
        p50          : Double;
        p80          : Double;
        p90          : Double;
        levels       : LargeString;
        sentence     : String;
    }

    type PlanOrderRow {
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

    type PlanOrder {
        Material     : String;
        Plant        : String;
        Supplier     : String;
        supplierFrom : String;
        needDate     : Date;
        asOf         : Date;
        source       : String;
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
        rows         : many PlanOrderRow;
    }

    type CodeProposal {
        field      : String;
        value      : String;
        text       : String;
        confidence : Double;
        status     : String; // prefilled | review | never_automatic | no_threshold
        rightOf100 : Integer;
        source     : String;
    }

    type SimilarRequest {
        findingID               : String;
        PurchaseRequisition     : String;
        PurchaseRequisitionItem : String;
        text                    : String;
        similarity              : Double;
        MaterialGroup           : String;
        PurchasingGroup         : String;
        Supplier                : String;
    }

    type ThresholdRow {
        threshold      : Double;
        prefilledShare : Double;
        accuracy       : Double;
        low            : Double;
        high           : Double;
        n              : Integer;
        isStored       : Boolean;
    }

    type OverviewKpis {
        atRisk                   : Integer;
        revenueAtRisk            : Double;
        codesPrefilled           : Integer;
        codesTotal               : Integer;
        openPurchaseRequisitions : Integer;
        requestsToReview         : Integer;
        requestsAwaitingApproval : Integer;
        requestsCompleted        : Integer;
        requestReviewPercent     : Integer;
        pdtFindings              : Integer;
        pendingApprovals         : Integer;
        currency                 : String;
    }

    type DayLine {
        ![key] : String;
        text   : String;
        count  : Integer;
        amount : Double;
        list   : String;
    }

    type CountRow {
        dim1  : String;
        dim2  : String;
        count : Integer;
    }

    type Overview {
        kpis          : OverviewKpis;
        dayLines      : many DayLine;
        byListSource  : many CountRow;
        codesByStatus : many CountRow;
        byPlant       : many CountRow;
    }

    type Me {
        userId              : String;
        name                : String;
        PurchasingGroup     : String;
        Plant               : String;
        isAdmin             : Boolean;
        mockAuthentication  : Boolean;
        asOf                : Date;
        datasetName         : String;
        snapshotId          : String;
        snapshotStatus      : String;
        /** True when the completed snapshot recorded non-fatal feature or model-run failures. */
        snapshotHasFailures : Boolean;
        preparedAt          : Timestamp;
        backend             : String;
    }

    type Budget {
        calls     : Integer;
        costUnits : Double;
        limit     : Double;
        remaining : Double;
    }

    // rules (T2): enters a supplier confirmation; returns the item's at_risk / overdue finding, if still open
    action   enterConfirmation(PurchaseOrder: String, PurchaseOrderItem: String, date: Date, quantity: Double)                                                    returns PurchasingDeskService.Findings;
    // leadtimes (T3)
    function bufferSimulator(Material: String, Supplier: String, Plant: String)                                                                                   returns many BufferRow;
    function leadTimeRange(Material: String, Supplier: String, Plant: String, quantity: Double, unit: String(3), needDate: Date, asOf: Date)                      returns LeadTimeRange;
    // planning (T4)
    function planOrder(Material: String, Plant: String, Supplier: String, needDate: Date, force: Boolean, quantity: Double, unit: String(3), currency: String(5)) returns PlanOrder;

    // freetext (T5)
    function proposeCodes(text: String,
                          Plant: String,
                          PurchasingOrganization: String,
                          PurchaseOrderType: String,
                          withSupplier: Boolean)                                                                                                                  returns many CodeProposal;

    function similarRequests(findingID: String)                                                                                                                   returns many SimilarRequest;
    function thresholdSimulator(field: String, segment: String)                                                                                                   returns many ThresholdRow;
    action   acceptConfidentCodes(findingIDs: many String)                                                                                                        returns PurchasingDeskService.Actions;
    // overview (T8a)
    function overview()                                                                                                                                           returns Overview;
    // guard (T8b)
    function me()                                                                                                                                                 returns Me;
    function budget()                                                                                                                                             returns Budget;
// kernel
}

extend PurchasingDeskService.PriceDeviations with actions {
    action prepareAction(responsiblePerson @(title: 'Responsible person'): String not null,
                         responsibleMessage @(title: 'Clarification needed'): String not null,
                         expectedFingerprint: String(64))                 returns PurchasingDeskService.Actions;
    action acceptException(note: String, expectedFingerprint: String(64)) returns PurchasingDeskService.Cases;
};

extend PurchasingDeskService.DuplicateMaterials with actions {
    action prepareAction(expectedFingerprint: String(64))                 returns PurchasingDeskService.Actions;
    action acceptException(note: String, expectedFingerprint: String(64)) returns PurchasingDeskService.Cases;
};

extend PurchasingDeskService.UnusualSettings with actions {
    action prepareAction(expectedFingerprint: String(64))                 returns PurchasingDeskService.Actions;
    action acceptException(note: String, expectedFingerprint: String(64)) returns PurchasingDeskService.Cases;
};

extend PurchasingDeskService.SupplierPlannedTimes with actions {
    action prepareAction(expectedFingerprint: String(64), days: Integer)  returns PurchasingDeskService.Actions;
    action acceptException(note: String, expectedFingerprint: String(64)) returns PurchasingDeskService.Cases;
};

extend PurchasingDeskService.MaterialPlannedTimes with actions {
    action prepareAction(expectedFingerprint: String(64))                 returns PurchasingDeskService.Actions;
    action acceptException(note: String, expectedFingerprint: String(64)) returns PurchasingDeskService.Cases;
};

extend PurchasingDeskService.OpenItems with columns {
    impact : Association to one PurchasingDeskService.ItemImpacts
                 on  impact.PurchaseOrder     = PurchaseOrder
                 and impact.PurchaseOrderItem = PurchaseOrderItem
};

extend PurchasingDeskService.DeliveryRisks with actions {
    action queueForLater(expectedFingerprint: String(64)) returns PurchasingDeskService.Actions;
};
