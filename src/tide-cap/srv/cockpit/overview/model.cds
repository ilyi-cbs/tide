namespace tide.cockpit;

using {tide.cockpit as c} from '../db';
using {PurchasingDeskService} from '../../purchasing-desk-service';

/** Priority level of a Finding (bucketed impactCriticality, most severe first): 1 critical, 2 warning, 3 low, 0 none. */
type PriorityLevel         : Integer enum {
    critical = 1;
    warning = 2;
    low = 3;
    none = 0;
}

/** Delivery-work urgency, matching impact/domain/priority.ts. */
type DeliveryPriorityLevel : Integer enum {
    critical = 0;
    high = 1;
    medium = 2;
    low = 3;
}

/**
 * One row per (day, priority level): count of open Findings of that priority
 * on that day. Written once per prepareDay run (overview step, after every
 * other step has finalized impactCriticality for the day); never overwritten
 * for a past day, so this is the Findings-by-priority history for the
 * List Report header chart.
 */
entity FindingsDailyPriority {
    key day      : Date;
    key priority : PriorityLevel;
        count    : Integer;
}

/** Minimal finding state retained for a truthful comparison with the prior completed run. */
entity FindingsDailyState {
    key day             : Date;
    key findingID       : String(120);
        problemKey      : String(160);
        priority        : PriorityLevel;
        revenueAtRisk   : Double;
        Plant           : String(4);
        PurchasingGroup : String(3);
}

/** Daily projection of the latest completed run; not durable history authority. */
entity DeliveryPriorityDaily {
    key day      : Date;
    key priority : DeliveryPriorityLevel;
        count    : Integer;
}

/** Daily compatibility projection; durable scoped state lives in CaseObservation. */
entity DeliveryPriorityDailyState {
    key day             : Date;
    key findingID       : String(120);
        problemKey      : String(160);
        priority        : DeliveryPriorityLevel;
        revenueAtRisk   : Double;
        Plant           : String(4);
        PurchasingGroup : String(3);
}

extend service PurchasingDeskService with {
    /** How a "Top priorities" / "Arrived" row's result was produced, collapsed to 3 trust buckets for a coloured tag; a real Finding never carries 'unknown'. */
    type SourceTag         : String(10) enum {
        ai;
        rule;
        history;
        unknown;
    }

    /** One row of "Top priorities" / "Arrived since this morning" (buyer words only). */
    type BriefItem {
        ID           : String;
        itemTitle    : String;
        /** "Supplier 0001 GmbH · Plant 1010", for identifying the item without a click-through. */
        itemSubtitle : String;
        impactText   : String;
        listText     : String;
        list         : String;
        nextStep     : String;
        dueDate      : Date;
        /** Buyer word of how the result was produced ("AI estimate", "Check", …); NS-B4. */
        sourceText   : String;
        sourceTag    : SourceTag;
    }

    /** One day's revenue at risk, for the header trend sparkline. */
    type TrendPoint {
        asOf          : Date;
        revenueAtRisk : Double;
    }

    /** Open delivery work by operational urgency for one completed day. */
    type PriorityTrendPoint {
        day      : Date;
        critical : Integer;
        high     : Integer;
        medium   : Integer;
        low      : Integer;
        total    : Integer;
    }

    type ChangeSummary {
        comparedDay           : Date;
        newCount              : Integer;
        /** Findings no longer emitted by a detector; not a business-closure outcome. */
        noLongerDetectedCount : Integer;
        escalatedCount        : Integer;
    }

    type RevenueByPriority {
        priority      : String(20);
        findingCount  : Integer;
        revenueAtRisk : Double;
    }

    type SupplierExposure {
        supplier      : String(120);
        findingCount  : Integer;
        criticalCount : Integer;
        revenueAtRisk : Double;
        priority      : String(20);
    }

    @readonly
    entity FindingsDailyPriority as
        projection on c.FindingsDailyPriority {
            *,
            case
                priority
                when 1
                     then 'Critical'
                when 2
                     then 'Warning'
                when 3
                     then 'Low'
                else 'None'
            end as priorityText : String(20)
        };

    @readonly
    entity DeliveryPriorityDaily as projection on c.DeliveryPriorityDaily;

}

extend PurchasingDeskService.OverviewKpis with {
    /** codesTotal - codesPrefilled: proposals still waiting on a person (never automatic + review + no threshold). */
    codesToReview      : Integer;
    /** Open prevention findings across price, duplicate, rare, pdt, and mm_pdt. */
    preventionFindings : Integer;
    /** True when some at-risk deliveries lack a customer value; revenueAtRisk is then a lower bound. */
    revenuePartial     : Boolean;
}

extend PurchasingDeskService.Overview with {
    publication       : PurchasingDeskService.PublicationInfo;
    /** As-of date of the loaded dataset; refreshed on every call. */
    asOf              : Date;
    /** When the current snapshot finished; null before the first run. */
    preparedAt        : Timestamp;
    /** Plain-language summary of the KPIs, built by template (no model call). */
    narrative         : String;
    /** Revenue at risk of the last few real snapshots, oldest first: the header trend sparkline. */
    trend             : many PurchasingDeskService.TrendPoint;
    /** Open findings by severity for recent days, oldest first: the Findings header trend. */
    priorityTrend     : many PurchasingDeskService.PriorityTrendPoint;
    /** Worst-first (impact severity, then revenue at risk) across every open list: the single most valuable thing to look at first. */
    topPriorities     : many PurchasingDeskService.BriefItem;
    /** Findings checked as they arrived today (Finding.trigger = 'arrived'), not in this morning's run. */
    arrivedToday      : many PurchasingDeskService.BriefItem;
    /** Null until two completed preparation runs exist. */
    changeSummary     : PurchasingDeskService.ChangeSummary;
    revenueByPriority : many PurchasingDeskService.RevenueByPriority;
    topSuppliers      : many PurchasingDeskService.SupplierExposure;
}

extend service PurchasingDeskService with {
    type PublicationHistory {
        trend         : many PurchasingDeskService.TrendPoint;
        priorityTrend : many PurchasingDeskService.PriorityTrendPoint;
        changeSummary : PurchasingDeskService.ChangeSummary;
        windowDays    : Integer;
        coveredDays   : Integer;
        source        : String(20);
    }

    function publicationHistory(windowDays: Integer) returns PublicationHistory;

    type PublicationInfo {
        snapshotID   : UUID;
        asOf         : Date;
        publishedAt  : Timestamp;
        source       : String(20);
        completeness : String(20);
        liveWorkflow : Boolean;
        windowDays   : Integer;
        coveredDays  : Integer;
    }
}
