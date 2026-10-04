using {tide.cockpit as c} from '../db';
using {PurchasingDeskService} from '../../purchasing-desk-service';

/**
 * Revenue at risk over all open PO items of the snapshot (P-2 KPI): net
 * value of the affected sales orders, each counted once. Writer: impact.
 */
extend c.Snapshot with {
    impactRevenueAtRisk : Double;
}

/** Buyer words stored with the impact, so the UI formats nothing itself. */
extend c.ItemImpact with {
    impactLevelText : String(60); // kernel impactText(level)
    impactKindText  : String(40); // buyer words of materialKind
    /** JSON [{key: "SO/item", netAmount}] of the affected sales order items, so totals count each once. */
    salesOrderKeys  : LargeString;
}

extend service PurchasingDeskService with {
    type BusinessImpactSalesOrder {
        SalesOrder         : String(10);
        SalesOrderItem     : String(6);
        Customer           : String(10);
        CustomerName       : String(120);
        RequiredDate       : Date;
        PredictedDelayDays : Integer;
        RevenueAtRisk      : Double;
        Currency           : String(3);
    }

    type BusinessImpactProductionOrder {
        ProductionOrder       : String(12);
        FinishedProduct       : String(40);
        RequiredDate          : Date;
        PredictedShortageDays : Integer;
        AffectedQuantity      : Double;
        Unit                  : String(3);
    }

    type BusinessImpactScenario {
        level             : Double;
        arrival           : Date;
        revenue           : Double;
        customerDelayDays : Integer;
    }

    type BusinessImpactPlanningRow {
        date        : Date;
        element     : String(10);
        elementText : String(80);
        id          : String(80);
        qty         : Double;
        available   : Double;
        own         : Boolean;
        affected    : Boolean;
    }

    /** Buyer-facing impact detail for one delivery case. */
    type BusinessImpact {
        level             : String(30);
        impactLevelText   : String(60);
        PurchaseOrder     : String(10);
        PurchaseOrderItem : String(6);
        materialKind      : String(30);
        impactKindText    : String(40);
        kindNote          : String(200);
        expectedDate      : Date;
        cautiousDate      : Date;
        confirmedDate     : Date;
        arrivalSource     : String(30);
        needDate          : Date;
        delayDays         : Integer;
        customerDelayDays : Integer;
        revenueAtRisk     : Double;
        revenueCautious   : Double;
        shortageFrom      : Date;
        shortageDays      : Integer;
        coverageDays      : Double;
        stock             : Double;
        note              : String(300);
        salesOrders       : many BusinessImpactSalesOrder;
        productionOrders  : many BusinessImpactProductionOrder;
        scenarios         : many BusinessImpactScenario;
        planningRows      : many BusinessImpactPlanningRow;
    }
}

extend PurchasingDeskService.DeliveryRisks with actions {
    /** Current downstream customer, production, and stock impact for this delivery case. */
    function businessImpact() returns PurchasingDeskService.BusinessImpact;
};
