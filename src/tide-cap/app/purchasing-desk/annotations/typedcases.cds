using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

annotate service.PlannedTimes with @(
    UI.HeaderInfo: {TypeName: 'Planned Delivery Time', TypeNamePlural: 'Planned Delivery Times', Title: {Value: caseTitle}},
    UI.SelectionFields: [recordType, Plant, Material],
    UI.LineItem #PlannedTime: [
        {Value: caseTitle, Label: 'Material', @UI.Importance: #High},
        {Value: recordType, Label: 'Type', @UI.Importance: #High},
        {Value: Plant, Label: 'Plant'},
        {Value: Supplier, Label: 'Supplier'},
        {Value: currentDays, Label: 'Current SAP PDT (Days)', @UI.Importance: #High},
        {Value: proposedDays, Label: 'Proposed PDT (Days)', @UI.Importance: #High},
        {Value: caseAttention, Label: 'Attention', @UI.Importance: #High}
    ],
    UI.SelectionPresentationVariant #PlannedTime: {
        Text: 'Planned Delivery Times',
        SelectionVariant: {SelectOptions: [
            {PropertyName: caseStatus, Ranges: [{Sign: #I, Option: #EQ, Low: 'open'}]},
            {PropertyName: caseListing, Ranges: [{Sign: #I, Option: #EQ, Low: 'listed'}]}
        ]},
        PresentationVariant: {SortOrder: [{Property: casePriority}], Visualizations: ['@UI.LineItem#PlannedTime']}
    }
);

annotate service.RuleLines with @(
    UI.LineItem #DuplicateCandidates: [
        {
            Value         : label,
            Label         : 'Material',
            @UI.Importance: #High
        },
        {
            Value         : text,
            Label         : 'Recorded Description',
            @UI.Importance: #High
        },
        {
            Value         : n1,
            Label         : 'Orders (12 Months)',
            @UI.Importance: #High
        },
        {
            Value         : n2,
            Label         : 'Movements (12 Months)',
            @UI.Importance: #High
        }
    ],
    UI.LineItem #RareCombinations   : [
        {
            Value         : label,
            Label         : 'Setting Pair',
            @UI.Importance: #High
        },
        {
            Value         : text,
            Label         : 'Recorded Values',
            @UI.Importance: #High
        },
        {
            Value         : n1,
            Label         : 'Materials with First Value',
            @UI.Importance: #High
        },
        {
            Value         : n2,
            Label         : 'Materials with Second Value',
            @UI.Importance: #High
        },
        {
            Value         : n3,
            Label         : 'Materials with Both Values',
            @UI.Importance: #High
        }
    ],
    UI.LineItem                     : [
        {
            Value: label,
            Label: 'Observation'
        },
        {
            Value: text,
            Label: 'Details'
        },
        {
            Value: date,
            Label: 'Date'
        },
        {
            Value: amount,
            Label: 'Normalized Price'
        },
        {
            Value: n1,
            Label: 'Purchase-Order Activity'
        },
        {
            Value: n2,
            Label: 'Movement Activity'
        },
        {
            Value: n3,
            Label: 'Peer Count'
        },
        {
            Value: isCurrent,
            Label: 'Current Item'
        }
    ]
);

annotate service.PriceDeviations with {
    caseID               @UI.Hidden;
    detail               @UI.Hidden;
    caseTitle            @title: 'Item';
    casePriority         @UI.Hidden;
    caseStatus           @title: 'Case Status';
    caseListing          @UI.Hidden;
    caseAttention        @title: 'Status';
    caseAttentionText    @UI.Hidden;
    caseSourceRevision   @UI.Hidden;
    caseSourceChanged    @UI.Hidden;
    caseClosure          @UI.Hidden;
    caseUpdatedAt        @UI.Hidden;
    PurchaseOrder        @title: 'Purchase Order';
    PurchaseOrderItem    @title: 'Item';
    Material             @title: 'Material'                       @Common.ValueList    : {
        Label         : 'Material',
        CollectionPath: 'Materials',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: Material,
                ValueListProperty: 'Material'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'MaterialDescription'
            }
        ]
    };
    Supplier             @title: 'Supplier'                       @Common.ValueList    : {
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
    Plant                @title: 'Plant'                          @Common.ValueList    : {
        Label         : 'Plant',
        CollectionPath: 'Plants',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: Plant,
                ValueListProperty: 'Plant'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'PlantName'
            }
        ]
    };
    PurchasingGroup      @title: 'Purchasing Group'               @Common.ValueList    : {
        Label         : 'Purchasing Group',
        CollectionPath: 'PurchasingGroups',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: PurchasingGroup,
                ValueListProperty: 'PurchasingGroup'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'PurchasingGroupName'
            }
        ]
    };
    unitPrice            @title: 'Normalized Current Unit Price'  @Measures.ISOCurrency: currency;
    currentPrice         @title: 'Raw Entered Amount'             @Measures.ISOCurrency: currency;
    priorMedian          @title: 'Typical Prior Price'            @Measures.ISOCurrency: currency;
    priorCount           @title: 'Prior Prices Used';
    factor               @title: 'Difference Factor';
    potentialDifference  @title: 'Potential Difference'           @Measures.ISOCurrency: currency;
};

annotate service.DuplicateMaterials with {
    caseID             @UI.Hidden;
    detail             @UI.Hidden;
    caseTitle          @title: 'Description';
    casePriority       @UI.Hidden;
    caseStatus         @title: 'Case Status';
    caseListing        @UI.Hidden;
    caseAttention      @title: 'Status';
    caseAttentionText  @UI.Hidden;
    caseSourceRevision @UI.Hidden;
    caseSourceChanged  @UI.Hidden;
    caseClosure        @UI.Hidden;
    caseUpdatedAt      @UI.Hidden;
    Material           @title: 'Material'  @Common.ValueList: {
        Label         : 'Material',
        CollectionPath: 'Materials',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Material,
            ValueListProperty: 'Material'
        }]
    };
    Plant              @title: 'Plant'     @Common.ValueList: {
        Label         : 'Plant',
        CollectionPath: 'Plants',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Plant,
            ValueListProperty: 'Plant'
        }]
    };
    PurchasingGroup    @title: 'Purchasing Group';
    groupKey           @UI.Hidden;
    materialType       @title: 'Material Type';
    materialNumbers    @title: 'Material Numbers';
    candidateCount     @title: 'Candidates';
    activity           @title: 'Orders and Movements (12 Months)';
    mainPlant          @title: 'Main Plant';
};

annotate service.UnusualSettings with {
    caseID             @UI.Hidden;
    detail             @UI.Hidden;
    caseTitle          @title: 'Item';
    casePriority       @UI.Hidden;
    caseStatus         @title: 'Case Status';
    caseListing        @UI.Hidden;
    caseAttention      @title: 'Status';
    caseAttentionText  @UI.Hidden;
    caseSourceRevision @UI.Hidden;
    caseSourceChanged  @UI.Hidden;
    caseClosure        @UI.Hidden;
    caseUpdatedAt      @UI.Hidden;
    Material           @title: 'Material'  @Common.ValueList: {
        Label         : 'Material',
        CollectionPath: 'Materials',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Material,
            ValueListProperty: 'Material'
        }]
    };
    Plant              @title: 'Plant'     @Common.ValueList: {
        Label         : 'Plant',
        CollectionPath: 'Plants',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Plant,
            ValueListProperty: 'Plant'
        }]
    };
    MRPController      @title: 'MRP Controller';
    materialType       @title: 'Material Type';
    summary            @title: 'Rare Combination';
    groupSize          @title: 'Peer Group Size';
    unusualPairCount   @title: 'Rare Combinations';
};

annotate service.SupplierPlannedTimes with {
    caseID               @UI.Hidden;
    detail               @UI.Hidden;
    caseTitle            @title: 'Item';
    casePriority         @UI.Hidden;
    caseStatus           @title: 'Case Status';
    caseListing          @UI.Hidden;
    caseAttention        @title: 'Status';
    caseAttentionText    @UI.Hidden;
    caseSourceRevision   @UI.Hidden;
    caseSourceChanged    @UI.Hidden;
    caseClosure          @UI.Hidden;
    caseUpdatedAt        @UI.Hidden;
    Material             @title: 'Material'              @Common.ValueList    : {
        Label         : 'Material',
        CollectionPath: 'Materials',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Material,
            ValueListProperty: 'Material'
        }]
    };
    Supplier             @title: 'Supplier'              @Common.ValueList    : {
        Label         : 'Supplier',
        CollectionPath: 'Suppliers',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Supplier,
            ValueListProperty: 'Supplier'
        }]
    };
    Plant                @title: 'Plant'                 @Common.ValueList    : {
        Label         : 'Plant',
        CollectionPath: 'Plants',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Plant,
            ValueListProperty: 'Plant'
        }]
    };
    purchasingInfoRecord @title: 'Purchasing Info Record';
    currentDays          @title: 'Current Planned Days';
    proposedDays         @title: 'Proposed Days';
    p50                  @title: 'Typical Actual Days';
    ownDeliveries        @title: 'Deliveries Used';
    value12mEUR          @title: '12-Month Order Value'  @Measures.ISOCurrency: 'EUR';
    proposalRule         @title: 'Recommendation Basis';
};

annotate service.MaterialPlannedTimes with {
    caseID             @UI.Hidden;
    detail             @UI.Hidden;
    caseTitle          @title: 'Item';
    casePriority       @UI.Hidden;
    caseStatus         @title: 'Case Status';
    caseListing        @UI.Hidden;
    caseAttention      @title: 'Status';
    caseAttentionText  @UI.Hidden;
    caseSourceRevision @UI.Hidden;
    caseSourceChanged  @UI.Hidden;
    caseClosure        @UI.Hidden;
    caseUpdatedAt      @UI.Hidden;
    Material           @title: 'Material'  @Common.ValueList: {
        Label         : 'Material',
        CollectionPath: 'Materials',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Material,
            ValueListProperty: 'Material'
        }]
    };
    Plant              @title: 'Plant'     @Common.ValueList: {
        Label         : 'Plant',
        CollectionPath: 'Plants',
        Parameters    : [{
            $Type            : 'Common.ValueListParameterInOut',
            LocalDataProperty: Plant,
            ValueListProperty: 'Plant'
        }]
    };
    MRPController      @title: 'MRP Controller';
    currentDays        @title: 'Current Master Days';
    proposedDays       @title: 'Proposed Days';
    difference         @title: 'Difference';
    tolerance          @title: 'Allowed Tolerance';
    masterFlag         @title: 'Master-Data Flag';
    orders12m          @title: 'Orders (12 Months)';
};

annotate service.PriceDeviations with @(
    UI.HeaderInfo                         : {
        TypeName      : 'Price Deviation',
        TypeNamePlural: 'Price Deviations',
        Title         : {Value: caseTitle},
        Description   : {Value: PurchaseOrder}
    },
    UI.SelectionFields                    : [
        Plant,
        Material,
        Supplier,
    ],
    UI.LineItem #Price                    : [
        {
            Value         : caseAttention,
            Label         : 'Status',
            @UI.Importance: #High
        },
        {
            Value         : caseTitle,
            Label         : 'PO / Item',
            @UI.Importance: #High
        },
        {
            Value         : Material,
            @UI.Importance: #High
        },
        {
            Value         : Plant,
            @UI.Importance: #High
        },
        {
            Value         : Supplier,
            @UI.Importance: #High
        },
        {
            Value         : unitPrice,
            Label         : 'Current Unit Price',
            @UI.Importance: #High
        },
        {
            Value         : priorMedian,
            @UI.Importance: #High
        },
        {
            Value         : factor,
            Label         : 'Difference Factor',
            @UI.Importance: #High
        },
        {
            Value         : priorCount,
            Label         : 'Prior Observations',
            @UI.Importance: #Medium
        }
    ],
    UI.SelectionPresentationVariant #Price: {
        Text               : 'Price deviations',
        SelectionVariant   : {SelectOptions: [
            {
                PropertyName: caseStatus,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'open'
                }]
            },
            {
                PropertyName: caseListing,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'listed'
                }]
            }
        ]},
        PresentationVariant: {
            SortOrder     : [{Property: casePriority}],
            Visualizations: ['@UI.LineItem#Price']
        }
    },
    UI.HeaderFacets                       : [],
    UI.FieldGroup #Main                   : {Data: [
        {Value: PurchaseOrder},
        {Value: PurchaseOrderItem},
        {Value: Material},
        {Value: Plant},
        {Value: Supplier},
        {Value: PurchasingGroup}
    ]},
    UI.FieldGroup #Evidence               : {Data: [
        {Value: unitPrice},
        {Value: priorMedian},
        {Value: factor},
        {Value: priorCount},
        {Value: currentPrice},
        {Value: potentialDifference},
        {Value: assessment.expectedP10},
        {Value: assessment.expectedP50},
        {Value: assessment.expectedP90},
        {Value: assessment.deviationPercent},
        {Value: assessment.calibrationStatus},
        {Value: assessment.backend},
        {Value: assessment.predictionContractVersion},
        {Value: assessment.computedAt},
        {Value: assessment.trainingRows},
        {Value: assessment.contextScope},
        {Value: assessment.validationPeriod}
    ]},
    UI.Facets                             : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'Main',
        Label : 'Affected Item',
        Target: '@UI.FieldGroup#Main'
    }]
);

annotate service.DuplicateMaterials with @(
    UI.HeaderInfo                             : {
        TypeName      : 'Duplicate Material',
        TypeNamePlural: 'Duplicate Materials',
        Title         : {Value: caseTitle},
        Description   : {Value: Material}
    },
    UI.SelectionFields                        : [
        Plant,
        Material
    ],
    UI.LineItem #Duplicate                    : [
        {
            Value         : caseAttention,
            Label         : 'Status',
            @UI.Importance: #High
        },
        {
            Value         : caseTitle,
            Label         : 'Reference',
            @UI.Importance: #High
        },
        {
            Value         : Material,
            @UI.Importance: #High
        },
        {
            Value         : Plant,
            @UI.Importance: #High
        },
        {
            Value         : candidateCount,
            @UI.Importance: #High
        },
        {
            Value         : materialNumbers,
            @UI.Importance: #High
        },
        {
            Value         : activity,
            @UI.Importance: #Medium
        }
    ],
    UI.SelectionPresentationVariant #Duplicate: {
        Text               : 'Duplicates',
        SelectionVariant   : {SelectOptions: [
            {
                PropertyName: caseStatus,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'open'
                }]
            },
            {
                PropertyName: caseListing,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'listed'
                }]
            }
        ]},
        PresentationVariant: {
            SortOrder     : [{Property: casePriority}],
            Visualizations: ['@UI.LineItem#Duplicate']
        }
    },
    UI.FieldGroup #Main                       : {Data: [
        {Value: Material},
        {Value: Plant},
        {Value: materialType},
        {Value: PurchasingGroup}
    ]},
    UI.FieldGroup #Evidence                   : {Data: [
        {Value: candidateCount},
        {Value: materialNumbers},
        {Value: activity},
        {Value: mainPlant}
    ]},
    UI.Facets                                 : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'Main',
        Label : 'Material Context',
        Target: '@UI.FieldGroup#Main'
    }],
    UI.Identification                         : [
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.prepareAction',
            Label     : 'Prepare Master-Data Review',
            @UI.Hidden: true
        },
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.acceptException',
            Label     : 'Keep Separate - Accept Exception',
            @UI.Hidden: true
        }
    ]
);

annotate service.UnusualSettings with @(
    UI.HeaderInfo                        : {
        TypeName      : 'Rare Combination',
        TypeNamePlural: 'Rare Combinations',
        Title         : {Value: caseTitle},
        Description   : {Value: Material}
    },
    UI.SelectionFields                   : [
        Plant,
        Material
    ],
    UI.LineItem #Rare                    : [
        {
            Value         : caseAttention,
            Label         : 'Status',
            @UI.Importance: #High
        },
        {
            Value         : caseTitle,
            Label         : 'Reference',
            @UI.Importance: #High
        },
        {
            Value         : Material,
            @UI.Importance: #High
        },
        {
            Value         : Plant,
            @UI.Importance: #High
        },
        {
            Value         : summary,
            @UI.Importance: #High
        },
        {
            Value         : unusualPairCount,
            @UI.Importance: #High
        }
    ],
    UI.SelectionPresentationVariant #Rare: {
        Text               : 'Unusual settings',
        SelectionVariant   : {SelectOptions: [
            {
                PropertyName: caseStatus,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'open'
                }]
            },
            {
                PropertyName: caseListing,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'listed'
                }]
            }
        ]},
        PresentationVariant: {
            SortOrder     : [{Property: casePriority}],
            Visualizations: ['@UI.LineItem#Rare']
        }
    },
    UI.FieldGroup #Main                  : {Data: [
        {Value: Material},
        {Value: Plant},
        {Value: MRPController},
        {Value: materialType}
    ]},
    UI.FieldGroup #Evidence              : {Data: [
        {Value: summary},
        {Value: groupSize},
        {Value: unusualPairCount}
    ]},
    UI.Facets                            : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'Main',
        Label : 'Material Context',
        Target: '@UI.FieldGroup#Main'
    }],
    UI.Identification                    : [
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.prepareAction',
            Label     : 'Prepare Planner Review',
            @UI.Hidden: true
        },
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.acceptException',
            Label     : 'Accept as Intentional',
            @UI.Hidden: true
        }
    ]
);

annotate service.SupplierPlannedTimes with @(
    UI.HeaderInfo                                       : {
        TypeName      : 'Supplier Planned Time',
        TypeNamePlural: 'Supplier Planned Times',
        Title         : {Value: caseTitle},
        Description   : {Value: Supplier}
    },
    UI.SelectionFields                                  : [
        Plant,
        Material,
        Supplier
    ],
    UI.LineItem #SupplierPlannedTime                    : [
        {
            Value         : caseAttention,
            Label         : 'Status',
            @UI.Importance: #High
        },
        {
            Value         : caseTitle,
            Label         : 'Reference',
            @UI.Importance: #High
        },
        {
            Value         : Material,
            @UI.Importance: #High
        },
        {
            Value         : Plant,
            @UI.Importance: #High
        },
        {
            Value         : Supplier,
            @UI.Importance: #High
        },
        {
            Value         : currentDays,
            @UI.Importance: #High
        },
        {
            Value         : proposedDays,
            @UI.Importance: #High
        },
        {
            Value         : p50,
            @UI.Importance: #High
        }
    ],
    UI.SelectionPresentationVariant #SupplierPlannedTime: {
        Text               : 'Supplier lead times',
        SelectionVariant   : {SelectOptions: [
            {
                PropertyName: caseStatus,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'open'
                }]
            },
            {
                PropertyName: caseListing,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'listed'
                }]
            }
        ]},
        PresentationVariant: {
            SortOrder     : [{Property: casePriority}],
            Visualizations: ['@UI.LineItem#SupplierPlannedTime']
        }
    },
    UI.FieldGroup #Main                                 : {Data: [
        {Value: Material},
        {Value: Supplier},
        {Value: Plant},
        {Value: purchasingInfoRecord}
    ]},
    UI.FieldGroup #Recommendation                       : {Data: [
        {Value: currentDays},
        {Value: proposedDays},
        {Value: p50},
        {Value: ownDeliveries},
        {Value: value12mEUR},
        {Value: proposalRule}
    ]},
    UI.Facets                                           : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'Main',
        Label : 'Purchasing Info Record',
        Target: '@UI.FieldGroup#Main'
    }],
    UI.Identification                                   : [
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.prepareAction',
            Label     : 'Prepare Supplier Lead-Time Change',
            @UI.Hidden: true
        },
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.acceptException',
            Label     : 'Keep Current Value',
            @UI.Hidden: true
        }
    ]
);

annotate service.MaterialPlannedTimes with @(
    UI.HeaderInfo                                             : {
        TypeName      : 'Material Planned Time',
        TypeNamePlural: 'Material Planned Times',
        Title         : {Value: caseTitle},
        Description   : {Value: Material}
    },
    UI.SelectionFields                                        : [
        Plant,
        Material
    ],
    UI.LineItem #MaterialMasterPlannedTime                    : [
        {
            Value         : caseAttention,
            Label         : 'Status',
            @UI.Importance: #High
        },
        {
            Value         : caseTitle,
            Label         : 'Reference',
            @UI.Importance: #High
        },
        {
            Value         : Material,
            @UI.Importance: #High
        },
        {
            Value         : Plant,
            @UI.Importance: #High
        },
        {
            Value         : currentDays,
            @UI.Importance: #High
        },
        {
            Value         : proposedDays,
            @UI.Importance: #High
        },
        {
            Value         : difference,
            @UI.Importance: #High
        }
    ],
    UI.SelectionPresentationVariant #MaterialMasterPlannedTime: {
        Text               : 'Material lead times',
        SelectionVariant   : {SelectOptions: [
            {
                PropertyName: caseStatus,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'open'
                }]
            },
            {
                PropertyName: caseListing,
                Ranges      : [{
                    Sign  : #I,
                    Option: #EQ,
                    Low   : 'listed'
                }]
            }
        ]},
        PresentationVariant: {
            SortOrder     : [{Property: casePriority}],
            Visualizations: ['@UI.LineItem#MaterialMasterPlannedTime']
        }
    },
    UI.FieldGroup #Main                                       : {Data: [
        {Value: Material},
        {Value: Plant},
        {Value: MRPController}
    ]},
    UI.FieldGroup #Recommendation                             : {Data: [
        {Value: currentDays},
        {Value: proposedDays},
        {Value: difference},
        {Value: tolerance},
        {Value: masterFlag},
        {Value: orders12m}
    ]},
    UI.Facets                                                 : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'Main',
        Label : 'Material Context',
        Target: '@UI.FieldGroup#Main'
    }],
    UI.Identification                                         : [
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.prepareAction',
            Label     : 'Prepare Material Lead-Time Change',
            @UI.Hidden: true
        },
        {
            $Type     : 'UI.DataFieldForAction',
            Action    : 'PurchasingDeskService.acceptException',
            Label     : 'Keep Current Value',
            @UI.Hidden: true
        }
    ]
);

annotate service.PriceDeviations actions {
    prepareAction   @Core.OperationAvailable: ($self.caseStatus = 'open');
    acceptException @Core.OperationAvailable: ($self.caseStatus = 'open');
};

annotate service.DuplicateMaterials actions {
    prepareAction   @Core.OperationAvailable: ($self.caseStatus = 'open');
    acceptException @Core.OperationAvailable: ($self.caseStatus = 'open');
};

annotate service.UnusualSettings actions {
    prepareAction   @Core.OperationAvailable: ($self.caseStatus = 'open');
    acceptException @Core.OperationAvailable: ($self.caseStatus = 'open');
};

annotate service.SupplierPlannedTimes actions {
    prepareAction   @Core.OperationAvailable: ($self.caseStatus = 'open');
    acceptException @Core.OperationAvailable: ($self.caseStatus = 'open');
};

annotate service.MaterialPlannedTimes actions {
    prepareAction   @Core.OperationAvailable: ($self.caseStatus = 'open');
    acceptException @Core.OperationAvailable: ($self.caseStatus = 'open');
};
