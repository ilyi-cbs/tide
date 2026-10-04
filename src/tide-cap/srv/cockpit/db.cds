namespace tide.cockpit;

using {
    cuid,
    managed
} from '@sap/cds/common';
using {tide.core as core} from '../../db/core';
using {tide.cockpit.ItemFact} from '../../db/assessment';
using from '../../db/publication';
using from './facts';

/**
 * Read model of the buyer cockpit, written by PurchasingDeskService.prepareDay for
 * the as-of date of the loaded dataset (tide.s4.DatasetInfo). Nothing here
 * is edited by users; decisions live in Actions.
 *
 * Lead time = PO date -> availability: the first unreversed 101, or the
 * release 109 after a receipt into quality inspection (107). Days are
 * calendar days.
 *
 * Every predicted number carries its source:
 *   rule      deterministic check (overdue, planned delivery time placeholder)
 *   lookup    value from master data
 *   empirical quantiles of at least EMPIRICAL_MIN own lead times
 *   tabpfn    TabPFN quantiles from similar deliveries of the plant
 *   fallback  context quantiles without a model call (too little variation)
 *
 * Lead-time ranges (SourceRange, LineGrid, SourceFinding) are multi-sourced:
 * TabPFN is always the primary/AI estimate (source = tabpfn) whenever a model
 * call succeeds; the own-history (empirical) range is computed in addition
 * whenever the source has >= EMPIRICAL_MIN own lead times and stored as
 * secondary evidence (own* columns). `agreement` tells the buyer whether the
 * two estimates line up: aligned (own p50 within the AI's p10-p90 and vice
        evaluatedTo      : Date;
        source           : Source;
}

/** A prepared approval: nothing is sent or written to SAP until it is decided. */
entity Actions : cuid, managed {
    kind         : String(20) enum {
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
    };
    status       : String(20) enum {
        needs_decision;
        waiting;
        resolved;
        declined;
    } default 'needs_decision';
    /** Object the action is about, e.g. PO item "4500000001/10" or source "M|S|P". */
    objectKey    : String(80);
    title        : String(200);
    summary      : String(1000);
    preparedVia  : String(10) enum {
        app;
        chat;
    };
    decidedBy    : String(80);
    decidedAt    : Timestamp;
    decisionNote : String(500);
    items        : Composition of many ActionItems
                       on items.action = $self;
}

entity ActionItems : cuid {
    action    : Association to Actions;
    line      : Integer;
    objectKey : String(80);
    field     : String(40);
    oldValue  : String(80);
    newValue  : String(80);
    text      : String(1000);
}

/** Predict on request: a backtest gate before any ranking is shown. */
entity PredictionQuestion : cuid, managed {
    target        : String(30);
    lateDays      : Integer;
    filters       : LargeString; // JSON
    status        : String(20) enum {
        checking;
        predicting;
        passed;
        refused;
        too_little;
        failed;
    };
    verdict       : String(300);
    evaluated     : Integer;
    positives     : Integer;
    auc           : Double;
    top10Hits     : Integer;
    baseRate      : Double;
    mae           : Double;
    baselineMae   : Double;
    cutoff        : Date;
    backtestRun   : Association to core.PredictionRun;
    predictionRun : Association to core.PredictionRun;
    openItems     : Integer;
    rows          : Composition of many PredictionAnswer
                        on rows.question = $self;
}

entity PredictionAnswer {
    key question          : Association to PredictionQuestion;
    key rank              : Integer;
        PurchaseOrder     : String(10);
        PurchaseOrderItem : String(5);
        Material          : String(40);
        Supplier          : String(10);
        Plant             : String(4);
        RequestedDate     : Date;
        score             : Double;
        p10               : Double;
        p50               : Double;
        p90               : Double;
}

/**
 * Lead time per PO item for TabPFN: features known when the order is
 * created (the requested gap included), target = days from PO date to
 * availability.
 */
@feed
@feed.key    : 'id'
@feed.dataset: 's4'
define view CockpitLeadTimeFeed as
    select from ItemFact {
        key PurchaseOrder || '/' || PurchaseOrderItem as id : String,
            Material,
            MaterialGroup,
            MaterialType,
            Plant,
            Supplier,
            SupplierCountry,
            PurchasingGroup,
            PurchaseOrderType,
            Category,
            OrderQuantity,
            NetAmountEUR,
            PlannedDays,
            RequestedGapDays,
            PurchaseOrderMonth,
            @feed.role: #outcome
            PurchaseOrderDate,
            @feed.role: #outcome
            AvailableDate,
            @feed.role: #target
            LeadTimeDays
    };

/**
 * Classification targets for "predict on request", known only after the
 * outcome: late by more than N days (from availability vs. requested date)
 * and a partial first receipt.
 */
@feed
@feed.key    : 'id'
@feed.dataset: 's4'
define view CockpitOutcomeFeed as
    select from ItemFact {
        key PurchaseOrder || '/' || PurchaseOrderItem as id       : String,
            Material,
            MaterialGroup,
            MaterialType,
            Plant,
            Supplier,
            SupplierCountry,
            PurchasingGroup,
            PurchaseOrderType,
            Category,
            OrderQuantity,
            NetAmountEUR,
            PlannedDays,
            RequestedGapDays,
            PurchaseOrderMonth,
            @feed.role: #outcome
            PurchaseOrderDate,
            @feed.role: #outcome
            RequestedDate,
            @feed.role: #outcome
            AvailableDate,
            @feed.role: #outcome
            days_between(
                RequestedDate, AvailableDate
            )                                         as DaysLate : Integer,
            @feed.role: #target
            case
                when AvailableDate is null
                     then null
                when days_between(
                         RequestedDate, AvailableDate
                     ) > 0
                     then 'yes'
                else 'no'
            end                                       as Late0    : String,
            @feed.role: #target
            case
                when AvailableDate is null
                     then null
                when days_between(
                         RequestedDate, AvailableDate
                     ) > 7
                     then 'yes'
                else 'no'
            end                                       as Late7    : String,
            @feed.role: #target
            case
                when AvailableDate is null
                     then null
                when days_between(
                         RequestedDate, AvailableDate
                     ) > 14
                     then 'yes'
                else 'no'
            end                                       as Late14   : String,
            @feed.role: #target
            case
                when AvailableDate is null
                     or PartialFirstReceipt is null
                     then null
                when PartialFirstReceipt = true
                     then 'yes'
                else 'no'
            end                                       as Partial  : String
    };
