using {tide.cockpit as c} from './cockpit/db';
using {tide.s4 as s4} from '../db/s4';
using {tide.core as core} from '../db/core';

/**
 * Purchasing desk for open-PO priorities, supply risks, approvals, and evidence.
 * Mutations prepare work only; they do not message suppliers or write to SAP.
 */
@path    : 'desk'
@requires: 'user'
service PurchasingDeskService {
    @readonly
    entity Dataset          as projection on s4.DatasetInfo;

    @readonly
    entity Snapshots        as
        projection on c.Snapshot
        excluding {
            workerToken
        };

    /** Open PO items at the as-of date. */
    @readonly
    entity OpenItems        as
        projection on c.OpenItem {
            *,
            PurchaseOrder || '/' || PurchaseOrderItem as ItemKey : String(16),
            sourceRange                                          : redirected to SourceRanges,
            impacts                                              : redirected to CustomerImpacts,
            finding                                              : Association to one SourceFindings
                                                                       on  finding.Material = Material
                                                                       and finding.Supplier = Supplier
                                                                       and finding.Plant    = Plant,
            actions                                              : Association to many Actions
                                                                       on actions.objectKey = ItemKey
        }
        actions {
            /** Recomputes this item's range, status and impact from the current facts. */
            action recompute() returns OpenItems;
        };

    @readonly
    entity CustomerImpacts  as projection on c.CustomerImpact;

    @readonly
    entity SourceRanges     as
        projection on c.SourceRange
        excluding {
            run
        };

    @readonly
    entity Customers        as
        projection on c.CustomerRisk {
            *,
            impacts : Association to many CustomerImpacts
                          on impacts.Customer = Customer
        };

    /** Sources (info records) with an implausible planned delivery time. */
    @readonly
    entity SourceFindings   as
        projection on c.SourceFinding {
            *,
            Material || '|' || Supplier || '|' || Plant as SourceKey : String(60),
            range                                                    : redirected to SourceRanges,
            backtest                                                 : redirected to SourceBacktests,
            openItems                                                : Association to many OpenItems
                                                                           on  openItems.Material = Material
                                                                           and openItems.Supplier = Supplier
                                                                           and openItems.Plant    = Plant,
            actions                                                  : Association to many Actions
                                                                           on actions.objectKey = SourceKey
        }
        actions {
            /** Prepares a change list line for the proposed planned delivery time (approved in Approvals). */
            action addToChangeList(days: Integer) returns Actions;
        };

    @readonly
    entity SourceBacktests  as projection on c.SourceBacktest;

    @readonly
    entity Proof            as projection on c.ProofResult;

    /** Value helps (code + description) for the Findings filter bar. */
    @readonly
    entity Suppliers        as
        projection on s4.Supplier {
            Supplier,
            SupplierName
        };

    @readonly
    entity Plants           as
        projection on s4.Plant {
            Plant,
            PlantName
        };

    @readonly
    entity PurchasingGroups as
        projection on s4.PurchasingGroup {
            PurchasingGroup,
            PurchasingGroupName
        };

    @readonly
    entity Materials        as
        projection on s4.Product {
            Product                        as Material,
            description.ProductDescription as MaterialDescription
        };

    @readonly
    entity FindingStatuses  as projection on c.FindingStatus;

    @readonly
    entity FindingTypes     as projection on c.FindingType;

    annotate Materials with {
        Material  @Common.Text: MaterialDescription  @Common.TextArrangement: #TextFirst;
    };

    @readonly
    entity ApprovalEvents   as projection on c.ApprovalEvent;

    @readonly
    entity ProblemEvents    as projection on c.ProblemEvent;

    @readonly
    entity Actions          as
        projection on c.Actions {
            *,
            /** Current workflow audit trail; all approval transitions write here. */
            actionEvents : Association to many PurchasingDeskService.ActionEvents
                               on actionEvents.action.ID = ID,
            /** Cases affected by this approval, including the case-specific operation. */
            caseActions  : Association to many PurchasingDeskService.CaseActions
                               on caseActions.action.ID = ID,
            /** Compatibility audit trail for clients that read approval events. */
            events       : Association to many ApprovalEvents
                               on events.approval.ID = ID
        }
        actions {
            /** needs_decision -> waiting (outbound/data-change kinds) or resolved (internal-check kinds). */
            action decide(note: String, expectedModifiedAt: Timestamp)           returns Actions;
            /** needs_decision -> declined (buyer chose not to act; the finding stays open). */
            action decline(note: String not null, expectedModifiedAt: Timestamp) returns Actions;
            /** waiting -> resolved: records what happened outside the app (supplier's reply, SAP posting, ...). */
            action logOutcome(resolution: String enum {
                confirmed          @title: 'Supplier confirmed';
                posted             @title: 'Posted outside this application';
                resolved_elsewhere @title: 'Resolved elsewhere';
                escalated          @title: 'Escalated';
            } not null,
                              note: String,
                              expectedModifiedAt: Timestamp)                     returns Actions;
        };

    @readonly
    entity ActionItems      as projection on c.ActionItems;

    @readonly
    entity Problems         as projection on c.Problem;

    @readonly
    entity FindingEvidence  as projection on c.FindingEvidence;

    @readonly
    entity Questions        as
        projection on c.PredictionQuestion
        excluding {
            backtestRun,
            predictionRun
        };

    @readonly
    entity Answers          as projection on c.PredictionAnswer;

    type Kpis {
        asOf                 : Date;
        datasetName          : String;
        containsCustomerData : Boolean;
        preparedAt           : Timestamp;
        backend              : String;
        openItems            : Integer;
        atRisk               : Integer;
        late                 : Integer;
        overdue              : Integer;
        revenueAtRiskP50     : Double;
        revenueAtRiskP80     : Double;
        /** Broader all-open material-plan exposure; it need not equal the worklist headline. */
        allOpenImpactRevenue : Double;
        sourcesToFix         : Integer;
        pendingApprovals     : Integer;
        defaultPdtShare      : Double;
        currency             : String;
    }

    type RequestsWorkflowSummary {
        newItems                   : Integer;
        inProgress                 : Integer;
        awaitingApproval           : Integer;
        approvedDraft              : Integer;
        awaitingSourceConfirmation : Integer;
        completed                  : Integer;
        cancelled                  : Integer;
    }

    type PlanRow {
        quantile         : Double;
        label            : String;
        leadTimeDays     : Double;
        latestOrderDate  : Date;
        earliestDelivery : Date;
        reachable        : Boolean;
        safetyDays       : Double;
    }

    type Plan {
        Material     : String;
        Supplier     : String;
        Plant        : String;
        needDate     : Date;
        asOf         : Date;
        source       : String;
        contextLevel : String;
        n            : Integer;
        plannedDays  : Double;
        plannedFrom  : String;
        sapOrderDate : Date;
        sapFinding   : String;
        rows         : many PlanRow;
    }

    /** KPIs of the current snapshot. */
    function kpis()                                       returns Kpis;

    type CapabilityReadiness {
        capability : String(20);
        status     : String(12);
        reasons    : many String;
    }

    /** Per-capability readiness of the current source load. */
    function sourceReadiness()                            returns many CapabilityReadiness;

    /** Counts PR review items by the buyer-facing workflow stage. */
    function requestsWorkflowSummary()                    returns RequestsWorkflowSummary;

    /** Recomputes the day: facts, ranges (TabPFN where own history is short), status, impact, findings, proof. */
    action   prepareDay(dryRun: Boolean)                  returns Snapshots;

    /** Order timing for one source: latest order date and safety time per quantile. */
    function plan(Material: String not null,
                  Supplier: String not null,
                  Plant: String not null,
                  needDate: Date not null)                returns Plan;

    /** Prepares a reminder draft for open PO items (approved in Approvals). */
    action   prepareReminder(items: many String not null) returns Actions;

    /** Downloadable CSV of a decided action. */
    function exportAction(ID: UUID not null)              returns LargeString;
}

// Each feature keeps its entities, fields, and annotations in <feature>/model.cds.
using from './cockpit/kernel/kernel';
using from './cockpit/atrisk/model';
using from './cockpit/impact/model';
using from './cockpit/rules/model';
using from './cockpit/leadtimes/model';
using from './cockpit/planning/model';
using from './cockpit/freetext/model';
using from './cockpit/feed/model';
using from './cockpit/overview/model';
using from './cockpit/guard/model';
using from './cockpit/outlook/model';
using from './cockpit/ordercontext/model';
using from './cockpit/legacy/finding-model';
using from './cockpit/db';
using from './cockpit/facts';
using from './cockpit/predict-feed';
using from './cockpit/mcp';
