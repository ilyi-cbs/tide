using {tide.cockpit as c} from './db';

// ------------------------------------------------------------------ P-8 data

/**
 * Rows of one prediction on request (context and rows to score), written
 * per question by predict.ts; the model reads them through the feed below.
 * `rowKey` = `<question>|<role>|<PurchaseOrder/Item>`.
 */
entity tide.cockpit.PredictRow {
    key rowKey            : String(80);
        question          : String(36);
        role              : String(10); // backtest | predict
        Plant             : String(4);
        PurchasingGroup   : String(3);
        Supplier          : String(10);
        SupplierRegion    : String(10);
        MaterialType      : String(4);
        MaterialGroup     : String(9);
        PlannedDays       : Double;
        PlannedStatus     : String(20);
        RequestedGapDays  : Integer;
        OrderQuantity     : Double;
        NetAmount         : Double;
        POMonth           : String(2);
        OwnPastDeliveries : Integer;
        yClass            : String(3);
        yDays             : Double;
}

/** Predict on request (P-8): the 13 features known at PO creation, and the per-question label. */
@feed
@feed.key    : 'rowKey'
@feed.dataset: 's4'
define view tide.cockpit.CockpitPredictFeed as
    select from tide.cockpit.PredictRow {
        key rowKey,
            @feed.role: #outcome
            question,
            @feed.role: #outcome
            role,
            Plant,
            PurchasingGroup,
            Supplier,
            SupplierRegion,
            MaterialType,
            MaterialGroup,
            PlannedDays,
            PlannedStatus,
            RequestedGapDays,
            OrderQuantity,
            NetAmount,
            POMonth,
            OwnPastDeliveries,
            @feed.role: #target
            yClass,
            @feed.role: #target
            yDays
    };

extend tide.cockpit.PredictionQuestion with {
    /** P-8 result (JSON): request, filters, check, rows, notes; see predict.ts. */
    chatResult : LargeString;
}
