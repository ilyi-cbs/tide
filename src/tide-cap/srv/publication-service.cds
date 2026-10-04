using {PurchasingDeskService} from './purchasing-desk-service';

@path: 'publication'
@requires: 'user'
service PublicationService {
    @readonly
    @restrict: [{ grant: 'READ', to: 'admin' }]
    entity Snapshots as projection on PurchasingDeskService.Snapshots;
    action prepareDay(dryRun: Boolean) returns Snapshots;
    function overview() returns PurchasingDeskService.Overview;
    function publicationHistory(windowDays: Integer) returns PurchasingDeskService.PublicationHistory;
}
