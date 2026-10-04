namespace tide.publication;

using {tide.cockpit.Snapshot} from './publication';

entity PublicationBaselines {
    key context      : String(20);
    key scopeHash    : String(64);
    key purpose      : String(80);
    key businessDate : Date;
        snapshot     : Association to Snapshot not null;
        selectedAt   : Timestamp not null;
        retainUntil  : Timestamp;
}

entity Scenarios {
    key ID         : UUID;
        principal  : String(255) not null;
        app        : String(80) not null;
        scopeHash  : String(64) not null;
        sourceRevision : String(128) not null;
        createdAt  : Timestamp not null;
        status     : String(20) not null;
        version    : Integer not null default 0;
        assumptions : Composition of many ScenarioAssumptions on assumptions.scenario = $self;
}

entity ScenarioAssumptions {
    key scenario        : Association to Scenarios;
    key scenarioVersion : Integer;
    key assumptionKey   : String(128);
        subjectKey      : String(300) not null;
        parameter       : String(80) not null;
        value           : LargeString not null;
        unit            : String(20);
        origin          : String(40) not null;
        limits          : LargeString;
}

entity Briefs {
    key ID               : UUID;
        snapshot         : Association to Snapshot not null;
        baseline         : Association to PublicationBaselines;
        principal        : String(255) not null;
        app              : String(80) not null;
        scopeHash        : String(64) not null;
        asOf             : Date not null;
        sourceFreshness  : String(20) not null;
        calculationStatus : String(20) not null;
        factSchemaVersion : String(40) not null;
        factsHash        : String(64) not null;
        createdAt        : Timestamp not null;
        expiresAt        : Timestamp not null;
        facts            : Composition of many BriefFacts on facts.brief = $self;
}

entity BriefFacts {
    key brief          : Association to Briefs;
    key section        : String(80);
    key metric         : String(80);
        value          : LargeString;
        unit           : String(20);
        unavailableReason : String(120);
        classification : String(20) not null;
        completeness   : String(20) not null;
        provenance     : LargeString;
}

entity BriefNarratives {
    key ID              : UUID;
        brief           : Association to Briefs not null;
        factsHash       : String(64) not null;
        promptVersion   : String(40) not null;
        outputSchemaVersion : String(40) not null;
        alias           : String(120);
        deployment      : String(120);
        correlation     : String(128);
        usage           : LargeString;
        status          : String(20) not null;
        narrative       : LargeString;
        generatedAt     : Timestamp;
}