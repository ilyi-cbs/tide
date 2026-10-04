namespace tide.workflowTarget;

using {tide.workflow.WorkflowCommands} from './workflow';

@assert.unique.episode: [sourceSystem, kind, subjectKey, episode]
entity Cases {
    key ID                 : UUID;
        kind               : String(40) not null;
        purpose            : String(80) not null;
        sourceSystem       : String(80) not null;
        subjectKey         : String(300) not null;
        episode            : Integer not null;
        predecessor        : Association to Cases;
        owner              : String(255);
        scope              : LargeString not null;
        status             : String(20) not null;
        closure            : String(40);
        listing            : String(20) not null;
        sourceRevision     : String(128) not null;
        acknowledgedRevision : String(128);
        version            : Integer not null;
        createdAt          : Timestamp not null;
        updatedAt          : Timestamp not null;
        closedAt           : Timestamp;
        subjects           : Composition of many CaseSubjects on subjects.header = $self;
}

entity CaseSubjects {
    key header       : Association to Cases;
    key sourceSystem : String(80);
    key objectType   : String(80);
    key subjectKey   : String(300);
    key role         : String(40);
}

entity CaseEvents {
    key ID            : UUID;
        header        : Association to Cases not null;
        command       : Association to WorkflowCommands not null;
        event         : String(40) not null;
        occurredAt    : Timestamp not null;
        evidence      : LargeString;
        reason        : String(500);
        beforeVersion : Integer not null;
        afterVersion  : Integer not null;
}

entity Actions {
    key ID                  : UUID;
        kind                : String(40) not null;
        operation           : String(160) not null;
        status              : String(20) not null;
        version             : Integer not null;
        completionPolicyVersion : String(80) not null;
        preparedPayload     : LargeString not null;
        preparedHash        : String(64) not null;
        approvedAt          : Timestamp;
        approvedBy          : String(255);
        approvalContext     : LargeString;
        dueDate             : Date;
        items               : Composition of many ActionItems on items.action = $self;
}

entity ActionItems {
    key action       : Association to Actions;
    key itemKey      : String(80);
        header       : Association to Cases;
        subjectKey   : String(300) not null;
        instructions : LargeString not null;
        evidence     : LargeString;
}

entity CaseActions {
    key header    : Association to Cases;
    key action    : Association to Actions;
    key role      : String(20);
        outcome   : String(40);
}

entity ActionEvents {
    key ID            : UUID;
        action        : Association to Actions not null;
        command       : Association to WorkflowCommands not null;
        event         : String(40) not null;
        occurredAt    : Timestamp not null;
        evidence      : LargeString;
        payloadVersion : Integer not null;
        reason        : String(500);
}