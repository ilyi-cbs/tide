namespace tide.assessment;

using {tide.cockpit.Snapshot} from './publication';
using {tide.core.PredictionRun} from './core';
using {tide.workflowTarget.Cases} from './workflow-target';
using {tide.publication.Scenarios} from './publication-target';

@assert.unique.generation: [snapshot, kind, subjectKey]
entity Assessments {
    key ID             : UUID;
        kind           : String(40) not null;
        subjectKey     : String(300) not null;
        snapshot       : Association to Snapshot;
        header         : Association to Cases;
        scenario       : Association to Scenarios;
        scenarioVersion : Integer;
        inputRevision  : String(128) not null;
        policyVersion  : String(80) not null;
        processingVersion : String(80) not null;
        effectiveDate  : Date not null;
        assessedAt     : Timestamp not null;
        conclusion     : String(40) not null;
        completeness   : String(20) not null;
        sealedAt       : Timestamp;
        subjects       : Composition of many AssessmentSubjects on subjects.assessment = $self;
        delivery       : Composition of one DeliveryFacts on delivery.assessment = $self;
        deliveryImpacts : Composition of many DeliveryImpacts on deliveryImpacts.assessment = $self;
        planning       : Composition of one PlanningFacts on planning.assessment = $self;
        price          : Composition of one PriceFacts on price.assessment = $self;
        duplicate      : Composition of one DuplicateFacts on duplicate.assessment = $self;
        settings       : Composition of one SettingFacts on settings.assessment = $self;
        supplierTime   : Composition of one SupplierTimeFacts on supplierTime.assessment = $self;
        materialTime   : Composition of one MaterialTimeFacts on materialTime.assessment = $self;
        changes        : Composition of many ProposedChanges on changes.assessment = $self;
}

entity AssessmentSubjects {
    key assessment   : Association to Assessments;
    key sourceSystem : String(80);
    key objectType   : String(80);
    key subjectKey   : String(300);
    key role         : String(40);
        scope        : LargeString not null;
}

entity AssessmentEvidence {
    key ID            : UUID;
        assessment    : Association to Assessments not null;
        sourceSystem  : String(80) not null;
        sourceIdentity : String(300) not null;
        schemaVersion : String(80) not null;
        contentHash   : String(64) not null;
        origin        : String(20) not null;
        inspectedInputs : LargeString not null;
        comparisons   : LargeString;
        run           : Association to PredictionRun;
        calculationVersion : String(80) not null;
        quality       : LargeString;
}

entity DeliveryFacts {
    key assessment    : Association to Assessments;
        phase         : String(40) not null;
        purchaseOrder : String(10) not null;
        purchaseOrderItem : String(5) not null;
        requestedDate : Date;
        expectedFrom  : Date;
        expectedTo    : Date;
        quantity      : Decimal(19, 6);
        unit          : String(20);
        evidence      : Association to AssessmentEvidence;
}

entity DeliveryImpacts {
    key ID            : UUID;
        assessment    : Association to Assessments not null;
        fact          : Association to DeliveryFacts not null;
        salesOrder    : String(10);
        salesOrderItem : String(6);
        productionOrder : String(12);
        quantity      : Decimal(19, 6);
        unit          : String(20);
        amount        : Decimal(19, 4);
        currency      : String(5);
        valuationBasis : String(40);
        unavailableReason : String(120);
}

entity PlanningFacts {
    key assessment     : Association to Assessments;
        material       : String(40) not null;
        plant          : String(4) not null;
        supplier       : String(10);
        orderDate      : Date;
        needDate       : Date;
        orderByDate    : Date;
        feasible      : Boolean;
        maintainedDays : Integer;
        bufferDays     : Integer;
        price          : Decimal(19, 4);
        priceUnit      : Decimal(19, 6);
        currency       : String(5);
        unavailableReason : String(120);
        evidence       : Association to AssessmentEvidence;
}

entity PriceFacts {
    key assessment     : Association to Assessments;
        metricCode     : String(80) not null;
        purchaseOrder  : String(10) not null;
        purchaseOrderItem : String(5) not null;
        currentPrice   : Decimal(19, 4);
        comparisonPrice : Decimal(19, 4);
        priceUnit      : Decimal(19, 6);
        currency       : String(5);
        evidence       : Association to AssessmentEvidence;
}

entity DuplicateFacts {
    key assessment  : Association to Assessments;
        groupAnchor : String(160) not null;
        material    : String(40) not null;
        plant       : String(4);
        evidence    : Association to AssessmentEvidence;
        candidates  : Composition of many DuplicateCandidates on candidates.fact = $self;
}

entity DuplicateCandidates {
    key fact          : Association to DuplicateFacts;
    key material      : String(40);
    key plant         : String(4);
        similarity    : Decimal(6, 5);
        support       : Integer;
        evidence      : Association to AssessmentEvidence;
}

entity SettingFacts {
    key assessment  : Association to Assessments;
        material    : String(40) not null;
        plant       : String(4) not null;
        support     : Integer;
        evidence    : Association to AssessmentEvidence;
        pairs       : Composition of many UnusualSettingPairs on pairs.fact = $self;
}

entity UnusualSettingPairs {
    key fact        : Association to SettingFacts;
    key firstField  : String(80);
    key secondField : String(80);
        firstValue  : String(255);
        secondValue : String(255);
        rarity      : Decimal(6, 5);
        support     : Integer;
}

entity SupplierTimeFacts {
    key assessment    : Association to Assessments;
        supplier      : String(10) not null;
        infoRecord    : String(20);
        material      : String(40) not null;
        plant         : String(4) not null;
        maintainedDays : Integer;
        empiricalDays : Decimal(10, 2);
        modelDays     : Decimal(10, 2);
        support       : Integer;
        evidence      : Association to AssessmentEvidence;
}

entity MaterialTimeFacts {
    key assessment    : Association to Assessments;
        material      : String(40) not null;
        plant         : String(4) not null;
        maintainedDays : Integer;
        weightedDays  : Decimal(10, 2);
        support       : Integer;
        evidence      : Association to AssessmentEvidence;
        sources       : Composition of many MaterialPlannedTimeSources on sources.fact = $self;
}

entity MaterialPlannedTimeSources {
    key fact          : Association to MaterialTimeFacts;
    key supplier      : String(10);
    key infoRecord    : String(20);
        weight        : Decimal(10, 5);
        plannedDays   : Integer;
        support       : Integer;
        evidence      : Association to AssessmentEvidence;
}

entity ProposedChanges {
    key assessment  : Association to Assessments;
    key changeKey   : String(160);
        subjectKey  : String(300) not null;
        field       : String(80) not null;
        beforeValue : String(255);
        proposedValue : String(255);
        expectedEffect : LargeString;
        limitations : LargeString;
        evidence    : Association to AssessmentEvidence;
}

entity LocalConfirmations {
    key ID            : UUID;
        purchaseOrder : String(10) not null;
        purchaseOrderItem : String(5) not null;
        confirmedDate : Date not null;
        quantity      : Decimal(19, 6) not null;
        unit          : String(20) not null;
        actor         : String(255) not null;
        recordedAt    : Timestamp not null;
        origin        : String(20) not null;
        evidence      : LargeString;
}

entity Questions {
    key ID            : UUID;
        requester     : String(255) not null;
        app           : String(80) not null;
        scopeHash     : String(64) not null;
        kind          : String(40) not null;
        subjects      : LargeString not null;
        inputRevision : String(128) not null;
        assessment    : Association to Assessments;
        run           : Association to PredictionRun;
        requestedAt   : Timestamp not null;
}

entity QuestionDecisions {
    key ID         : UUID;
        question   : Association to Questions not null;
        selection  : LargeString not null;
        actor      : String(255) not null;
        decidedAt  : Timestamp not null;
}