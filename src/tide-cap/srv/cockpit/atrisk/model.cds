namespace tide.cockpit;

using {tide.cockpit as c} from '../db';
using {tide.core as core} from '../../../db/core';
using {PurchasingDeskService} from '../../purchasing-desk-service';
using from '../kernel/kernel';

/**
 * When a line grid was computed (morning run, arriving PO item, goods receipt
 * of the same key) and the buyer texts of its range, written with the grid:
 * the section displays them and computes nothing (north star NS-I2).
 */
extend c.LineGrid with {
    atriskTrigger         : String(10) enum {
        morning;
        arrived;
        receipt;
    } default 'morning';
    atriskComputedAt      : Timestamp;
    atriskGapDays         : Integer;
    atriskPlannedDays     : Double;
    atriskSentence        : String(300);
    atriskWords           : String(300);
    atriskNote            : String(120);
    modelRun              : Association to core.PredictionRun;
    modelInputFingerprint : String(64);
    modelBackend          : String(40);
    modelTrainingRows     : Integer;
    modelFallback         : String(100);
    ownLevels             : LargeString;
    ownP10                : Double;
    ownP50                : Double;
    ownP80                : Double;
    ownP90                : Double;
    agreement             : String(10);
    /**
     * Arrival of the still-open item (kernel/arrival): the grid conditioned on
     * "not arrived by arrivalAsOf", else past deliveries that took at least as
     * long (survivors), else none. Impact reads openLevels before levels.
     */
    arrivalAsOf           : Date;
    openLevels            : LargeString;
    openBasis             : String(10) enum {
        grid;
        survivors;
        none;
    };
    openSource            : c.Source;
    arrivalP10            : Date;
    arrivalP50            : Date;
    arrivalP80            : Date;
    arrivalP90            : Date;
    ownArrivalP10         : Date;
    ownArrivalP50         : Date;
    ownArrivalP90         : Date;
    /** Days from the requested date to arrivalP50 (negative = before). */
    arrivalLateDays       : Integer;
    /** Chance of arriving after the requested date given still open; null once the requested date has passed. */
    chanceLate            : Double;
    chanceWords           : String(20);
    chanceText            : String(200);
    arrivalText           : String(300);
}

/** The line grid of a finding's PO item (at risk section, impact, planning). */
extend PurchasingDeskService.Findings with columns {
    lineGrid : Association to PurchasingDeskService.LineGrids
                   on  lineGrid.PurchaseOrder     = PurchaseOrder
                   and lineGrid.PurchaseOrderItem = PurchaseOrderItem
};

/** Typed rationale for an at-risk delivery finding. */
entity AtRiskDetail {
    key finding        : Association to one c.Finding;
        source         : c.Source;
        lateShare      : Double;
        gapDays        : Double;
        plannedDays    : Double;
        plannedFlag    : String(20);
        riskRank       : Integer;
        ruleVerdict    : String(20);
        ownDeliveries  : Integer;
        contextLevel   : String(40);
        gridRef        : String(200);
        fastDays       : Double;
        typicalDays    : Double;
        slowDays       : Double;
        dueCriticality : Integer;
}

extend service PurchasingDeskService with {
    @readonly
    entity AtRiskDetails as projection on AtRiskDetail;
}

extend PurchasingDeskService.Findings with columns {
    atRiskDetail : Association to one PurchasingDeskService.AtRiskDetails
                       on atRiskDetail.finding = $self
};
