namespace tide.workflow;

using {cuid} from '@sap/cds/common';

@assert.unique.commandIdentity: [
    tenant,
    principal,
    app,
    commandID
]
entity WorkflowCommands : cuid {
    tenant      : String(255) not null;
    principal   : String(255) not null;
    app         : String(80) not null;
    commandID   : String(128) not null;
    commandType : String(80) not null;
    argsHash    : String(64) not null;
    subjects    : LargeString not null;
    result      : LargeString;
    committedAt : Timestamp;
}

entity SubjectClaims {
    key tenant       : String(255);
    key sourceSystem : String(80);
    key kind         : String(80);
    key subjectKey   : String(300);
    key claimType    : String(20);
    key slot         : String(80);
        actionID     : UUID;
        caseID       : String(160);
        commandID    : UUID not null;
}

entity ScopeGrants : cuid {
    principal        : String(255) not null;
    app              : String(80) not null;
    role             : String(80) not null;
    plant            : String(4);
    purchasingGroup  : String(3);
    buyerRoutingKey  : String(255);
    validFrom        : Timestamp not null;
    validUntil       : Timestamp;
    version          : Integer not null;
    provenance       : LargeString not null;
}

entity OutcomeObservations : cuid {
    actionID     : UUID not null;
    command      : Association to WorkflowCommands not null;
    kind         : String(30) not null;
    completeness : String(10) not null;
    origin       : String(20) not null;
    observedAt   : Timestamp not null;
    actor        : String(255) not null;
    target       : String(300) not null;
    field        : String(80) not null;
    value        : String(255) not null;
    note         : String(500);
}

entity ReviewEvents : cuid {
    PurchaseRequisition     : String(10) not null;
    PurchaseRequisitionItem : String(5) not null;
    command                 : Association to WorkflowCommands;
    submissionID            : UUID;
    occurredAt              : Timestamp not null;
    event                   : String(40) not null;
    fromStage               : String(40);
    toStage                 : String(40);
    actor                   : String(255) not null;
    sourceRevision          : Integer;
    reason                  : String(500);
}
