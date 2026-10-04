// Feature "guard" (T8b): budget ledger (P-15), buyer scope, me(), budget().
namespace tide.cockpit;

using from '../db';

/**
 * Persistent ledger of model calls and cost units, shared by every process on
 * the same database. One row per ledger (ID 'default'); increments are atomic
 * conditional updates (used + x <= limit).
 */
entity BudgetLedger {
    key ID        : String(20);
        calls     : Integer default 0;
        costUnits : Double default 0;
        updatedAt : Timestamp;
}

/** Every recorded paid use (audit, newest last). */
entity BudgetEntry {
    key seq       : Integer;
        at        : Timestamp;
        userId    : String(80);
        label     : String(200);
        calls     : Integer;
        costUnits : Double;
        kind      : String(10); // reserve | record | refused
}
