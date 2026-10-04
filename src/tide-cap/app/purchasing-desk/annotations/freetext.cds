using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';
using from '../../../srv/cockpit/freetext/model';
using from './findings';

annotate service.FreetextProposals with {
    fieldText   @title: 'Field';
    value       @title: 'Suggested Value';
    statusText  @title: 'Status';
    words       @title: 'Basis';
    similarSame @title: 'Similar Requests';
};

annotate service.PurchaseRequisitionReviews with {
    PurchaseRequisition                 @title: 'Purchase Requisition'         @readonly;
    PurchaseRequisitionItem             @title: 'Item'                         @readonly;
    Plant                               @UI.Hidden;
    PurchasingGroup                     @UI.Hidden;
    routedBuyer                         @title: 'Assigned To';
    routedGroup                         @UI.Hidden;
    sourceRevision                      @UI.Hidden;
    workingCopyVersion                  @UI.Hidden;
    fieldOrigins                        @UI.Hidden;
    reviewLocked                        @UI.Hidden;
    materialGroupState                  @UI.Hidden;
    purchasingGroupState                @UI.Hidden;
    supplierState                       @UI.Hidden;
    accountAssignmentCategoryState      @UI.Hidden;
    itemCategoryState                   @UI.Hidden;
    materialState                       @UI.Hidden;
    infoRecordState                     @UI.Hidden;
    predictionGeneration                @UI.Hidden;
    materialGroupName                   @UI.Hidden                             @readonly;
    purchasingGroupName                 @UI.Hidden                             @readonly;
    supplierName                        @UI.Hidden                             @readonly;
    MaterialGroup                       @title: 'Material Group'               @Common.Text                    : materialGroupName    @Common.TextArrangement: #TextLast  @Common.ValueList: {
        Label         : 'Material Group',
        CollectionPath: 'MaterialGroups',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: MaterialGroup,
                ValueListProperty: 'ProductGroup'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'ProductGroupName'
            }
        ]
    };
    reviewedPurchasingGroup             @title: 'Purchasing Group'             @Common.Text                    : purchasingGroupName  @Common.TextArrangement: #TextLast  @Common.ValueList: {
        Label         : 'Purchasing Group',
        CollectionPath: 'PurchasingGroups',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: reviewedPurchasingGroup,
                ValueListProperty: 'PurchasingGroup'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'PurchasingGroupName'
            }
        ]
    };
    Supplier                            @title: 'Supplier'                     @Common.Text                    : supplierName         @Common.TextArrangement: #TextLast  @Common.ValueList: {
        Label         : 'Supplier',
        CollectionPath: 'Suppliers',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: Supplier,
                ValueListProperty: 'Supplier'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'SupplierName'
            }
        ]
    };
    buyerNote                           @title: 'Buyer Note'                   @UI.MultiLineText;
    requestText                         @title: 'Original Request'             @UI.MultiLineText;
    itemLongText                        @title: 'Item long text'               @UI.MultiLineText;
    headerNote                          @title: 'Header note'                  @UI.MultiLineText;
    RequisitionerName                   @title: 'Requested By'                 @Common.ValueList               : {
        CollectionPath: 'Requisitioners',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: RequisitionerName,
            ValueListProperty: 'RequisitionerName'
        }]
    };
    requestedAt                         @title: 'Requested On';
    DeliveryDate                        @title: 'Needed By';
    RequestedQuantity                   @title: 'Quantity'                     @Measures.Unit                  : BaseUnit;
    BaseUnit                            @title: 'Unit';
    reviewedShortText                   @title: 'Short description';
    reviewedLongText                    @title: 'Item long text'               @UI.MultiLineText;
    reviewedHeaderNote                  @title: 'Header note'                  @UI.MultiLineText;
    reviewedPrType                      @title: 'PR type';
    reviewedItemCategory                @title: 'Item category'                @Common.ValueListWithFixedValues: true                 @Common.ValueList      : {
        Label         : 'Item category',
        CollectionPath: 'RequestItemCategories',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: reviewedItemCategory,
            ValueListProperty: 'Category'
        }]
    };
    reviewedMaterial                    @title: 'Material';
    reviewedQuantity                    @title: 'Quantity'                     @Measures.Unit                  : reviewedUnit;
    reviewedUnit                        @title: 'Unit';
    reviewedDeliveryDate                @title: 'Required date';
    reviewedPlant                       @title: 'Plant';
    reviewedStorageLocation             @title: 'Storage location';
    reviewedCompanyCode                 @title: 'Company code';
    reviewedPurchasingOrganization      @title: 'Purchasing organisation';
    reviewedAccountAssignmentCategory   @title: 'Account assignment category'  @Common.ValueListWithFixedValues: true                 @Common.ValueList      : {
        Label         : 'Account assignment category',
        CollectionPath: 'RequestAccountAssignmentCategories',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: reviewedAccountAssignmentCategory,
            ValueListProperty: 'Category'
        }]
    };
    reviewedValuationPrice              @title: 'Requisition valuation price'  @Measures.ISOCurrency           : reviewedCurrency;
    reviewedPriceQuantity               @title: 'Price quantity';
    reviewedCurrency                    @title: 'Currency';
    reviewedTaxCode                     @title: 'Tax code';
    reviewedPurchasingInfoRecord        @title: 'Purchasing info record';
    reviewedOutlineAgreement            @title: 'Contract';
    reviewedOutlineAgreementItem        @title: 'Contract item';
    reviewedReceiptExpected             @title: 'Goods receipt expected';
    reviewedInvoiceBasedOnReceipt       @title: 'Invoice based on receipt';
    reviewedServicePerformer            @title: 'Service performer';
    reviewedPerformancePeriodStartDate  @title: 'Performance period starts';
    reviewedPerformancePeriodEndDate    @title: 'Performance period ends';
    reviewedExpectedOverallLimitAmount  @title: 'Expected overall limit'       @Measures.ISOCurrency           : reviewedCurrency;
    reviewedOverallLimitAmount          @title: 'Overall limit'                @Measures.ISOCurrency           : reviewedCurrency;
    reviewedDeliveryAddressName         @title: 'Delivery address name';
    reviewedDeliveryAddressStreet       @title: 'Delivery street';
    reviewedDeliveryAddressCity         @title: 'Delivery city';
    reviewedDeliveryAddressPostalCode   @title: 'Delivery postal code';
    reviewedDeliveryAddressCountry      @title: 'Delivery country';
    reviewedUnloadingPoint              @title: 'Unloading point';
    readinessSummary                    @title: 'Readiness';
    lifecycleText                       @UI.Hidden;
    lifecycleCriticality                @UI.Hidden;
    sourceChanged                       @UI.Hidden;
    sourceChangeSummary                 @UI.Hidden;
    sourceChanges                       @UI.Hidden;
    findingID                           @UI.Hidden;
    actionID                            @UI.Hidden;
    enrichmentStatus                    @title: 'Suggestion Status';
    reviewStateText                     @title: 'Decision status';
    reviewStatusText                    @title: 'Review Status';
    reviewStatusCriticality             @UI.Hidden;
    nextStep                            @title: 'Next Step';
    isReadyToSubmit                     @UI.Hidden;
    requiresSourceReconciliation        @UI.Hidden;
    isOverdueForReview                  @UI.Hidden;
};

annotate service.FreetextWorkItems with {
    text                 @title: 'Original Request'  @UI.MultiLineText;
    RequisitionerName    @title: 'Requested By'      @Common.ValueList: {
        CollectionPath: 'Requisitioners',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: RequisitionerName,
            ValueListProperty: 'RequisitionerName'
        }]
    };
    requestedAt          @title: 'Requested On';
    DeliveryDate         @title: 'Needed By';
    RequestedQuantity    @title: 'Quantity'          @Measures.Unit   : BaseUnit;
    BaseUnit             @title: 'Unit';
    lifecycleStatus      @title: 'Status';
    lifecycleText        @title: 'Status';
    lifecycleCriticality @UI.Hidden;
    readinessSummary     @title: 'Readiness';
};

annotate service.PurchaseRequisitionReviews with @(
    UI.UpdateHidden                                  : reviewLocked,
    UI.HeaderInfo                                    : {
        TypeName      : 'Purchase Requisition Item',
        TypeNamePlural: 'Open Purchase Requisitions',
        Title         : {Value: 'Prepare requisition for ordering'},
        Description   : {Value: reviewedShortText}
    },
    UI.SelectionFields                               : [
        RequisitionerName,
        Plant,
        routedBuyer,
        reviewStatusText,
        DeliveryDate,
        requestedAt
    ],
    UI.SelectionPresentationVariant #ToReview        : {
        Text               : 'To review',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: lifecycleStatus,
            Ranges      : [
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'needs_review'
                },
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'source_changed'
                }
            ]
        }]},
        PresentationVariant: {
            SortOrder     : [{
                Property  : DeliveryDate,
                Descending: false
            }],
            Visualizations: ['@UI.LineItem#Queue']
        }
    },
    UI.SelectionPresentationVariant #AwaitingApproval: {
        Text               : 'Awaiting approval',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: lifecycleStatus,
            Ranges      : [
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'awaiting_approval'
                },
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'approved'
                },
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'awaiting_source_confirmation'
                }
            ]
        }]},
        PresentationVariant: {
            SortOrder     : [{
                Property  : DeliveryDate,
                Descending: false
            }],
            Visualizations: ['@UI.LineItem#Queue']
        }
    },
    UI.SelectionPresentationVariant #Completed       : {
        Text               : 'Completed',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: lifecycleStatus,
            Ranges      : [
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'completed'
                },
                {
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'cancelled'
                }
            ]
        }]},
        PresentationVariant: {
            SortOrder     : [{
                Property  : DeliveryDate,
                Descending: true
            }],
            Visualizations: ['@UI.LineItem#Queue']
        }
    },
    UI.SelectionPresentationVariant #All             : {
        Text               : 'All',
        SelectionVariant   : {SelectOptions: []},
        PresentationVariant: {
            SortOrder     : [{
                Property  : DeliveryDate,
                Descending: false
            }],
            Visualizations: ['@UI.LineItem#Queue']
        }
    },
    UI.LineItem #Queue                               : [
        {
            Value         : requestText,
            Label         : 'Request',
            @UI.Importance: #High
        },
        {
            Value         : DeliveryDate,
            Label         : 'Needed By',
            @UI.Importance: #High
        },
        {
            Value         : RequisitionerName,
            Label         : 'Requested By',
            @UI.Importance: #High
        },
        {
            Value         : Plant,
            Label         : 'Plant',
            @UI.Importance: #Medium
        },
        {
            Value         : RequestedQuantity,
            Label         : 'Quantity',
            @Measures.Unit: BaseUnit,
            @UI.Importance: #High
        },
        {
            Value                    : reviewStatusText,
            Label                    : 'Review Status',
            Criticality              : reviewStatusCriticality,
            CriticalityRepresentation: #WithoutIcon,
            @UI.Importance           : #High
        },
        {
            Value         : nextStep,
            Label         : 'Next Step',
            @UI.Importance: #High
        },
        {
            Value         : routedBuyer,
            Label         : 'Assigned To',
            @UI.Importance: #Medium
        }
    ],
    UI.FieldGroup #OriginalSubmission                : {Data: [
        {Value: RequisitionerName},
        {Value: requestedAt},
        {Value: sourceRevision},
        {Value: requestText},
        {Value: itemLongText},
        {Value: headerNote},
        {Value: DeliveryDate},
        {Value: RequestedQuantity},
        {Value: BaseUnit},
        {Value: Plant},
        {Value: StorageLocation},
        {Value: PurchasingOrganization},
        {Value: CompanyCode},
        {Value: AccountAssignmentCategory},
        {Value: MaterialGroup},
        {Value: PurchasingGroup},
        {Value: Supplier},
        {Value: PurchaseRequisitionPrice},
        {Value: PurReqnItemCurrency}
    ]},
    UI.FieldGroup #ItemAndDelivery                   : {Data: [
        {Value: reviewedShortText},
        {Value: reviewedQuantity},
        {Value: reviewedUnit},
        {Value: reviewedDeliveryDate},
        {Value: reviewedPlant},
        {Value: reviewedStorageLocation}
    ]},
    UI.FieldGroup #Texts                             : {Data: [
        {Value: reviewedLongText},
        {Value: reviewedHeaderNote},
        {Value: buyerNote}
    ]},
    UI.FieldGroup #DeliveryAddress                   : {Data: [
        {Value: reviewedDeliveryAddressName},
        {Value: reviewedDeliveryAddressStreet},
        {Value: reviewedDeliveryAddressCity},
        {Value: reviewedDeliveryAddressPostalCode},
        {Value: reviewedDeliveryAddressCountry},
        {Value: reviewedUnloadingPoint}
    ]},
    UI.FieldGroup #RequestDetails                    : {Data: [
        {Value: reviewedShortText},
        {Value: reviewedLongText},
        {Value: reviewedHeaderNote},
        {Value: reviewedPrType},
        {Value: reviewedItemCategory},
        {Value: MaterialGroup}
    ]},
    UI.FieldGroup #QuantityAndDelivery               : {Data: [
        {Value: reviewedQuantity},
        {Value: reviewedUnit},
        {Value: reviewedDeliveryDate},
        {Value: reviewedPlant},
        {Value: reviewedStorageLocation},
        {Value: reviewedDeliveryAddressName},
        {Value: reviewedDeliveryAddressStreet},
        {Value: reviewedDeliveryAddressCity},
        {Value: reviewedDeliveryAddressPostalCode},
        {Value: reviewedDeliveryAddressCountry},
        {Value: reviewedUnloadingPoint}
    ]},
    UI.FieldGroup #PurchasingAndSource               : {Data: [
        {Value: reviewedCompanyCode},
        {Value: reviewedPurchasingOrganization},
        {Value: reviewedPurchasingGroup},
        {Value: Supplier},
        {Value: reviewedPurchasingInfoRecord},
        {Value: reviewedOutlineAgreement},
        {Value: reviewedOutlineAgreementItem}
    ]},
    UI.FieldGroup #CommercialDetails                 : {Data: [
        {Value: reviewedValuationPrice},
        {Value: reviewedPriceQuantity},
        {Value: reviewedCurrency},
        {Value: reviewedTaxCode},
        {Value: reviewedReceiptExpected},
        {Value: reviewedInvoiceBasedOnReceipt}
    ]},
    UI.FieldGroup #ServicesAndLimits                 : {Data: [
        {Value: reviewedServicePerformer},
        {Value: reviewedPerformancePeriodStartDate},
        {Value: reviewedPerformancePeriodEndDate},
        {Value: reviewedExpectedOverallLimitAmount},
        {Value: reviewedOverallLimitAmount}
    ]},
    UI.FieldGroup #AdditionalDetails                 : {Data: [
        {Value: reviewedReceiptExpected},
        {Value: reviewedInvoiceBasedOnReceipt},
        {Value: buyerNote},
        {Value: reviewStateText}
    ]},
    UI.FieldGroup #SourceChanges                     : {Data: [{Value: sourceChangeSummary}]},
    UI.FieldGroup #Delivery                          : {Data: [
        {Value: RequestedQuantity},
        {Value: BaseUnit},
        {Value: DeliveryDate},
        {Value: PurchaseRequisitionPrice},
        {Value: PurReqnItemCurrency}
    ]},
    UI.FieldGroup #Account                           : {Data: [{Value: AccountAssignmentCategory}]},
    UI.Facets                                        : []
);

annotate service.FreetextProposals with @UI.LineItem: [
    {Value: fieldText},
    {Value: value},
    {Value: confidence},
    {Value: statusText},
    {Value: words},
    {Value: similarSame},
    {Value: reason}
];

annotate service.FreetextWorkItemAccountAssignments with {
    GLAccount         @Common.Label: 'G/L account';
    CostCenter        @Common.Label: 'Cost center';
    SalesOrder        @Common.Label: 'Sales order';
    SalesOrderItem    @Common.Label: 'Sales order item';
    MainAsset         @Common.Label: 'Main asset';
    AssetSubnumber    @Common.Label: 'Asset subnumber';
    InternalOrder     @Common.Label: 'Internal order';
    AssignedQuantity  @Common.Label: 'Assigned quantity'  @Measures.Unit       : BaseUnit;
    BaseUnit          @Common.Label: 'Unit';
    Amount            @Common.Label: 'Amount'             @Measures.ISOCurrency: Currency;
    Currency          @Common.Label: 'Currency';
};

annotate service.FreetextReviewAccountAssignments with {
    GLAccount           @Common.Label: 'G/L account';
    CostCenter          @Common.Label: 'Cost center';
    SalesOrder          @Common.Label: 'Sales order';
    SalesOrderItem      @Common.Label: 'Sales order item';
    MainAsset           @Common.Label: 'Main asset';
    AssetSubnumber      @Common.Label: 'Asset subnumber';
    InternalOrder       @Common.Label: 'Internal order';
    WBSElement          @Common.Label: 'WBS element';
    AssignedQuantity    @Common.Label: 'Assigned quantity'  @Measures.Unit       : BaseUnit;
    BaseUnit            @Common.Label: 'Unit';
    Amount              @Common.Label: 'Amount'             @Measures.ISOCurrency: Currency;
    Currency            @Common.Label: 'Currency';
    DistributionPercent @Common.Label: 'Distribution percentage';
};

annotate service.FreetextWorkItemAccountAssignments with @UI.LineItem: [
    {
        Value: PurchaseReqnAcctAssgmtNumber,
        Label: 'No.'
    },
    {Value: GLAccount},
    {Value: CostCenter},
    {Value: SalesOrder},
    {Value: SalesOrderItem},
    {Value: MainAsset},
    {Value: AssetSubnumber},
    {Value: InternalOrder},
    {Value: AssignedQuantity},
    {Value: BaseUnit},
    {Value: Amount},
    {Value: Currency},
    {Value: IsDeleted}
];

annotate service.FreetextReviewAccountAssignments with @UI.LineItem: [
    {
        Value: PurchaseReqnAcctAssgmtNumber,
        Label: 'No.'
    },
    {Value: GLAccount},
    {Value: CostCenter},
    {Value: SalesOrder},
    {Value: SalesOrderItem},
    {Value: MainAsset},
    {Value: AssetSubnumber},
    {Value: InternalOrder},
    {Value: WBSElement},
    {Value: AssignedQuantity},
    {Value: BaseUnit},
    {Value: Amount},
    {Value: Currency},
    {Value: DistributionPercent}
];
