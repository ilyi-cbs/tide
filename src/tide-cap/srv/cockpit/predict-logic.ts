// Predict on request (P-8): the pure core, no CDS imports. The chat fills a
// strict request form (target, threshold, key, filters); code builds the task
// from the 13 features known when a PO is created, runs an 8-week reality
// check first and predicts the open items only if the check beats the simple
// baseline. predict.ts does the I/O (items, feed rows, model runs).
//
// An outcome is known at a reference date when the item was available before
// it; "late by more than N days" is also known without a receipt once the
// reference date is more than N days after the requested date.

export * from "./predict/types";
export * from "./predict/form";
export * from "./predict/features";
export * from "./predict/plan";
export * from "./predict/gate";
