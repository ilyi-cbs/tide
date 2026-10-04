using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

annotate service.RequisitionReviews with @(
    UI.HeaderInfo: {
        TypeName: 'Purchase Requisition Item', TypeNamePlural: 'Open Purchase Requisitions',
        Title: {Value: requestText}, Description: {Value: PurchaseRequisition}
    },
    UI.SelectionFields: [RequisitionerName, Plant, reviewedPurchasingGroup, reviewStatus, DeliveryDate, requestedAt],
    UI.SelectionPresentationVariant #Open: {
        Text: 'Open Purchase Requisitions',
        SelectionVariant: {SelectOptions: [{PropertyName: reviewStatus, Ranges: [
            {Sign: #I, Option: #EQ, Low: 'new'},
            {Sign: #I, Option: #EQ, Low: 'in_progress'},
            {Sign: #I, Option: #EQ, Low: 'submitted'}
        ]}]},
        PresentationVariant: {
            SortOrder: [{Property: DeliveryDate, Descending: false}],
            Visualizations: ['@UI.LineItem#Open']
        }
    },
    UI.LineItem #Open: [
        {Value: requestText, Label: 'Request', @UI.Importance: #High},
        {Value: PurchaseRequisition, Label: 'Purchase Requisition', @UI.Importance: #High},
        {Value: PurchaseRequisitionItem, Label: 'Item', @UI.Importance: #High},
        {Value: RequisitionerName, Label: 'Requested By', @UI.Importance: #High},
        {Value: requestedAt, Label: 'Requested On', @UI.Importance: #Medium},
        {Value: DeliveryDate, Label: 'Needed By', @UI.Importance: #High},
        {Value: RequestedQuantity, Label: 'Quantity', @Measures.Unit: BaseUnit, @UI.Importance: #Medium},
        {Value: Plant, Label: 'Plant', @UI.Importance: #Medium},
        {Value: reviewedPurchasingGroup, Label: 'Purchasing Group', @UI.Importance: #Medium},
        {Value: readinessSummary, Label: 'Readiness', @UI.Importance: #High},
        {
            Value                    : reviewStatus,
            Label                    : 'Status',
            Criticality              : (reviewStatus == 'submitted' ? 1 : ((reviewStatus == 'done' or reviewStatus == 'cancelled') ? 3 : 2)),
            CriticalityRepresentation: #WithoutIcon,
            @UI.Importance           : #High
        }
    ],
    UI.FieldGroup #Request: {Data: [
        {Value: requestText}, {Value: RequisitionerName}, {Value: requestedAt}, {Value: DeliveryDate},
        {Value: RequestedQuantity}, {Value: BaseUnit}, {Value: Plant}, {Value: PurchasingOrganization},
        {Value: CompanyCode}, {Value: AccountAssignmentCategory}, {Value: sourceChanged}
    ]},
    UI.FieldGroup #Review: {Data: [
        {Value: MaterialGroup}, {Value: materialGroupState},
        {Value: reviewedPurchasingGroup}, {Value: purchasingGroupState},
        {Value: Supplier}, {Value: supplierState}, {Value: buyerNote},
        {Value: readinessSummary}, {Value: reviewStateText}
    ]},
    UI.FieldGroup #Commercial: {Data: [
        {Value: PurchaseRequisitionPrice}, {Value: PurReqnItemCurrency}, {Value: accountAssignments}, {Value: proposals}
    ]},
    UI.Facets: [
        {$Type: 'UI.ReferenceFacet', ID: 'Request', Label: 'Request Details', Target: '@UI.FieldGroup#Request'},
        {$Type: 'UI.ReferenceFacet', ID: 'Review', Label: 'Purchasing and Coding', Target: '@UI.FieldGroup#Review'},
        {$Type: 'UI.ReferenceFacet', ID: 'Commercial', Label: 'Commercial Details', Target: '@UI.FieldGroup#Commercial'}
    ],
    UI.Identification: [
        {$Type: 'UI.DataFieldForAction', Action: 'PurchasingDeskService.submitReview', Label: 'Submit Review'},
        {$Type: 'UI.DataFieldForAction', Action: 'PurchasingDeskService.reconcileSource', Label: 'Reconcile Source'}
    ]
);
