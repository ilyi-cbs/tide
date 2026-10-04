using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

/*
 * The legacy `Findings` / `FulfillmentRisks` list (and its FindingStatuses /
 * FindingTypes / ProblemEvents value helps) is unreachable: no manifest
 * route binds it any more ("FindingsList" is a pure URL redirect to
 * DeliveryRisksList; the live worklist/prevention/requests UI is on
 * DeliveryRisks / PriceDeviations / DuplicateMaterials / UnusualSettings /
 * SupplierPlannedTimes / MaterialPlannedTimes / PurchaseRequisitionReviews,
 * see typedcases.cds / deliverycases.cds / requisition.cds). Only the
 * shared value-help entities below (still referenced by CollectionPath from
 * deliverycases.cds / freetext.cds / typedcases.cds) remain here.
 */

// Value help dialogs consistently show a searchable key and description column.
annotate service.Materials with @(UI.LineItem: [
    {
        Value         : Material,
        Label         : 'ID',
        @UI.Importance: #High
    },
    {
        Value         : MaterialDescription,
        Label         : 'Description',
        @UI.Importance: #High
    }
]);

annotate service.Suppliers with @(UI.LineItem: [
    {
        Value         : Supplier,
        Label         : 'ID',
        @UI.Importance: #High
    },
    {
        Value         : SupplierName,
        Label         : 'Description',
        @UI.Importance: #High
    }
]);

annotate service.Plants with @(UI.LineItem: [
    {
        Value         : Plant,
        Label         : 'ID',
        @UI.Importance: #High
    },
    {
        Value         : PlantName,
        Label         : 'Description',
        @UI.Importance: #High
    }
]);

annotate service.PurchasingGroups with @(UI.LineItem: [
    {
        Value         : PurchasingGroup,
        Label         : 'ID',
        @UI.Importance: #High
    },
    {
        Value         : PurchasingGroupName,
        Label         : 'Description',
        @UI.Importance: #High
    }
]);
