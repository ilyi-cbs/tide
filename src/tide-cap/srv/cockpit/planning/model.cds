using {tide.cockpit as c} from '../db';
using {tide.s4 as s4} from '../../../db/s4';
using {PurchasingDeskService} from '../../purchasing-desk-service';

// Buyer word of `source` (kernel sourceText) and descriptions for the fields
// entered, so the page shows no copy of the word list and no separate lookup
// after Calculate. Master-data fields (info record number/date, since when a
// material/supplier pair has been known, goods receipt time, feasibility and
// the master-data verdict) drive the Delivery Simulation status header and
// its "Lead-Time Master Data Check" panel.
extend PurchasingDeskService.PlanOrder with {
    sourceText               : String;
    MaterialText             : String;
    PlantName                : String;
    SupplierName             : String;
    plannedSince             : Date;
    plannedInfoRecord        : String;
    goodsReceiptDays         : Double;
    materialSince            : Date;
    supplierSince            : Date;
    feasible                 : Boolean;
    earliestAchievableDate   : Date;
    masterDataDirection      : String; // too_short | too_long | plausible
    masterDataTypicalDays    : Double;
    masterDataP80Days        : Double;
    masterDataGapDays        : Double;
    priceP10                 : Double;
    priceP50                 : Double;
    priceP90                 : Double;
    historicalPriceReference : Double;
    historicalPriceCount     : Integer;
    priceSource              : String;
    priceReason              : String;
    priceBackend             : String;
    priceRunID               : UUID;
    priceInputFingerprint    : String(64);
    priceComputedAt          : Timestamp;
    priceTrainingRows        : Integer;
    priceContextScope        : String(200);
    assumedPriceQuantity     : Double;
    assumedPriceUnit         : String(3);
    assumedPriceCurrency     : String(5);
    ownLevels                : LargeString;
    rangeAgreement           : String(10);
    modelRunID               : UUID;
    modelBackend             : String(40);
    modelTrainingRows        : Integer;
    modelFallback            : String(200);
}

/** Value help of the plant field: every plant, code + name. */
@readonly
entity PurchasingDeskService.PlanningPlants    as
    projection on s4.Plant {
        Plant,
        PlantName
    };

/**
 * Value help of the material field, scoped to the plant already entered: only
 * materials actually maintained there (ProductPlantSupplyPlanning), so a pick
 * can never fail planOrder's "not maintained in plant" check. The page must
 * filter by Plant; unfiltered use would defeat the purpose.
 */
define view PlanningMaterialSource as
    select from s4.ProductPlantSupplyPlanning as pp
    left join s4.ProductDescription as d
        on  d.Product  = pp.Product
        and d.Language = 'EN'
    {
        key pp.Product           as Material,
        key pp.Plant,
            d.ProductDescription as MaterialText
    };

@readonly
entity PurchasingDeskService.PlanningMaterials as projection on PlanningMaterialSource;

/** Value help of the supplier field, unfiltered fallback: every known supplier. */
@readonly
entity PurchasingDeskService.PlanningSuppliers as
    projection on s4.Supplier {
        Supplier,
        SupplierName
    };

/**
 * Value help of the supplier field, filtered to material + plant: the
 * sources this material already has, from purchase orders and info records,
 * each with the supplier's name and how it is known. Read via the
 * `planningSources` function (a plain query cannot union two S/4 tables).
 */
extend service PurchasingDeskService with {
    type PlanningSource {
        Supplier     : String;
        SupplierName : String;
        ![from]      : String; // latest order | latest info record
        lastDate     : Date;
    }

    /** One supplier option, including its delivery and expected-price estimates. */
    type SupplierSimulation {
        Supplier             : String;
        SupplierName         : String;
        source               : String;
        forecastSource       : String;
        error                : String(200);
        p50Date              : Date;
        p80Date              : Date;
        p90Date              : Date;
        p50Reachable         : Boolean;
        p80Reachable         : Boolean;
        p90Reachable         : Boolean;
        priceP10             : Double;
        priceP50             : Double;
        priceP90             : Double;
        priceSource          : String;
        priceReason          : String(200);
        priceTrainingRows    : Integer;
        priceContextScope    : String(200);
        assumedPriceCurrency : String(5);
        assumedPriceUnit     : String(3);
        assumedPriceQuantity : Double;
    }

    type SupplierComparison {
        asOf     : Date;
        needDate : Date;
        options  : many SupplierSimulation;
    }

    function planningSources(Material: String, Plant: String)                                                                                          returns many PlanningSource;
    function compareSuppliers(Material: String, Plant: String, needDate: Date, force: Boolean, quantity: Double, unit: String(3), currency: String(5)) returns SupplierComparison;
}
