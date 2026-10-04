using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

annotate service.DeliveryRisks with {
    caseID             @UI.Hidden;
    caseTitle          @title: 'Item';
    casePriority       @title: 'Priority';
    caseStatus         @title: 'Case Status';
    caseStatusText     @title: 'Case Status';
    caseListing        @UI.Hidden;
    caseAttention      @title: 'Status';
    caseAttentionText  @UI.Hidden;
    caseSourceRevision @title: 'Source Revision' @UI.Hidden;
    caseSourceChanged  @title: 'Source Changed';
    caseClosure        @title: 'Closure';
    caseClosureText    @title: 'Closure';
    caseUpdatedAt      @title: 'Updated At';
    PurchaseOrder      @title: 'Purchase Order';
    PurchaseOrderItem  @title: 'Item';
    phase              @title: 'Delivery Condition';
    phaseText          @title: 'Delivery Condition';
    dueDate            @title: 'Requested Date';
    predictedArrival   @title: 'Forecast Arrival';
    arrivalSource      @UI.Hidden;
    arrivalSourceText  @title: 'Arrival Basis';
    revenueAtRisk      @title: 'Revenue at Risk' @Measures.ISOCurrency: 'EUR';
    nextActionKind     @UI.Hidden;
    source             @UI.Hidden;
    sourceFingerprint  @UI.Hidden;
    detail             @UI.Hidden;
    Material @title: 'Material' @Common.ValueList: {
        Label: 'Material', CollectionPath: 'Materials', Parameters: [
            {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: Material, ValueListProperty: 'Material'},
            {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'MaterialDescription'}
        ]
    };
    Supplier @title: 'Supplier' @Common.ValueList: {
        Label: 'Supplier', CollectionPath: 'Suppliers', Parameters: [
            {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: Supplier, ValueListProperty: 'Supplier'},
            {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'SupplierName'}
        ]
    };
    Plant @title: 'Plant' @Common.ValueList: {
        Label: 'Plant', CollectionPath: 'Plants', Parameters: [
            {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: Plant, ValueListProperty: 'Plant'},
            {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'PlantName'}
        ]
    };
    PurchasingGroup @title: 'Purchasing Group' @Common.ValueList: {
        Label: 'Purchasing Group', CollectionPath: 'PurchasingGroups', Parameters: [
            {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: PurchasingGroup, ValueListProperty: 'PurchasingGroup'},
            {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'PurchasingGroupName'}
        ]
    };
};

annotate service.DeliveryRisks with @(
    UI.HeaderInfo: {
        TypeName: 'Delivery Risk', TypeNamePlural: 'Delivery Risks',
        Title: {Value: caseTitle}, Description: {Value: PurchaseOrder},
        TypeImageUrl: 'sap-icon://shipping-status'
    },
    UI.SelectionFields: [phase, PurchasingGroup, Plant, Supplier, Material],
    UI.LineItem: [
        {Value: caseTitle, Label: 'Item / PO', @UI.Importance: #High, @HTML5.CssDefaults: {width: '28%'}},
        {Value: Supplier, Label: 'Supplier', @UI.Importance: #High},
        {Value: Plant, Label: 'Plant', @UI.Importance: #High},
        {Value: order.PurchasingOrganization, Label: 'PurchaseOrg', @UI.Importance: #High},
        {
            Value: phase, Label: 'Delivery Condition',
            Criticality: {$edmJson: {$If: [{$Eq: [{$Path: 'phase'}, 'overdue']}, 1, 2]}},
            CriticalityRepresentation: #WithIcon, @UI.Importance: #High
        },
        {Value: casePriority, Label: 'Priority', @UI.Importance: #Medium},
        {Value: dueDate, Label: 'Requested Date', @UI.Importance: #High},
        {Value: predictedArrival, Label: 'Forecast Arrival', @UI.Importance: #High},
        {Value: revenueAtRisk, Label: 'Revenue at Risk', @UI.Importance: #High},
        {Value: caseAttention, Label: 'Status', @UI.Importance: #Medium}
    ],
    UI.PresentationVariant #Open: {
        SortOrder: [{Property: casePriority}, {Property: revenueAtRisk, Descending: true}, {Property: dueDate}, {Property: PurchaseOrder}, {Property: PurchaseOrderItem}],
        Visualizations: ['@UI.LineItem']
    },
    UI.SelectionPresentationVariant #ActionRequired: {
        Text: 'Action required',
        SelectionVariant: {SelectOptions: [
            {PropertyName: caseStatus, Ranges: [{Sign: #I, Option: #EQ, Low: 'open'}]},
            {PropertyName: caseListing, Ranges: [{Sign: #I, Option: #EQ, Low: 'listed'}]},
            {PropertyName: caseAttention, Ranges: [
                {Sign: #I, Option: #EQ, Low: 'needs_attention'},
                {Sign: #I, Option: #EQ, Low: 'source_changed'},
                {Sign: #I, Option: #EQ, Low: 'needs_review'},
                {Sign: #I, Option: #EQ, Low: 'follow_up_overdue'}
            ]}
        ]}, PresentationVariant: {SortOrder: [{Property: casePriority}, {Property: revenueAtRisk, Descending: true}, {Property: dueDate}, {Property: PurchaseOrder}, {Property: PurchaseOrderItem}], Visualizations: ['@UI.LineItem']}
    },
    UI.SelectionPresentationVariant #InProgress: {
        Text: 'In progress',
        SelectionVariant: {SelectOptions: [
            {PropertyName: caseStatus, Ranges: [{Sign: #I, Option: #EQ, Low: 'open'}]},
            {PropertyName: caseListing, Ranges: [{Sign: #I, Option: #EQ, Low: 'listed'}]},
            {PropertyName: caseAttention, Ranges: [{Sign: #I, Option: #EQ, Low: 'in_progress'}]}
        ]}, PresentationVariant: {SortOrder: [{Property: casePriority}, {Property: revenueAtRisk, Descending: true}, {Property: dueDate}, {Property: PurchaseOrder}, {Property: PurchaseOrderItem}], Visualizations: ['@UI.LineItem']}
    },
    UI.SelectionPresentationVariant #Waiting: {
        Text: 'Waiting',
        SelectionVariant: {SelectOptions: [
            {PropertyName: caseStatus, Ranges: [{Sign: #I, Option: #EQ, Low: 'open'}]},
            {PropertyName: caseListing, Ranges: [{Sign: #I, Option: #EQ, Low: 'listed'}]},
            {PropertyName: caseAttention, Ranges: [
                {Sign: #I, Option: #EQ, Low: 'awaiting_decision'},
                {Sign: #I, Option: #EQ, Low: 'waiting_external'},
                {Sign: #I, Option: #EQ, Low: 'awaiting_source'}
            ]}
        ]}, PresentationVariant: {SortOrder: [{Property: casePriority}, {Property: revenueAtRisk, Descending: true}, {Property: dueDate}, {Property: PurchaseOrder}, {Property: PurchaseOrderItem}], Visualizations: ['@UI.LineItem']}
    },
    UI.SelectionPresentationVariant #Done: {
        Text: 'Done',
        SelectionVariant: {SelectOptions: [
            {PropertyName: caseStatus, Ranges: [{Sign: #I, Option: #EQ, Low: 'closed'}]},
            {PropertyName: caseAttention, Ranges: [{Sign: #I, Option: #EQ, Low: 'done'}]}
        ]},
        PresentationVariant: {SortOrder: [{Property: casePriority}, {Property: revenueAtRisk, Descending: true}, {Property: dueDate}, {Property: PurchaseOrder}, {Property: PurchaseOrderItem}], Visualizations: ['@UI.LineItem']}
    },
    UI.DataPoint #RevenueAtRisk: {Value: revenueAtRisk, Title: 'Revenue at Risk', Criticality: #Negative},
    UI.DataPoint #Requested: {Value: dueDate, Title: 'Requested Date'},
    UI.DataPoint #Forecast: {Value: predictedArrival, Title: 'Forecast Arrival'},
    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            ID: 'ReferenceDetails',
            Label: 'Reference Details',
            Target: '@UI.FieldGroup#ReferenceDetails'
        }
    ],
    UI.FieldGroup #ReferenceDetails: {Data: [
        {Value: PurchaseOrder},
        {Value: PurchaseOrderItem},
        {Value: Material},
        {Value: Supplier},
        {Value: Plant},
        {Value: PurchasingGroup},
        {Value: phaseText},
        {Value: dueDate},
        {Value: predictedArrival},
        {Value: arrivalSourceText},
        {Value: revenueAtRisk},
        {Value: caseStatusText},
        {Value: caseClosureText},
        {Value: caseUpdatedAt}
    ]}
);

annotate service.CaseEvents with @(
    UI.LineItem: [
        {Value: occurredAt, Label: 'When', @UI.Importance: #High},
        {Value: eventText, Label: 'Event', @UI.Importance: #High},
        {Value: reason, Label: 'Reason'},
        {Value: actor, Label: 'By'}
    ],
    UI.PresentationVariant: {SortOrder: [{Property: occurredAt, Descending: true}], Visualizations: ['@UI.LineItem']}
);

annotate service.DeliveryRisks actions {
    queueForLater @Core.OperationAvailable: ($self.caseStatus = 'open');
};
