sap.ui.define([], function () {
    "use strict";

    const STATES = Object.freeze({
        actionRequired: Object.freeze([
            "needs_attention",
            "source_changed",
            "needs_review",
            "follow_up_overdue"
        ]),
        inProgress: Object.freeze(["in_progress"]),
        waiting: Object.freeze([
            "awaiting_decision",
            "waiting_external",
            "awaiting_source"
        ]),
        done: Object.freeze(["done"])
    });

    const PRESENTATION = Object.freeze({
        actionRequired: Object.freeze({ textKey: "attentionActionRequired", state: "Warning", icon: "sap-icon://alert" }),
        inProgress: Object.freeze({ textKey: "attentionInProgress", state: "Information", icon: "sap-icon://status-in-process" }),
        waiting: Object.freeze({ textKey: "attentionWaiting", state: "Information", icon: "sap-icon://pending" }),
        done: Object.freeze({ textKey: "attentionDone", state: "Success", icon: "sap-icon://status-positive" })
    });

    function bucket(attention) {
        return Object.keys(STATES).find(function (key) {
            return STATES[key].includes(attention);
        }) || "actionRequired";
    }

    function text(attention, actionRequired, inProgress, waiting, done) {
        const labels = { actionRequired, inProgress, waiting, done };
        const state = bucket(attention);
        return labels[state] || labels.actionRequired || "Action required";
    }

    function textForBucket(bucketKey, actionRequired, inProgress, waiting, done) {
        const labels = { actionRequired, inProgress, waiting, done };
        return labels[bucketKey] || labels.actionRequired || "Action required";
    }

    function state(attention) {
        return PRESENTATION[bucket(attention)].state;
    }

    function icon(attention) {
        return PRESENTATION[bucket(attention)].icon;
    }

    function textKey(attention) {
        return PRESENTATION[bucket(attention)].textKey;
    }

    return Object.freeze({ bucket, text, textForBucket, state, icon, textKey, states: STATES });
});
