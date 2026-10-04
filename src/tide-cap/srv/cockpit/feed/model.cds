using {tide.cockpit as c} from '../db';
using {PurchasingDeskService} from '../../purchasing-desk-service';

/**
 * Before-image of every tide.s4 row the feed wrote, in write order. Used to
 * detect whether a field has been freshly supplied since a given timestamp
 * (`freshFieldObservation`); not an undo/replay log.
 */
entity tide.cockpit.FeedJournal {
    key ID       : Integer;
        entity   : String(80); // tide.s4 entity name, e.g. PurchaseOrderItem
        keys     : LargeString; // JSON object of the key fields
        before   : LargeString; // JSON row before the write; null = inserted
        supplied : LargeString;
        at       : Timestamp;
}

/**
 * Durable state of one source batch. A fingerprint identifies the exact input
 * so an already applied day is never replayed against a changed payload.
 */
entity tide.cockpit.FeedRun {
    key day         : Date;
        fingerprint : String(64);
        status      : String(12); // running | applied | failed
        startedAt   : Timestamp;
        finishedAt  : Timestamp;
        events      : Integer;
        modelCalls  : Integer;
        costUnits   : Double;
        error       : String(500);
}

extend service PurchasingDeskService with {
    /** Upserts the rows of changed documents (kind change) without hooks or events. Admin only. */
    action applyChanges(payload: LargeString) returns Integer;
}
