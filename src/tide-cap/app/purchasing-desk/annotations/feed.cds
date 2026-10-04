using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

// UI annotations of feature "feed" (stream-owned, contract cockpit.v3 §1).
// E.g. `annotate service.Findings with @(UI.SelectionPresentationVariant #<List>: {…});`
// or annotations of the feature's own entities.

// The event feed (ext/feed/EventFeed.fragment.xml) reads Events directly;
// titles for the few places FE shows them (value helps, admin tables).
annotate service.Events with {
    seq       @title: 'Number';
    at        @title: 'Recorded';
    simTime   @title: 'Time';
    kind      @title: 'Kind';
    title     @title: 'What happened';
    findingID @title: 'Finding';
    objectKey @title: 'Object';
    source    @title: 'Source';
    status    @title: 'Status';
};
