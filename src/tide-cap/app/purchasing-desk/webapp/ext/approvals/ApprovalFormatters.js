sap.ui.define([], function () {
    "use strict";

    const operations = {
        delivery_intervention: "Contact supplier about delivery",
        delivery_escalation: "Escalate delivery follow-up",
        pdt_change: "Update planned delivery time",
        price_clarification: "Review price difference",
        master_data_duplicate_review: "Review duplicate materials",
        requisition_review: "Review purchase requisition",
        prediction_worklist: "Review prediction worklist",
        price_check: "Check price",
        code_list: "Review proposed codes",
        pr_review: "Review purchase requisition",
        post_confirmation: "Record delivery confirmation",
        mdg_case: "Prepare master-data review",
        planner_review: "Review unusual planning setting",
        worklist: "Complete worklist review"
    };

    const statuses = {
        needs_decision: "Needs Decision",
        waiting: "Waiting for Outcome",
        resolved: "Completed",
        declined: "Declined"
    };

    const events = {
        prepared: "Prepared",
        approved: "Approved",
        declined: "Declined",
        resolved: "Outcome Logged",
        follow_up_overdue: "Follow-up Overdue"
    };

    const requestTypes = {
        delivery_intervention: "Delivery Risk - At Risk",
        delivery_escalation: "Delivery Risk - Overdue",
        price_clarification: "Price Deviation",
        master_data_duplicate_review: "Duplicate Materials",
        planner_review: "Unusual Planning Setting",
        pdt_change: "Supplier Planned Time",
        requisition_review: "Purchase Requisition Review",
        code_list: "Code Suggestion Review",
        prediction_worklist: "Prediction Worklist"
    };

    function value(input) {
        return input === null || input === undefined ? "" : String(input).trim();
    }

    function objectLabel(objectKey) {
        const object = value(objectKey);
        const purchaseOrder = /^(\d+)\/(\d+)$/.exec(object);
        if (purchaseOrder) return "Purchase order " + purchaseOrder[1] + ", item " + purchaseOrder[2];
        return object || "Affected object not available";
    }

    return {
        operationLabel: function (operation) {
            return operations[operation] || value(operation) || "Review prepared action";
        },

        requestTypeLabel: function (requestType, operation) {
            return value(requestType) || requestTypes[operation] || "Other Prepared Request";
        },

        statusLabel: function (status, overdue) {
            if (status === "waiting" && overdue) return "Follow-up Overdue";
            return statuses[status] || value(status);
        },

        statusState: function (status, overdue) {
            if (status === "waiting" && overdue) return "Error";
            if (status === "needs_decision" || status === "waiting") return "Warning";
            if (status === "resolved") return "Success";
            if (status === "declined") return "None";
            return "Information";
        },

        statusIcon: function (status, overdue) {
            if (status === "waiting" && overdue) return "sap-icon://alert";
            if (status === "needs_decision") return "sap-icon://pending";
            if (status === "waiting") return "sap-icon://lateness";
            if (status === "resolved") return "sap-icon://status-positive";
            return "sap-icon://status-inactive";
        },

        processText: function (status, overdue) {
            if (status === "declined") return "Prepared  >  Review needed  >  Declined";
            if (status === "resolved") return "Prepared  >  Reviewed  >  Completed";
            if (status === "waiting") return overdue ? "Prepared  >  Approved  >  Follow-up overdue" : "Prepared  >  Approved  >  Outcome pending";
            return "Prepared  >  Review needed  >  Approved";
        },

        objectLabel: objectLabel,

        headerLabel: function (operation, objectKey) {
            const operationLabel = operations[operation] || value(operation) || "Prepared request";
            return operationLabel + " \u00b7 " + objectLabel(objectKey);
        },

        summaryText: function (summary, operation) {
            return value(summary) || "Review the prepared " + (operations[operation] || value(operation) || "action").toLowerCase() + ".";
        },

        hasMissingDecisionDetails: function (summary, objectKey) {
            return !value(summary) || !value(objectKey);
        },

        missingDecisionText: function (summary, objectKey) {
            if (!value(summary) && !value(objectKey)) return "This prepared request is missing its business summary and affected-object details. Review the linked case before deciding.";
            if (!value(summary)) return "This prepared request is missing its business summary. Review the linked case before deciding.";
            return "This prepared request is missing its affected-object details. Review the linked case before deciding.";
        },

        eventLabel: function (event) {
            return events[event] || value(event);
        }
    };
});
