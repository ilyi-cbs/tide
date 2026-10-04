namespace tide.core;

using {
    cuid,
    managed
} from '@sap/cds/common';

type Task            : String enum {
    classification;
    regression;
}

type RunStatus       : String enum {
    pending;
    running;
    succeeded;
    failed;
}

/** Stable error codes; the matching user-safe text is in errorMessage. */
type ErrorCode       : String enum {
    TABULAR_UNAVAILABLE;
    TABULAR_TIMEOUT;
    TABULAR_REJECTED;
    TABULAR_MALFORMED;
    TABULAR_OUTCOME_UNKNOWN;
    NO_TRAINING_DATA;
    UNKNOWN_KEYS;
    INFERENCE_FAILED;
    MODEL_TIMEOUT;
    INTERNAL;
}

/** What tabular returns per row: class probabilities, a point, or quantiles. */
type OutputType      : String enum {
    probas;
    point;
    quantiles;
}

type OutputSpec {
    /** Defaults to probas (classification) / point (regression). */
    type   : OutputType;
    /** Quantile levels in (0, 1), e.g. [0.1, 0.5, 0.9]; only for quantiles. */
    levels : many Double;
}

type FilterOp        : String enum {
    eq = '=';
    ne = '!=';
    lt = '<';
    le = '<=';
    gt = '>';
    ge = '>=';
    ![in] = 'in';
    isNull = 'isNull';
}

type FilterClause {
    col    : String;
    op     : FilterOp;
    /** Comparison value, as text (ignored for isNull). */
    value  : String;
    /** Value list for op 'in'. */
    values : many String;
}

/** Explicit context exclusion; unlike a filter, matching rows are removed. */
type ExclusionClause {
    col    : String;
    values : many String;
}

type DatasetSpec {
    /** Feed name as returned by listFeeds. */
    feed     : String;
    /** Column with role 'target'. */
    target   : String;
    /** Columns with role 'feature'. */
    features : many String;
    task     : Task;
    /** Training rows: feed rows matching all filters (AND). */
    train    : {
        filter  : many FilterClause;
        exclude : many ExclusionClause;
    };
    /** Feed row keys to predict. */
    predict  : {
        keys      : many String;
        /** Scenario feature values per predict key; validated by the dataset builder. */
        overrides : PredictOverrides;
    };
    output   : OutputSpec;
}

/** Map of predict key to { feature: scalar | null }. */
@open
type PredictOverrides {}

type FeedColumn {
    name : String;
    type : String;
    /** key | feature | target | outcome */
    role : String;
}

type Feed {
    name        : String;
    description : String;
    ![key]      : String;
    columns     : many FeedColumn;
}

type FeedDescription : Feed {
    rowCount : Integer64;
}

type RunResult {
    rowKey        : String;
    /** Argmax class, point value, or median of the quantiles. */
    value         : String;
    /** JSON object class -> probability (probas only). */
    probabilities : LargeString;
    /** JSON array aligned with the run's levels (quantiles only). */
    quantiles     : LargeString;
}

type Run {
    ID                    : UUID;
    status                : RunStatus;
    feed                  : String;
    target                : String;
    task                  : Task;
    errorCode             : ErrorCode;
    errorMessage          : String;
    trainRows             : Integer;
    elapsedMs             : Double;
    outputType            : OutputType;
    /** JSON array of quantile levels (quantiles only). */
    levels                : LargeString;
    /** context_distribution | context_quantiles when no model was called. */
    fallback              : String;
    /** JSON array of feature columns tabular dropped as constant. */
    droppedColumns        : LargeString;
    /** Model backend calls made for this run (0 for a fallback). */
    modelCalls            : Integer;
    costUnits             : Double;
    inputFingerprint      : String;
    backend               : String;
    modelVersion          : String(80);
    effectiveFeatureCount : Integer;
    contextCells          : Integer;
    predictedCells        : Integer;
    createdAt             : Timestamp;
    modifiedAt            : Timestamp;
    resultCount           : Integer;
    results               : many RunResult;
}

/** Emitted by CoreService in the transaction that marks a run succeeded. */
type RunSucceeded {
    runId  : UUID;
    feed   : String;
    target : String;
    task   : Task;
}

/**
 * One execution of a normalized DatasetSpec. Runs are shared: identical specs
 * (same immutable input fingerprint) reuse the same run across users. Who asked for a run is
 * recorded in PredictionRequest, which is what users are allowed to see.
 */
@assert.unique: {inputFingerprint: [inputFingerprint]}
entity PredictionRun : cuid, managed {
    /** Legacy request identity retained for diagnostics. */
    specHash                  : String(64);
    /** SHA-256 of exact selected input, backend, and contract version. */
    inputFingerprint          : String(64) not null;
    predictionContractVersion : String(40) not null;
    spec                      : LargeString;
    /** Immutable tabular request selected before this run was claimed. */
    inputSnapshot             : LargeString;
    feed                      : String;
    target                    : String;
    task                      : Task;
    status                    : RunStatus default 'pending';
    errorCode                 : ErrorCode;
    errorMessage              : String;
    trainRows                 : Integer;
    elapsedMs                 : Double;
    outputType                : OutputType;
    levels                    : LargeString;
    fallback                  : String;
    droppedColumns            : LargeString;
    /** Backend identity used when the immutable input was claimed. */
    backend                   : String;
    modelVersion              : String(80);
    backendIdentity           : LargeString;
    modelCalls                : Integer;
    /** Cells sent to the model, as reported by tabular's usage. */
    modelCells                : Integer;
    effectiveFeatureCount     : Integer;
    contextCells              : Integer;
    predictedCells            : Integer;
    costUnits                 : Double;
    correlationId             : String;
    /** Short-lived ownership token for persistent-queue execution recovery. */
    executionLease            : String(36);
    leaseExpiresAt            : Timestamp;
    dispatchStartedAt         : Timestamp;
    responseSnapshot          : LargeString;
    results                   : Composition of many PredictionResult
                                    on results.run = $self;
    requests                  : Association to many PredictionRequest
                                    on requests.run = $self;
}

/** Primary key (run, rowKey) also serves the lookups by run and by row. */
entity PredictionResult {
    key run           : Association to PredictionRun;
    key rowKey        : String;
        value         : String;
        probabilities : LargeString;
        quantiles     : LargeString;
}

/** A user's request for a run; createdBy is the owner for row-level access. */
@assert.unique: {owner: [
    run,
    createdBy
]}
entity PredictionRequest : cuid, managed {
    run          : Association to PredictionRun not null;
    principal    : String(255);
    app          : String(80);
    scopeHash    : String(64);
    capability   : String(80);
    specification : LargeString;
    correlationId : String(128);
    deadline     : Timestamp;
}

entity UsageReservations : cuid {
    request       : Association to PredictionRequest not null;
    run           : Association to PredictionRun not null;
    attempt       : Integer not null;
    admittedUnits : Decimal(19, 4) not null;
    actualUnits   : Decimal(19, 4);
    status        : String(20) not null;
    admittedAt    : Timestamp not null;
    reconciledAt  : Timestamp;
}
