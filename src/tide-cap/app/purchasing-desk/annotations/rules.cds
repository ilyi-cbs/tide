using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

// UI annotations of feature "rules" (stream-owned, contract cockpit.v3 §1).
// The legacy Findings "overdue" tab (list='overdue') is unreachable (no
// manifest route binds it; Overdue is now shown via DeliveryRisks'
// SelectionPresentationVariant #ActionRequired etc., see typedcases.cds /
// deliverycases.cds), so only the still-used RuleLines / Confirmations
// annotations (read by typedcases.cds's DuplicateMaterials / UnusualSettings
// facets) remain here.

annotate service.RuleLines with {
    findingID @UI.Hidden;
    line      @title: 'Line';
    kind      @UI.Hidden;
    label     @title: 'Item';
    text      @title: 'Text';
    date      @title: 'Ordered On';
    amount    @title: 'Price per Unit';
    n1        @title: 'Orders (12 Months)';
    n2        @title: 'Movements (12 Months)';
    n3        @title: 'Together';
    isCurrent @title: 'This Item';
};

annotate service.Confirmations with {
    PurchaseOrder     @title: 'Purchase Order';
    PurchaseOrderItem @title: 'Item';
    line              @title: 'Line';
    date              @title: 'Confirmed Date';
    quantity          @title: 'Quantity';
    enteredBy         @title: 'Entered By';
    enteredAt         @title: 'Entered At';
    origin            @title: 'Entered In';
};
