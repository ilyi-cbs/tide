using PurchasingDeskService as service from '../../../srv/purchasing-desk-service';

// UI annotations of feature "overview" (stream-owned, contract cockpit.v3 §1).
// E.g. `annotate service.Findings with @(UI.SelectionPresentationVariant #<List>: {…});`
// or annotations of the feature's own entities.

annotate service.FindingsDailyPriority with {
    day          @title: 'Day';
    priority     @UI.Hidden;
    priorityText @title: 'Priority';
    count        @title: 'Findings';
};

annotate service.DeliveryPriorityDaily with {
    day      @title: 'Day';
    priority @UI.Hidden;
    count    @title: 'Open delivery work';
};

// One row per (day, priority level), written by the overview pipeline step
// after each prepareDay run. Morning Brief renders the latest completed days
// as a native UI5 stacked-column visualization.
