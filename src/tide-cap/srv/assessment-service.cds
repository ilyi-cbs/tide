using {PurchasingDeskService} from './purchasing-desk-service';

@path: 'assessment'
@requires: 'user'
service AssessmentService {
    action assessPrevention(caseID: String(160), metric: String, lateDays: Integer,
                            expectedFingerprint: String(64)) returns PurchasingDeskService.PreventionAssessment;
}
