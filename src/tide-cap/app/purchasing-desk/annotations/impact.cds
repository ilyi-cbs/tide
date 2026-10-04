using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

// UI annotations of feature "impact" (stream-owned, contract cockpit.v3 §1).
// ItemImpacts is read by the custom ImpactSection (Findings.impact,
// OpenItems.impact); the labels serve value lists, tables and the assistant.

annotate service.ItemImpacts with @(
    UI.HeaderInfo      : {
        TypeName      : 'Impact',
        TypeNamePlural: 'Impacts',
        Title         : {Value: PurchaseOrder},
        Description   : {Value: PurchaseOrderItem}
    },
    UI.LineItem        : [
        {Value: PurchaseOrder},
        {Value: PurchaseOrderItem},
        {Value: expectedDate},
        {Value: delayDays},
        {Value: revenueAtRisk},
        {Value: customerDelayDays},
        {Value: shortageFrom},
        {Value: productionOrders},
        {Value: salesOrders}
    ],
    UI.PresentationVariant: {SortOrder: [
        {Property: rank},
        {Property: revenueAtRisk, Descending: true}
    ]}
) {
    PurchaseOrder     @title: 'Purchase order';
    PurchaseOrderItem @title: 'Item';
    level             @title: 'Impact';
    rank              @UI.Hidden;
    materialKind      @title: 'Material';
    kindNote          @title: 'Material note';
    expectedDate      @title: 'Expected arrival';
    cautiousDate      @title: 'If it takes longer than usual';
    confirmedDate     @title: 'Confirmed date';
    needDate          @title: 'Needed on';
    delayDays         @title: 'Later than requested (days)';
    customerDelayDays @title: 'Customer delay (days)';
    revenueAtRisk     @title: 'Revenue at risk (EUR)'   @Measures.ISOCurrency: 'EUR';
    revenueCautious   @title: 'Revenue at risk if slower (EUR)' @Measures.ISOCurrency: 'EUR';
    shortageFrom      @title: 'Stock runs short from';
    shortageDays      @title: 'Short for (working days)';
    coverageDays      @title: 'Stock covers (working days)';
    stock             @title: 'Stock';
    productionOrders  @title: 'Affected production orders';
    salesOrders       @title: 'Affected sales orders';
    note              @title: 'Note';
    scenarios         @UI.Hidden;
    md04              @UI.Hidden;
    chain             @UI.Hidden;
    source            @UI.Hidden;
    snapshot          @UI.Hidden;
};

annotate service.SalesOrderImpacts with @(
    UI.LineItem: [
        {Value: SalesOrder, Label: 'Sales order', @UI.Importance: #High},
        {Value: SalesOrderItem, Label: 'Item', @UI.Importance: #Medium},
        {Value: CustomerName, Label: 'Customer', @UI.Importance: #High},
        {Value: RequiredDate, Label: 'Required', @UI.Importance: #High},
        {Value: PredictedDelayDays, Label: 'Delay (days)', @UI.Importance: #Medium},
        {Value: RevenueAtRisk, Label: 'Revenue at risk', @UI.Importance: #High}
    ]
) {
    RevenueAtRisk @Measures.ISOCurrency: Currency;
};

annotate service.ProductionOrderImpacts with @(
    UI.LineItem: [
        {Value: ProductionOrder, Label: 'Production order', @UI.Importance: #High},
        {Value: FinishedProduct, Label: 'Finished product', @UI.Importance: #High},
        {Value: RequiredDate, Label: 'Required', @UI.Importance: #High},
        {Value: PredictedShortageDays, Label: 'Shortage (days)', @UI.Importance: #Medium},
        {Value: AffectedQuantity, Label: 'Affected quantity', @UI.Importance: #Medium}
    ]
) {
    AffectedQuantity @Measures.Unit: Unit;
};
