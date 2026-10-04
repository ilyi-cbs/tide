using {PurchasingDeskService} from './purchasing-desk-service';
using {WorkflowService} from './workflow-service';

@path: 'review'
@requires: 'user'
service ReviewService {
    function requestsWorkflowSummary() returns PurchasingDeskService.RequestsWorkflowSummary;
    function commandResult(commandID: String(128), commandType: String(80), arguments: LargeString) returns WorkflowService.CommandResult;
    action submitRequisitionReview(caseID: String(160), commandID: String(128),
                                   expectedModifiedAt: Timestamp,
                                   expectedReviewToken: String(64)) returns WorkflowService.CommandResult;
}
