using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

/*
 * Buyer cockpit UI annotations.
 * Annotations only: no columns are added to service views, so the database
 * schema of the backend stays untouched.
 *
 * Source shown to the buyer: "AI" (AI estimate) or "Rule" (own history,
 * master data, deterministic check).
 */

// ------------------------------------------------------------- approvals

annotate service.Actions with {
    kind         @title                 : 'Kind'
                 @Common.Text           : (kind = 'reminder' ? 'Reminder' : (kind = 'pdt_change' ? 'Change list' : 'Worklist'))
                 @Common.TextArrangement: #TextOnly;
    status       @title                 : 'Status'
                 @Common.Text           : (status = 'needs_decision' ? 'Needs Decision' : (status = 'waiting' ? (overdue ? 'Follow-up Overdue' : 'Waiting for Outcome') : (status = 'resolved' ? 'Completed' : 'Declined')))
                 @Common.TextArrangement: #TextOnly;
    objectKey    @title: 'Object';
    requestType  @title: 'Request Type';
    problemKey   @title: 'Business Problem';
    operationKey @title: 'Proposed Operation';
    exportFormat @title: 'Export Format';
    title        @title: 'Title';
    summary      @title                 : 'Summary'  @UI.MultiLineText;
    preparedVia  @title: 'Prepared Via';
    decidedBy    @title: 'Decided By';
    decidedAt    @title: 'Decided At';
    decisionNote @title: 'Decision Note';
    createdAt    @title: 'Prepared At';
    createdBy    @title: 'Prepared By';
};

annotate service.Actions with @(
    UI.HeaderInfo                                 : {
        TypeName      : 'Approval',
        TypeNamePlural: 'Approvals',
        Title         : {Value : (operationKey = 'delivery_intervention' ? 'Contact supplier about delivery' : operationKey = 'delivery_escalation' ? 'Escalate delivery follow-up' : operationKey = 'pdt_change' ? 'Review planned delivery time change' : title)},
        Description   : {Value: objectKey},
        TypeImageUrl  : ''
    },
    UI.SelectionFields                            : [
        status,
        requestType
    ],
    UI.LineItem                                   : [
        {
            Value         : status,
            // Loud overdue: red even though `waiting` is otherwise yellow.
            Criticality   : (status = 'needs_decision' ? 2 : (status = 'waiting' ? (overdue ? 1 : 2) : (status = 'resolved' ? 3 : 1))),
            @UI.Importance: #High
        },
        {
            Value             : title,
            @UI.Importance    : #High,
            @HTML5.CssDefaults: {width: '32%'}
        },
        {
            Value         : requestType,
            Label         : 'Request Type',
            @UI.Importance: #Medium
        },
        {
            Value: objectKey,
            Label: 'Affected Object'
        },
        {
            Value         : expectedBy,
            Label         : 'Expected By',
            @UI.Importance: #High
        },
        {
            Value         : createdAt,
            Label         : 'Prepared At',
            @UI.Importance: #Medium
        }
    ],
    UI.PresentationVariant                        : {
        SortOrder     : [{
            Property  : createdAt,
            Descending: true
        }],
        Visualizations: ['@UI.LineItem']
    },
    UI.SelectionPresentationVariant #Approvals    : {
        Text               : 'Approvals',
        SelectionVariant   : {SelectOptions: []},
        PresentationVariant: {
            SortOrder     : [{
                Property  : createdAt,
                Descending: true
            }],
            Visualizations: ['@UI.LineItem']
        }
    },
    UI.SelectionPresentationVariant #NeedsDecision: {
        Text               : 'Needs Decision',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: status,
            Ranges      : [{
                Sign  : #I,
                Option: #EQ,
                Low   : 'needs_decision'
            }]
        }]},
        PresentationVariant: {
            SortOrder     : [{
                Property  : createdAt,
                Descending: true
            }],
            Visualizations: ['@UI.LineItem']
        }
    },
    UI.SelectionPresentationVariant #Waiting      : {
        Text               : 'Waiting for Outcome',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: status,
            Ranges      : [{
                Sign  : #I,
                Option: #EQ,
                Low   : 'waiting'
            }]
        }]},
        PresentationVariant: {
            SortOrder     : [
                {Property: expectedBy},
                {
                    Property  : createdAt,
                    Descending: true
                }
            ],
            Visualizations: ['@UI.LineItem']
        }
    },
    UI.SelectionPresentationVariant #Completed    : {
        Text               : 'Completed',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: status,
            Ranges      : [{
                Sign  : #I,
                Option: #EQ,
                Low   : 'resolved'
            }]
        }]},
        PresentationVariant: {
            SortOrder     : [{
                Property  : resolvedAt,
                Descending: true
            }],
            Visualizations: ['@UI.LineItem']
        }
    },
    UI.SelectionPresentationVariant #Declined     : {
        Text               : 'Declined',
        SelectionVariant   : {SelectOptions: [{
            PropertyName: status,
            Ranges      : [{
                Sign  : #I,
                Option: #EQ,
                Low   : 'declined'
            }]
        }]},
        PresentationVariant: {
            SortOrder     : [{
                Property  : decidedAt,
                Descending: true
            }],
            Visualizations: ['@UI.LineItem']
        }
    },
    UI.Facets                                     : [{
        $Type     : 'UI.ReferenceFacet',
        ID        : 'Lines',
        Label     : 'Request Content',
        Target    : 'items/@UI.LineItem',
        @UI.Hidden: true
    }]
);

annotate service.ApprovalEvents with @(
    UI.LineItem           : [
        {
            Value: at,
            Label: 'When'
        },
        {
            Value: event,
            Label: 'Event'
        },
        {
            Value: actor,
            Label: 'By'
        },
        {
            Value: note,
            Label: 'Note'
        },
        {
            Value: source,
            Label: 'Source'
        }
    ],
    UI.PresentationVariant: {
        SortOrder     : [{
            Property  : at,
            Descending: true
        }],
        Visualizations: ['@UI.LineItem']
    }
);

annotate service.Actions actions {
    decide       @Core.OperationAvailable: ($self.status = 'needs_decision')
    (note        @title                  : 'Note' );
    decline      @Core.OperationAvailable: ($self.status = 'needs_decision')
    (note        @title                  : 'Reason' );
    logOutcome   @Core.OperationAvailable: ($self.status = 'waiting')
    (resolution  @title                  : 'Outcome',  note  @title: 'Note'  );
};

annotate service.ActionItems with {
    line         @title: 'Line'     @UI.Hidden;
    objectKey    @title: 'Object'   @UI.Hidden;
    field        @title: 'Field';
    oldValue     @title: 'Current Value';
    newValue     @title: 'New Value';
    text         @title: 'Details'  @UI.MultiLineText;
    problemKey   @title: 'Business Problem';
    operationKey @title: 'Operation';
};

annotate service.ActionItems with @(
    UI.LineItem           : [
        {
            Value         : objectKey,
            Label         : 'Affected Object',
            @UI.Importance: #High
        },
        {Value: field},
        {
            Value: oldValue,
            Label: 'Current Value'
        },
        {
            Value: newValue,
            Label: 'Proposed Value'
        },
        {
            Value: text,
            Label: 'Details'
        }
    ],
    UI.PresentationVariant: {
        SortOrder     : [{Property: line}],
        Visualizations: ['@UI.LineItem']
    }
);

annotate service.ActionEvents with @(
    UI.LineItem           : [
        {
            Value: occurredAt,
            Label: 'When'
        },
        {
            Value: event,
            Label: 'Event'
        },
        {
            Value: actor,
            Label: 'By'
        },
        {
            Value: note,
            Label: 'Note'
        }
    ],
    UI.PresentationVariant: {
        SortOrder     : [{
            Property  : occurredAt,
            Descending: true
        }],
        Visualizations: ['@UI.LineItem']
    }
);

annotate service.ActionEvents with {
    event @Common.Text           : (event = 'prepared' ? 'Prepared' : (event = 'approved' ? 'Approved' : (event = 'declined' ? 'Declined' : (event = 'resolved' ? 'Outcome Logged' : (event = 'follow_up_overdue' ? 'Follow-up Overdue' : event)))))
          @Common.TextArrangement: #TextOnly;
};

annotate service.CaseActions with @(UI.LineItem: [
    {
        Value: header_ID,
        Label: 'Affected Case'
    },
    {
        Value: operation,
        Label: 'Affected Operation'
    }
]);

annotate service.CaseActions with {
    operation @Common.Text           : (operation = 'delivery_intervention' ? 'Contact supplier about delivery' : (operation = 'delivery_escalation' ? 'Escalate delivery follow-up' : operation))
              @Common.TextArrangement: #TextOnly;
};

// ------------------------------------------------- prediction questions
// Predict on request (chat): backtest gate, then a ranking of open items.

annotate service.Questions with {
    target      @title                 : 'Question'
                @Common.Text           : (target = 'Late0' ? 'Late (after requested date)' : (target = 'Late7' ? 'Late by more than 7 days' : (target = 'Late14' ? 'Late by more than 14 days' : (target = 'Partial' ? 'Partial first receipt' : target))))
                @Common.TextArrangement: #TextOnly;
    lateDays    @title: 'Late Days';
    filters     @title: 'Scope';
    status      @title                 : 'Status'
                @Common.Text           : (status = 'passed' ? 'Answered' : (status = 'refused' ? 'Refused (backtest)' : (status = 'too_little' ? 'Too little data' : (status = 'failed' ? 'Failed' : 'Running'))))
                @Common.TextArrangement: #TextOnly;
    verdict     @title: 'Verdict';
    evaluated   @title: 'Items Backtested';
    positives   @title: 'Positives in Backtest';
    auc         @title: 'Ranking Quality';
    top10Hits   @title: 'Hits in Top 10';
    baseRate    @title: 'Base Rate';
    mae         @title: 'Average Error (days)';
    baselineMae @title: 'Average Error Without AI (days)';
    cutoff      @title: 'Backtest Cutoff';
    openItems   @title: 'Open Items Ranked';
    createdAt   @title: 'Asked At';
    createdBy   @title: 'Asked By';
};

annotate service.Questions with @(
    UI.HeaderInfo                             : {
        TypeName      : 'Prediction Question',
        TypeNamePlural: 'Prediction Questions',
        Title         : {Value: target},
        Description   : {Value: verdict},
        TypeImageUrl  : 'sap-icon://business-objects-experience'
    },
    UI.LineItem                               : [
        {
            Value         : status,
            Criticality   : (status = 'passed' ? 3 : (status = 'refused' ? 2 : (status = 'failed' ? 1 : 0))),
            @UI.Importance: #High
        },
        {
            Value         : target,
            @UI.Importance: #High
        },
        {Value: verdict},
        {Value: auc},
        {Value: evaluated},
        {Value: openItems},
        {Value: createdAt}
    ],
    UI.SelectionPresentationVariant #Questions: {
        Text               : 'Prediction Questions',
        SelectionVariant   : {SelectOptions: []},
        PresentationVariant: {
            SortOrder     : [{
                Property  : createdAt,
                Descending: true
            }],
            Visualizations: ['@UI.LineItem']
        }
    },
    UI.DataPoint #Status                      : {
        Value       : status,
        Title       : 'Status',
        Criticality : (status = 'passed' ? 3 : (status = 'refused' ? 2 : (status = 'failed' ? 1 : 0)))
    },
    UI.HeaderFacets                           : [{
        $Type : 'UI.ReferenceFacet',
        Target: '@UI.DataPoint#Status'
    }],
    UI.FieldGroup #Gate                       : {Data: [
        {Value: verdict},
        {Value: cutoff},
        {Value: evaluated},
        {Value: positives},
        {Value: baseRate},
        {Value: auc},
        {Value: top10Hits},
        {Value: filters}
    ]},
    UI.Facets                                 : [
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'Gate',
            Label : 'Backtest Gate',
            Target: '@UI.FieldGroup#Gate'
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'Rows',
            Label : 'Ranking',
            Target: 'rows/@UI.LineItem'
        }
    ]
);

annotate service.Answers with {
    rank              @title: 'Rank';
    PurchaseOrder     @title: 'Purchase Order';
    PurchaseOrderItem @title: 'Item';
    Material          @title: 'Material';
    Supplier          @title: 'Supplier';
    Plant             @title: 'Plant';
    RequestedDate     @title: 'Requested Date';
    score             @title: 'Probability';
    p10               @title: 'Fast';
    p50               @title: 'Typical';
    p90               @title: 'Slow';
};

annotate service.Answers with @(
    UI.HeaderInfo         : {
        TypeName      : 'Ranked Item',
        TypeNamePlural: 'Ranking',
        Title         : {Value: PurchaseOrder},
        Description   : {Value: Material}
    },
    UI.LineItem           : [
        {Value: rank},
        {
            $Type: 'UI.DataFieldWithUrl',
            Value: PurchaseOrder,
            Url  : ('#/OpenItems(PurchaseOrder=''' || PurchaseOrder || ''',PurchaseOrderItem=''' || PurchaseOrderItem || ''')')
        },
        {Value: PurchaseOrderItem},
        {Value: Material},
        {Value: Supplier},
        {Value: Plant},
        {Value: RequestedDate},
        {Value: score}
    ],
    UI.PresentationVariant: {
        SortOrder     : [{Property: rank}],
        Visualizations: ['@UI.LineItem']
    }
);

annotate service.Questions with {
    auc       @odata.Type: 'Edm.Decimal'  @odata.Precision: 4  @odata.Scale: 2;
    baseRate  @odata.Type: 'Edm.Decimal'  @odata.Precision: 4  @odata.Scale: 2;
};

annotate service.Answers with {
    score  @odata.Type: 'Edm.Decimal'  @odata.Precision: 4  @odata.Scale: 2;
};

// ----------------------------------------------------------------- proof

annotate service.Proof with {
    method        @title                 : 'Method'
                  @Common.Text           : label                  @Common.TextArrangement: #TextOnly;
    bucket        @title: 'Own History (deliveries)';
    label         @title: 'Method';
    n             @title: 'Deliveries Checked';
    mae           @title                 : 'Mean Absolute Error'  @Measures.Unit         : 'days';
    coverage      @title: 'Within Fast–Slow Range';
    lateCaught    @title: 'Late Deliveries Caught';
    lateTotal     @title: 'Late Deliveries';
    cutoff        @title: 'Cutoff';
    evaluatedFrom @title: 'Checked From';
    evaluatedTo   @title: 'Checked To';
    source        @title                 : 'Source'
                  @Common.Text           : (source = 'tabpfn' ? 'AI' : 'Rule')
                  @Common.TextArrangement: #TextOnly;
    snapshot      @UI.Hidden;
};

annotate service.Proof with @(
    UI.LineItem           : [
        {Value: bucket},
        {Value: method},
        {Value: n},
        {Value: mae},
        {Value: coverage},
        {Value: lateCaught},
        {Value: lateTotal},
        {Value: source}
    ],
    UI.PresentationVariant: {
        SortOrder     : [
            {Property: bucket},
            {Property: mae}
        ],
        Visualizations: ['@UI.LineItem']
    }
);

// ------------------------------------------------------------ proof chart

annotate service.Proof with @(
    Aggregation.ApplySupported       : {
        Transformations       : [
            'aggregate',
            'groupby',
            'filter',
            'orderby',
            'top',
            'skip'
        ],
        GroupableProperties   : [
            method,
            bucket,
            label
        ],
        AggregatableProperties: [
            {Property: mae},
            {Property: coverage},
            {Property: lateCaught}
        ]
    },
    Analytics.AggregatedProperty #mae: {
        Name                : 'maeTotal',
        AggregationMethod   : 'max',
        AggregatableProperty: mae,
        @Common.Label       : 'Mean Absolute Error (days)'
    },
    UI.Chart #Mae                    : {
        Title              : 'Mean absolute error by own history (lower is better)',
        ChartType          : #Column,
        DynamicMeasures    : ['@Analytics.AggregatedProperty#mae'],
        Dimensions         : [
            bucket,
            label
        ],
        MeasureAttributes  : [{
            DynamicMeasure: '@Analytics.AggregatedProperty#mae',
            Role          : #Axis1
        }],
        DimensionAttributes: [
            {
                Dimension: bucket,
                Role     : #Category
            },
            {
                Dimension: label,
                Role     : #Series
            }
        ]
    },
    UI.PresentationVariant #Mae      : {
        SortOrder     : [{Property: bucket}],
        Visualizations: ['@UI.Chart#Mae']
    }
);

// ------------------------------------------------ number display
// Doubles in the read model are whole days or EUR amounts: show them as decimals.

annotate service.OpenItems with {
    plannedDays       @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    OpenQuantity      @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 3;
    OrderQuantity     @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 3;
    NetAmount         @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 2;
    revenueAtRiskP50  @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
    revenueAtRiskP80  @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
};

annotate service.SourceRanges with {
    p10          @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 0  @Measures.Unit: 'days'  @title: 'Fast';
    p50          @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 0  @Measures.Unit: 'days'  @title: 'Typical';
    p80          @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 0  @Measures.Unit: 'days'  @title: 'Likely Latest';
    p90          @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 0  @Measures.Unit: 'days'  @title: 'Slow';
    contextLevel @title: 'Compared With';
    contextRows  @title: 'Similar deliveries used';
    nOwn         @title: 'Own Deliveries';
};

annotate service.Customers with {
    revenueAtRiskP50  @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
    revenueAtRiskP80  @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
    openAmount        @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
    directShare       @odata.Type: 'Edm.Decimal'  @odata.Precision: 5   @odata.Scale: 3;
};

annotate service.CustomerImpacts with {
    openAmount  @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 2;
};

annotate service.SourceFindings with {
    infoRecordDays        @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    masterDays            @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    currentDays           @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    p10                   @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    p50                   @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    p90                   @odata.Type: 'Edm.Decimal'  @odata.Precision: 7   @odata.Scale: 0;
    proposalQuantile      @odata.Type: 'Edm.Decimal'  @odata.Precision: 4   @odata.Scale: 2;
    poValue12m            @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
    openRevenueAtRiskP80  @odata.Type: 'Edm.Decimal'  @odata.Precision: 15  @odata.Scale: 0;
};

annotate service.SourceBacktests with {
    shareLateAbove  @odata.Type: 'Edm.Decimal'  @odata.Precision: 5  @odata.Scale: 3;
    meanBufferDays  @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 1;
    meanDaysLate    @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 1;
};

annotate service.Proof with {
    mae         @odata.Type: 'Edm.Decimal'  @odata.Precision: 7  @odata.Scale: 1;
    coverage    @odata.Type: 'Edm.Decimal'  @odata.Precision: 5  @odata.Scale: 3;
    lateCaught  @odata.Type: 'Edm.Decimal'  @odata.Precision: 5  @odata.Scale: 3;
};
