using {tide.cockpit as cockpit} from './cockpit/kernel/kernel';
using {tide.workflow as workflow} from '../db/workflow';

extend cockpit.Cases with {
    acceptedSourceCondition : LargeString;
    resolvedSourceCondition : LargeString;
}

extend cockpit.CaseEvents with {
    command         : Association to workflow.WorkflowCommands;
    sourceCondition : LargeString;
}

extend cockpit.ActionEvents with {
    command : Association to workflow.WorkflowCommands;
}

@path    : 'workflow'
@requires: 'user'
service WorkflowService {
    type CommandResult {
        commandID         : String(128);
        commandType       : String(80);
        payloadMatched    : Boolean;
        caseID            : String(160);
        actionID          : UUID;
        observationID     : UUID;
        submissionID      : UUID;
        reviewModifiedAt  : Timestamp;
        caseModifiedAt    : Timestamp;
        actionModifiedAt  : Timestamp;
        status            : String(20);
        closure           : String(30);
        sourceFingerprint : String(64);
        listing           : String(10);
    }

    action   prepareSupplierPlannedTimeAction(caseID: String(160),
                                              days: Integer,
                                              commandID: String(128),
                                              expectedModifiedAt: Timestamp,
                                              expectedFingerprint: String(64))                      returns CommandResult;

    action   acceptSupplierPlannedTimeException(caseID: String(160),
                                                note: String(500),
                                                commandID: String(128),
                                                expectedModifiedAt: Timestamp,
                                                expectedFingerprint: String(64))                    returns CommandResult;

    action   approveAction(actionID: UUID,
                           note: String(500),
                           commandID: String(128),
                           expectedModifiedAt: Timestamp)                                           returns CommandResult;

    action   declineAction(actionID: UUID,
                           note: String(500),
                           commandID: String(128),
                           expectedModifiedAt: Timestamp)                                           returns CommandResult;

    function commandResult(commandID: String(128), commandType: String(80), arguments: LargeString) returns CommandResult;

    function deliveryPreparationContext(items: array of String(16))                                 returns LargeString;

    action   prepareDeliveryReminder(items: array of String(16),
                                     expectedEvidence: String(64),
                                     commandID: String(128))                                        returns CommandResult;

    action   enterConfirmation(PurchaseOrder: String(10),
                               PurchaseOrderItem: String(5),
                               date: Date,
                               quantity: Double,
                               commandID: String(128))                                              returns CommandResult;

    action   prepareCaseAction(caseID: String(160),
                               responsiblePerson: String(255),
                               responsibleMessage: String(2000),
                               commandID: String(128),
                               expectedModifiedAt: Timestamp,
                               expectedFingerprint: String(64))                                     returns CommandResult;

    action   submitRequisitionReview(caseID: String(160),
                                     commandID: String(128),
                                     expectedModifiedAt: Timestamp,
                                     expectedReviewToken: String(64))                               returns CommandResult;

    action   acceptCaseException(caseID: String(160),
                                 note: String(500),
                                 commandID: String(128),
                                 expectedModifiedAt: Timestamp,
                                 expectedFingerprint: String(64))                                   returns CommandResult;

    action   recordActionOutcome(actionID: UUID,
                                 resolution: String(30),
                                 completeness: String(10),
                                 note: String(500),
                                 commandID: String(128),
                                 expectedModifiedAt: Timestamp)                                     returns CommandResult;

    action   recordSupplierPosting(actionID: UUID,
                                   completeness: String(10),
                                   target: String(300),
                                   field: String(80),
                                   value: String(255),
                                   note: String(500),
                                   commandID: String(128),
                                   expectedModifiedAt: Timestamp)                                   returns CommandResult;
}
