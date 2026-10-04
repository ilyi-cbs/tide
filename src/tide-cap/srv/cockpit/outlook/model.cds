// Feature "outlook": the delivery outlook of an at_risk / overdue finding
// (object page timeline and options to act), computed on read.
using {PurchasingDeskService} from '../../purchasing-desk-service';
using {tide.cockpit as c} from '../db';
using from '../kernel/kernel';
using from '../atrisk/model';

extend service PurchasingDeskService with {
    type OutlookMarker {
        kind  : String(30);
        date  : Date;
        label : String(80);
    }

    type OutlookBand {
        kind     : String(10);
        ![from]  : Date;
        mid      : Date;
        cautious : Date;
        to       : Date;
        label    : String(80);
    }

    type OutlookOption {
        kind        : String(30);
        title       : String(120);
        reason      : String(300);
        effect      : String(200);
        /** addToApprovals | openAction | confirm | openFinding | simulate; null = information only. */
        operation   : String(30);
        target      : String(120);
        recommended : Boolean;
    }

    /** Dated AI arrival scenario. Levels are planning scenarios, not promises. */
    type OutlookScenario {
        level       : Integer;
        arrivalDate : Date;
    }

    type DeliveryOutlook {
        asOf                 : Date;
        requiredDate         : Date;
        earliestCredibleDate : Date;
        mostLikelyDate       : Date;
        lateRiskDate         : Date;
        daysAfterRequired    : Integer;
        evidenceSource       : String(80);
        comparableDeliveries : Integer;
        calculatedAt         : Timestamp;
        headline             : String(80);
        situation            : String(300);
        estimateSource       : String(80);
        /** Machine-readable forecast origin: tabpfn | empirical | confirmation | sap_planned | none. */
        forecastKind         : String(20);
        plannedDays          : Integer;
        hasAiPrediction      : Boolean;
        /** Predicted chance of arriving by requiredDate, from 0 to 1; TabPFN only. */
        onTimeProbability    : Double;
        requestedDateMissed  : Boolean;
        scenarios            : many OutlookScenario;
        markers              : many OutlookMarker;
        bands                : many OutlookBand;
        agreementText        : String(200);
        options              : many OutlookOption;
    }

    type DeliveryHistoryItem {
        purchaseOrder : String(10);
        item          : String(5);
        ordered       : Date;
        requested     : Date;
        available     : Date;
        leadTimeDays  : Integer;
    }

    type DeliveryHistory {
        observedReceipts     : Integer;
        typicalDays          : Double;
        fastestDays          : Integer;
        slowestDays          : Integer;
        plannedDays          : Double;
        plannedDaysFlag      : String(20);
        recentTrendDays      : Double;
        forecastSource       : String(30);
        forecastAsOf         : Date;
        forecastBasis        : String(30);
        earlyForecastDays    : Double;
        typicalForecastDays  : Double;
        planningForecastDays : Double;
        lateRiskForecastDays : Double;
        confirmedArrival     : Date;
        currentOrderDate     : Date;
        deliveries           : many DeliveryHistoryItem;
    }
}

extend PurchasingDeskService.Findings with actions {
    /** Timeline and options to act of an at_risk / overdue finding; 404 for other lists. */
    function outlook() returns PurchasingDeskService.DeliveryOutlook;
};

// The buyer worklist navigates to FulfillmentRisks, not Findings. Bound
// operations of the source projection are not inherited in OData metadata.
extend PurchasingDeskService.FulfillmentRisks with actions {
    function outlook()         returns PurchasingDeskService.DeliveryOutlook;
    /** Traceable delivery evidence for this material, supplier, and plant. */
    function deliveryHistory() returns PurchasingDeskService.DeliveryHistory;
};

extend PurchasingDeskService.DeliveryRisks with actions {
    function outlook()         returns PurchasingDeskService.DeliveryOutlook;
    function deliveryHistory() returns PurchasingDeskService.DeliveryHistory;
};


// False for every list but at_risk and overdue (object page header and section visibility).
extend PurchasingDeskService.Findings with columns {
    (
           list = 'at_risk'
        or list = 'overdue'
    ) as isDelivery : Boolean
};
