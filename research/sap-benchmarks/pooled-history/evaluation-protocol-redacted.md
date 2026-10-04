# Full context on the ERP export

> **Redacted copy.** Counts that could identify the customer are rounded. Everything else is unchanged. The SHA256 in `evaluation-protocol-original.sha256` refers to the unredacted original, which was hashed before the first model call and is available to the organizers on request.

This protocol is hashed before the first model call. Later changes go in a Deviations section. The hash is SHA256 of this file.

## Question

On the full history of this export, how does TabPFN-3.5 without tuning compare with tuned LightGBM on the free-text codes and the lead time ranges the product uses, and what does a call cost in latency?

The source is an industrial company running SAP S/4HANA, an export from a quality system, two years of procurement and master data. Material-master field results are not rerun.

## Split

Plants are pooled. Plant is a feature. The test slice is the 2,000 most recent eligible rows per target, or all of them if fewer exist. The validation slice is the 2,000 most recent rows before that test slice. The context for the validation call is the earlier rows, capped at the 200,000 most recent. The test call uses the 200,000 most recent rows before the test slice, so the validation rows are then inside that context. There is one request per call. If a request is rejected for size, that target stops. Test rows are not split into smaller requests.

## Lead time censoring

The most recent purchase orders are biased toward short lead times, because slow deliveries have not arrived yet. The target is calendar days from the purchase-order date to the first goods receipt, the same definition as the earlier lead time runs. Rows are purchase-order items.

The percentile is computed only on eligible items that already have a goods receipt and that are outside the reserved test and validation slices. The cutoff is the export end, 2026-01-16, minus that 95th percentile rounded up to whole weeks. The rule is applied again if the cutoff moves, and it stops when the cutoff no longer changes.

On this export the 95th percentile of that training slice is 61.0 days, from about 1.9 million items. Rounded up, that is 9 weeks, 63 days. The cutoff is 2025-11-14. The iteration stopped at step 2 because the cutoff did not move again.

Only items with a purchase-order date on or before 2025-11-14 are eligible for the lead time test, validation, and context. The test slice is the 2,000 most recent eligible items that have a goods receipt. On this export those 2,000 items all have purchase-order date 2025-11-14. Share of eligible items on that date with no goods receipt yet: 0.21. That count is not a model result.

The model context is the 200,000 most recent eligible items before the test slice. The validation context is also 200,000 rows. The purchase-order date is not a feature.

Free-text targets are not censored.

## Free text

Targets scored: account assignment category, material group. Input: the item text plus Plant, PurchasingOrganization, PurchaseOrderType, and AccountAssignmentCategory, except that the target column is never an input. Missing values stay missing. Text stays text. Codes stay categorical.

The free-text population is smaller than the cap, so the context is every earlier row. For both targets, about 27,000 context rows for the test call and about 25,000 for the validation call.

Class rule. If a target has at most 160 classes, every class is kept. If it has more, both models see the smallest frequency prefix that covers at least 99 percent of the test-call context, and the remaining rows are labelled other. If that prefix is longer than 159 classes, the target is not called.

Account assignment category has 11 classes, so all are kept. Material group has about 220 classes. The prefix that covers at least 99 percent has about 130 classes, so the rest is other.

Purchasing group is not called. It has about 300 classes, and the prefix for 99 percent has about 210 classes, which is past the endpoint limit of 160. Supplier is not called. It has about 2,500 classes, and the prefix for 99 percent has about 2,200 classes. The earlier supplier and purchasing-group results stay in the report with their original design. No class labels are written down here.

## Models

TabPFN-3.5 on SAP AI Core, default settings, no tuning. The client timeout for this run is 900 seconds. Existing callers keep a 120 second default. There is no retry. On timeout, that target stops and is not called again. If a classification response does not contain a probability for every class that was sent, that target stops and is not called again.

LightGBM default uses library defaults and seed 42. For free text, its text encoding is TF-IDF character n-grams of width 3 to 5, minimum document frequency 2, sublinear term frequency, then truncated SVD with 50 components, the same encoder as the earlier free-text runs. Categorical columns stay categorical.

LightGBM tuned uses Optuna, 50 trials or 30 minutes per target, whichever comes first, the same budget for every target. The search space is n_estimators from 100 to 500, learning_rate from 0.02 to 0.2 on a log scale, num_leaves from 15 to 127, min_child_samples from 5 to 100, feature_fraction from 0.6 to 1, and lambda_l2 from 0.001 to 10 on a log scale. For free text the tuned arm also chooses the SVD width from 50, 128, and 256. Lead time has no text, so it does not choose an SVD width. The objective is validation accuracy for a code, and the absolute error of the median on the validation slice for lead time. Trials completed and tuning time are recorded. If a target finishes fewer than 20 trials, the report says so.

## Metrics

Free text, per scored target:

1. Accuracy.
2. Automation share at 95 percent accuracy. On the validation slice, take the largest share of rows, ranked by confidence, whose accuracy is at least 0.95. Apply that confidence threshold to the test slice. Report the share and the accuracy of the accepted test rows. If no validation threshold reaches 0.95 accuracy, the automation share for that model and target is 0.
3. Expected calibration error, in the table only.

Lead time:

1. Share of the 2,000 test rows whose absolute median error is at most 3 days.
2. Share of those same 2,000 rows whose actual value lies inside the predicted 0.1 to 0.9 range, plus the mean width of that range in days. The stated coverage level is 80 percent. TabPFN returns the three quantiles in one call. LightGBM fits three quantile models. If the three LightGBM predictions for a row are not in increasing order, they are sorted, and the number of such rows is reported.
3. Absolute error of the median, in the table only.

## Comparison

Paired bootstrap over the test rows, 2,000 resamples, seed 42, 95 percent interval of TabPFN minus tuned LightGBM. Ahead or behind only if the interval excludes 0. Otherwise equal. There is no multiplicity correction.

## Cost

A call is charged about 1.05e-6 cost units per context cell and about 1.45e-4 cost units per predicted cell. A cell is one feature value. The validation call and the test call each pay for their own context, because the endpoint does not keep a context between calls.

The dry-run time estimate uses 170 seconds for a call with 200,000 context rows and 5 feature columns, scaled linearly by context cells. It does not use a 30 second estimate at 10,000 rows. The run starts only if the estimate is under 60 cost units and under 2 hours of TabPFN wall time.

The planned calls are the validation call and the test call for lead time, account assignment category, and material group. The estimate is about 13 cost units and about 9 minutes. That is inside the budget.

## Sentences written before the first call

Best case: "On the full history of a real SAP system, TabPFN-3.5 without tuning codes free-text requests at least as well as tuned LightGBM, automates more of them at 95% accuracy, and its lead time ranges hold their stated coverage."

Worst case: "Without tuning, TabPFN-3.5 stays within X accuracy points of tuned LightGBM at full context, with calibrated probabilities and lead time ranges from a single call, at about N seconds per call on SAP AI Core."

The published section uses only the sentence the intervals support, with the measured numbers in place of X and N.
