using {PurchasingDeskService} from './purchasing-desk-service';

@path: 'source'
@requires: 'admin'
service SourceService {
    @readonly
    entity Events as projection on PurchasingDeskService.Events;
    action ingest(kind: String, payload: LargeString) returns many Events;
}
