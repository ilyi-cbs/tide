# Lead time robustness

This protocol is hashed before the first model call. The hash is SHA256 of this file.

## Question

Does the full-context lead time comparison keep its direction at three earlier cutoffs?

## Cutoffs

A cutoff is a purchase-order date. The coverage window is the 56 days up to and including that date. The first cutoff is the latest purchase-order date at which at least 95 percent of purchase-order items in that window have a goods receipt. The other two cutoffs are that date minus 56 days and minus 112 days.

The three cutoffs are 2025-09-04, 2025-07-10, 2025-05-15.

## Split

For each cutoff, the test pool is the purchase-order items with a goods receipt and a lead time whose purchase-order date falls in the 56 days up to and including the cutoff. The test slice is 2,000 of those items, drawn without replacement with seed 42. If fewer than 2,000 exist, every item in the pool is used. The count of purchase-order items in the same window with no goods receipt is reported and is not a model result.

The context is the 200,000 most recent eligible lead-time rows with a purchase-order date on or before the start of that window. The purchase-order date is not a feature. Features are the same as the main full-context lead time run.

## Models

TabPFN-3.5 on SAP AI Core, default settings, one call per cutoff, timeout 900 seconds, no retry. If a call fails, that cutoff stops and is not called again.

LightGBM default uses library defaults and seed 42. LightGBM tuned uses the reproduced parameters from the revision. That reproduction matched the published mean absolute error at the published rounding. Its parameter hash is `cfd8072a0437e082a6915e32f3dd98e469bee961424e6d5318c4f0eab3cfedff`. There is no new tuning.

## Metrics

On the same test rows: share with absolute error of the median prediction at most 3 days, share of actuals inside the 0.1 to 0.9 range, mean range width, and mean absolute error. LightGBM quantile predictions that are out of order are sorted, and the number of such rows is reported. The bootstrap is paired, 2,000 resamples, seed 42, clustered by material, supplier and plant. A positive effect means TabPFN is better.

## Budget

The same cost formula as the main protocol. The run starts only if the estimate for these three calls is under 60 cost units and under 2 hours.
