namespace tide.review;

using {tide.core.PredictionRun} from './core';
using {tide.workflow.WorkflowCommands} from './workflow';
using {tide.workflowTarget.Cases} from './workflow-target';

entity RequisitionReviews {
    key ID             : UUID;
        header         : Association to Cases not null;
        sourceSystem   : String(80) not null;
        purchaseRequisition : String(10) not null;
        purchaseRequisitionItem : String(5) not null;
        routedBuyer    : String(255);
        sourceRevision : String(128) not null;
        reviewStatus   : String(30) not null;
        currentSubmission : Association to ReviewSubmissions;
        workingVersion : Integer not null default 0;
        draftOwner     : String(255);
        savedAt        : Timestamp;
        completionEvidence : LargeString;
        cancellationEvidence : LargeString;
        items          : Composition of many WorkingItems on items.review = $self;
}

entity WorkingItems {
    key review       : Association to RequisitionReviews;
    key itemKey      : String(80);
        values       : LargeString not null;
        explicitClears : LargeString;
        validationStatus : String(20) not null;
        quantity     : Decimal(19, 6);
        unit         : String(20);
        allocations  : Composition of many WorkingAllocations on allocations.item = $self;
}

entity WorkingAllocations {
    key item         : Association to WorkingItems;
    key allocationKey : String(80);
        values       : LargeString not null;
        explicitClears : LargeString;
        quantity     : Decimal(19, 6);
        unit         : String(20);
        validationStatus : String(20) not null;
}

entity FieldEvidence {
    key ID           : UUID;
        review       : Association to RequisitionReviews not null;
        draftID      : UUID;
        field        : String(80) not null;
        generation   : Integer not null;
        inputHash    : String(64) not null;
        sourceHash   : String(64) not null;
        candidate    : String(255);
        applicability : String(20) not null;
        rawScores    : LargeString;
        support      : Integer;
        run          : Association to PredictionRun;
        provenance   : LargeString;
        quality      : LargeString;
}

entity FieldDecisions {
    key ID           : UUID;
        review       : Association to RequisitionReviews not null;
        draftID      : UUID;
        field        : String(80) not null;
        chosenValue  : String(255);
        origin       : String(20) not null;
        appliedBy    : String(255);
        appliedAt    : Timestamp;
        confirmedBy  : String(255);
        confirmedAt  : Timestamp;
        candidate    : Association to FieldEvidence;
}

entity ReviewEvidence {
    key ID           : UUID;
        review       : Association to RequisitionReviews not null;
        sourceIdentity : String(300) not null;
        contentHash  : String(64) not null;
        facts        : LargeString not null;
        retainedAt   : Timestamp not null;
}

entity ReviewSubmissions {
    key ID           : UUID;
        review       : Association to RequisitionReviews not null;
        sourceRevision : String(128) not null;
        workingVersion : Integer not null;
        submittedAt  : Timestamp not null;
        submittedBy  : String(255) not null;
        payload      : LargeString not null;
        payloadHash  : String(64) not null;
        readinessToken : String(128) not null;
        evidence     : Association to ReviewEvidence;
        items        : Composition of many SubmittedItems on items.submission = $self;
}

entity SubmittedItems {
    key submission   : Association to ReviewSubmissions;
    key itemKey      : String(80);
        values       : LargeString not null;
        decisionLineage : LargeString;
        allocations  : Composition of many SubmittedAllocations on allocations.item = $self;
}

entity SubmittedAllocations {
    key item         : Association to SubmittedItems;
    key allocationKey : String(80);
        values       : LargeString not null;
        decisionLineage : LargeString;
}

entity ReviewEvents {
    key ID           : UUID;
        review       : Association to RequisitionReviews not null;
        command      : Association to WorkflowCommands not null;
        transition   : String(40) not null;
        actor        : String(255) not null;
        occurredAt   : Timestamp not null;
        reason       : String(500);
        submission   : Association to ReviewSubmissions;
        evidence     : Association to ReviewEvidence;
        beforeVersion : Integer not null;
        afterVersion  : Integer not null;
}