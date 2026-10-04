# TabPFN against LightGBM on one ERP export

## Key results

All numbers are aggregates of one export. Positive effects mean TabPFN is better. Intervals are 95% paired bootstrap intervals.

| Question | Result |
| --- | --- |
| Lead time, full history (200,000 rows, all plants) | Mean absolute error 5.76 against 6.32 days for tuned LightGBM, effect 0.56 [0.35, 0.77]. Ahead at three earlier cutoffs as well: 0.38, 0.49, 0.59 days. |
| Lead time, little history per plant | Ahead from 250 to 2,500 context rows (0.42 to 0.73 days). Against LightGBM tuned for this size: equal at 250, ahead at 1,000 and 2,500. |
| Free-text codes, accuracy | Account assignment 0.832 against 0.802, material group 0.679 against 0.625 (tuned LightGBM). |
| Free-text codes, coverage at equal accuracy 0.90 | Account assignment 0.861 against 0.776, material group 0.611 against 0.505. At 0.95 the material-group interval includes 0. |
| Tuning effort | LightGBM defaults score 0.169 on material group, below the majority class (0.332). The 50-trial tuning took 6,249 seconds. TabPFN ran without tuning. |
| Not ahead | Lead time at 10,000 rows per plant (exploratory), material-master fields at full size, label noise, error detection. Rollout to an unseen plant is mixed. |
| Limits | A 200,000-row call took about 146 seconds. A request accepts at most 160 classes, so purchasing group and supplier are not scored on the pooled run. |
| All registered comparisons, after Holm correction | 47 TabPFN better, 77 equal, 3 LightGBM better, 1 other baseline better, 11 unreliable fits. |

A replication of the free-text result on public data is in [../usaspending/replication-report.md](../usaspending/replication-report.md).

## Question

When does TabPFN beat LightGBM on this export, and when does it not?

The source is an industrial company running SAP S/4HANA, an export from a quality system, two years of procurement and master data. Every number in this file is an aggregate of this export. Comparisons are against LightGBM, or against a best baseline that includes LightGBM. For a lower-is-better metric, the effect is the comparison value minus the TabPFN value. Otherwise the effect is the TabPFN value minus the comparison value. A positive number means TabPFN is better.

Every comparison, including those without a TabPFN advantage, is in [sap-benchmark-results.csv](sap-benchmark-results.csv).

## How we measured

Protocols were written down and hashed with SHA256 before the first model call of that protocol. The test rows are the later part of the window, and the context is earlier. Differences use a paired bootstrap. The material-master text comparisons are clustered by material, and the free-text comparisons are clustered by purchase order. The best baseline in a cell is the one with the best score on the test set, which favours the baselines. The count table below is not corrected for the number of comparisons. A Holm correction within each registered family is reported beside that table. Comparisons with no registered hash are exploratory and are counted separately. Those are the lead time runs at 10,000 rows per plant, and the material-master comparison at full size.

The model name is TabPFN. The variant is a classifier that returns class probabilities, or a regressor that returns the quantiles 0.1, 0.5 and 0.9. Where a protocol states the version, it is 3.5, on SAP AI Core. The large-context lead-time runs do not record a version. It cannot be determined that they used the same version. Those runs, and the full-size material-master comparison, have no registered hash.

## Results

Grey intervals in the figure cross zero. A fit is unreliable when its accuracy is below the majority class on the same test rows, or when it does not return a usable probability or quantile vector. Those cells are not wins and not losses. An effect outside a panel is drawn at the panel edge, with the value printed beside it. For a lower-is-better metric, effect = comparison minus TabPFN. Otherwise effect = TabPFN minus comparison. Right means TabPFN better.

![Where TabPFN wins. Right means TabPFN better.](benchmark-effect-overview.png)

![Lead time, all suppliers, over context size.](lead-time-context-size-effects.png)

The learning curve is the all-supplier lead time error from the published paired bootstrap, seeds 1 to 3 pooled. That is the series in the figure. TabPFN is ahead from 250 to 2,500 context rows per plant. The effect at 250 rows is 0.42 [0.19, 0.66]. At 500 rows it is 0.66 [0.42, 0.89]. At 1,000 rows it is 0.73 [0.48, 0.97]. At 2,500 rows it is 0.49 [0.27, 0.70]. At 50 rows the all-supplier interval includes 0, 0.03 [-0.23, 0.29], and at 100 rows it is 0.07 [-0.21, 0.38]. The count table uses these published intervals. The LightGBM-better cell at 50 rows is the arm without the largest supplier, -0.55 [-1.03, -0.09], not the all-supplier interval. A clustered sensitivity, with seeds averaged and clustered by material, supplier and plant, is also ahead from 250 to 2,500. At 2,500 rows that sensitivity is 0.57 [0.36, 0.80], against a baseline error of 8.75. At 50 and 100 rows its all-supplier interval includes 0. Without the largest supplier, the clustered interval includes 0 at 50, 100 and 250 rows, and TabPFN stays ahead at 500, 1,000 and 2,500. When material and supplier columns are removed, the effect at 1,000 rows is 0.80 [0.58, 1.03]. At 10,000 rows the combined error is equal, -0.228 [-0.868, 0.382]. That size is the earlier per-plant design and is exploratory. The count at that size also includes the other lead time contrasts: 1 better, 6 equal, 1 LightGBM better.

On free-text purchase items, purchasing group and supplier are ahead of the best baseline at 250, 1,000 and full context. The supplier effect at 1,000 rows is 0.091 [0.076, 0.107]. At 250 rows it is 0.067 [0.050, 0.084], and at full size 0.072 [0.054, 0.091]. Purchasing group is 0.035 [0.025, 0.046] at 250 rows, 0.045 [0.034, 0.057] at 1,000, and 0.025 [0.012, 0.038] at full size. Material group is ahead at 250 rows, 0.023 [0.013, 0.034], equal at 1,000, -0.010 [-0.024, 0.003], and the best baseline is ahead at full size, -0.014 [-0.025, 0.000]. With the material description as a text column, profit center is ahead at 250 rows, 0.045 [0.022, 0.069], at 1,000, 0.032 [0.002, 0.062], and at full size, 0.035 [0.003, 0.066]. Purchasing group with the description is ahead at 1,000, 0.038 [0.020, 0.059], and at full size, 0.032 [0.011, 0.056]. At 250 rows that contrast is equal, 0.000 [-0.016, 0.017].

Calibration error is lower for TabPFN in 4 cells where the LightGBM fit is reliable: decision fields at 50, 1,000 and 2,500 rows, and the text column at 1,000 rows. The count table treats AURC and ECE as separate rows, so those 4 cells are 6 TabPFN-better rows. At 1,000 context rows the share of text-column decisions that can be auto-accepted at the 95% accuracy target is 0.832 for TabPFN and 0.738 for LightGBM. Pooled over fields, the auto-accept share at 1,000 rows is 83%. Full-size calibration fits without a usable probability vector are unreliable, not wins.

Each comparison row is counted once. Accuracy and log loss are separate rows. A lead time count at one context size pools the all-supplier row, the row without the largest supplier, and, where that check was run, the row without material and supplier columns. "Other baseline better" means the interval favours a baseline that is not LightGBM.

| Family | Context | Better | Equal | LightGBM better | Other baseline better | Unreliable fit |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Lead time | 50 | 0 | 1 | 1 | 0 | 0 |
| Lead time | 100 | 0 | 2 | 0 | 0 | 0 |
| Lead time | 250 | 2 | 1 | 0 | 0 | 0 |
| Lead time | 500 | 2 | 0 | 0 | 0 | 0 |
| Lead time | 1,000 | 3 | 0 | 0 | 0 | 0 |
| Lead time | 2,500 | 2 | 1 | 0 | 0 | 0 |
| Lead time | 10,000 | 1 | 6 | 1 | 0 | 0 |
| Material master fields | 50 | 6 | 4 | 0 | 0 | 0 |
| Material master fields | 100 | 4 | 5 | 1 | 0 | 0 |
| Material master fields | 250 | 4 | 6 | 0 | 0 | 0 |
| Material master fields | 500 | 6 | 3 | 1 | 0 | 0 |
| Material master fields | 1,000 | 2 | 5 | 1 | 0 | 0 |
| Material master fields | 2,500 | 2 | 6 | 0 | 0 | 0 |
| Material master fields | full | 0 | 3 | 1 | 1 | 0 |
| Material master with text | 250 | 1 | 4 | 0 | 0 | 0 |
| Material master with text | 1,000 | 2 | 2 | 0 | 0 | 0 |
| Material master with text | full | 2 | 1 | 0 | 1 | 4 |
| Free-text codes | 250 | 4 | 0 | 0 | 0 | 0 |
| Free-text codes | 1,000 | 3 | 1 | 0 | 0 | 0 |
| Free-text codes | full | 2 | 1 | 0 | 1 | 0 |
| Calibration | 50 | 2 | 0 | 0 | 0 | 0 |
| Calibration | 250 | 0 | 0 | 0 | 0 | 2 |
| Calibration | 1,000 | 3 | 1 | 0 | 0 | 0 |
| Calibration | 2,500 | 1 | 1 | 0 | 0 | 0 |
| Calibration | full | 0 | 0 | 0 | 0 | 4 |
| Calibration | held out | 0 | 1 | 1 | 0 | 0 |
| Label noise | 10% | 0 | 4 | 0 | 0 | 0 |
| Label noise | 20% | 0 | 2 | 2 | 0 | 0 |
| Label noise | 30% | 3 | 1 | 0 | 0 | 0 |
| Error detection | full | 0 | 3 | 0 | 0 | 1 |
| Plant not in the context | held out | 2 | 3 | 1 | 1 | 0 |

The table above counts each comparison once, with no correction for how many comparisons were made. On the registered comparisons, before a Holm correction within each family: 59 equal, 58 TabPFN better, 11 unreliable, 8 LightGBM better, 3 other baseline better. After Holm: 77 equal, 47 TabPFN better, 11 unreliable, 3 LightGBM better, 1 other baseline better. The exploratory comparisons, which are not in that correction, are 9 equal, 1 TabPFN better, 2 LightGBM better and 1 other baseline better.

## Small context against tuned LightGBM

The cells above compare TabPFN with the LightGBM settings used at the time. This section refits LightGBM on the same test rows, seed 1 only, with 20 tuning trials and a time-based validation slice inside the context. Seeds 2 and 3 are not retuned. The stored TabPFN predictions are reused. No new TabPFN call is made.

One cell was timed before the grid: 5.0 seconds. The full grid is 308 cells. The estimate was under 4 hours, so the run kept every plant with enough context. The selection uses test-set size only. 308 of 308 cells finished, with 0 stored predictions missing.

| Context rows | Tuned LightGBM, lead time error | L2 quantile regression |
| --- | --- | --- |
| 250 | 0.12 [-0.22, 0.45], equal | 0.72 [0.27, 1.20], ahead |
| 1,000 | 0.50 [0.19, 0.82], ahead | 0.63 [0.34, 0.93], ahead |
| 2,500 | 0.35 [0.11, 0.58], ahead | 0.38 [0.16, 0.62], ahead |

The effect is days of error. Positive means TabPFN is better. The interval is clustered by material, supplier and plant.

On the material-master fields the effect is accuracy. At 250 rows TabPFN is ahead of tuned LightGBM on all four fields: lot sizing 0.086, purchasing group 0.130, valuation class 0.196, profit center 0.350. At 1,000 rows valuation class (0.039) and profit center (0.070) stay ahead, and lot sizing and purchasing group include 0. At 2,500 rows purchasing group stays ahead (0.016) and the other three intervals include 0. Against logistic regression the differences are smaller. Where an interval excludes 0, it favours TabPFN. A plant is omitted from the logistic row when the training slice has a single class.

## Full context

This run pools all plants. The question is how TabPFN-3.5 without tuning compares with tuned LightGBM when the context is the recent history, up to 200,000 rows, on the two product tasks. The method, the split, and the sentences written beforehand are in [pooled-history/evaluation-protocol-redacted.md](pooled-history/evaluation-protocol-redacted.md). That copy rounds counts that could identify the customer. The SHA256 of the unredacted original is `a6df466d5c4a0c77cd77846d73fae9afbd88a3d1e88bfc7102fb40688fd4109c`.

Lead time uses only purchase-order items dated on or before 2025-11-14. That cutoff is the export end minus the training 95th percentile of 61.0 days, rounded up to 9 weeks. The 2,000 test items with a goods receipt all fall on that date. On that date 21 percent of eligible items had no goods receipt yet. Free text is not censored. Its population is smaller than the cap, so the context is every earlier row, about 27,000 for each target.

Purchasing group and supplier are not scored. Covering 99 percent of the context would take about 210 and about 2,200 classes. The endpoint stops at 160. The earlier results for those two targets stay in the sections above, with their original design.

![Risk-coverage curves. Dots mark where each curve is still at 0.90 and at 0.95.](pooled-history/confidence-accuracy-coverage-curves.png)

![Effects against tuned LightGBM. Each panel has its own axis. Right means TabPFN better.](pooled-history/model-comparison-effects.png)

The earlier context-size charts are effects per plant or per segment. The points above are this pooled run. They are not an extension of those lines.

| Target | Metric | TabPFN | LightGBM default | LightGBM tuned | TabPFN minus tuned |
| --- | --- | --- | --- | --- | --- |
| Account assignment | Accuracy | 0.832 | 0.800 | 0.802 | 0.029 [0.016, 0.043], ahead |
| Account assignment | Automation share | 0.864 | 0.669 | 0.745 | 0.119 [0.100, 0.137], ahead |
| Account assignment | Accuracy of accepted rows | 0.898 | 0.944 | 0.919 |  |
| Account assignment | Coverage at accuracy 0.90 | 0.861 |  | 0.776 | 0.085 [0.046, 0.106], ahead |
| Account assignment | Coverage at accuracy 0.95 | 0.727 |  | 0.662 | 0.065 [0.025, 0.111], ahead |
| Material group | Accuracy | 0.679 | 0.169 | 0.625 | 0.054 [0.040, 0.069], ahead |
| Material group | Automation share | 0.565 | 0 | 0.415 | 0.150 [0.132, 0.169], ahead |
| Material group | Accuracy of accepted rows | 0.922 |  | 0.945 |  |
| Material group | Coverage at accuracy 0.90 | 0.611 |  | 0.505 | 0.106 [0.079, 0.141], ahead |
| Material group | Coverage at accuracy 0.95 | 0.500 |  | 0.406 | 0.094 [-0.013, 0.137], equal |
| Lead time | Share within 3 days | 0.645 | 0.629 | 0.619 | 0.027 [0.010, 0.043], ahead |
| Lead time | Range coverage | 0.877 | 0.880 | 0.883 | -0.006 [-0.019, 0.006], equal |
| Lead time | Mean range width, days | 18.7 | 19.5 | 19.3 |  |
| Lead time | Mean absolute error, days | 5.76 | 6.33 | 6.32 | 0.56 [0.35, 0.77], ahead |

The automation share uses a threshold chosen on a validation slice. The realised accuracy of the accepted test rows differs from 0.95, so that share is not the automation claim. The equal-accuracy coverage is a ranking comparison at an oracle threshold: rows are ordered by the test confidence, and the threshold is the largest prefix whose test accuracy is still at the level. The area under the risk-coverage curve is lower for TabPFN. The difference, tuned minus TabPFN, is 0.016 [0.009, 0.025] for account assignment and 0.031 [0.023, 0.039] for material group.

The validation rule aimed at 0.95. On the accepted test rows the realised accuracy is lower. The transfer gap, 0.95 minus that realised accuracy, is 0.052 for TabPFN and 0.031 for tuned LightGBM on account assignment, and 0.028 and 0.005 on material group.

| Cutoff | Window | Share of eligible items with no goods receipt |
| --- | --- | ---: |
| 2025-11-14 | that date | 0.212 |
| 2025-09-04 | 56 days | 0.049 |
| 2025-07-10 | 56 days | 0.021 |
| 2025-05-15 | 56 days | 0.012 |

The items with no goods receipt are the long tail. Both models are scored on the same shorter distribution, so the mean absolute error and the coverage are optimistic for both, and this design does not identify the direction of the difference on the excluded tail. The main test is a single date because the rule of 2,000 most recent eligible rows with a goods receipt filled the test from 2025-11-14. On that date 21 percent of the eligible items have no receipt. The three earlier cutoffs draw 2,000 rows from an 8-week window so the test is not one day.

The LightGBM default accuracy on material group is 0.169. The majority class on the same test rows is 0.332. That fit is unreliable and is not a comparison value. Account assignment stays above its majority class of 0.450.

Lead time and account assignment were tuned again, once, seed 42, 50 trials. Both matched the published rounding, so those tuned numbers stay. Material group uses one 50-trial fit for accuracy, for the validation-rule share, and for the equal-accuracy coverage. The original parameters were not saved and the fit was rerun. The protocol capped tuning at 50 trials or 30 minutes per target. The material-group rerun was run without the time cap, as recorded in [pooled-history/evaluation-revision-notes.md](pooled-history/evaluation-revision-notes.md) before the run. A capped run, superseded, finished 18 trials at accuracy 0.633 and an automation share of 0.438. The conclusion uses the 50-trial numbers only. The 50-trial material group fit took 6,249.3 seconds. Account assignment took 1,126.5 seconds and lead time took 422.3 seconds.

The lead time intervals in the table are clustered by material, supplier and plant. The mean absolute error effect is 0.56 days against a tuned error of 6.32, a relative change of 0.088. Tuned LightGBM had 14 rows whose three quantile predictions were out of order. TabPFN had 0.

The same lead time comparison was repeated at three earlier cutoffs. The test is 2,000 items drawn with seed 42 from the 8 weeks ending at the cutoff. The context is the 200,000 most recent rows before that window. Tuned LightGBM uses the reproduced parameters, with no new tuning. The protocol hash is `cc601a6da29b87ac3d6aaa1cdd78a88ac23a217f1d8489b7c9487a9bb7ff9067`.

| Cutoff | Share with no receipt | Within 3 days | Range coverage | Mean absolute error |
| --- | --- | --- | --- | --- |
| 2025-09-04 | 0.049 | 0.030 [0.013, 0.047], ahead | 0.007 [-0.008, 0.022], equal | 0.38 [0.12, 0.66], ahead |
| 2025-07-10 | 0.021 | 0.052 [0.033, 0.070], ahead | 0.023 [0.008, 0.037], ahead | 0.49 [0.21, 0.76], ahead |
| 2025-05-15 | 0.012 | 0.006 [-0.012, 0.025], equal | -0.018 [-0.035, -0.002], tuned ahead | 0.59 [0.27, 0.93], ahead |

Each call used 3.5 cost units. The three calls took 138.0, 150.5 and 148.3 seconds. None was retried.

Observation. On the two scored free-text targets, TabPFN accuracy is ahead of the 50-trial LightGBM. Coverage at the oracle threshold of 0.90 is ahead on both targets. At 0.95 it is ahead for account assignment, and the material-group interval includes 0. The validation rule aimed at 0.95 accuracy. On the test rows, the accepted account-assignment share reached 0.898 for TabPFN and 0.919 for tuned LightGBM. Material group reached 0.922 and 0.945. Lead time error is ahead on the main run and at all three cutoffs. On the main run both range coverages are above 80 percent: 0.877 and 0.883. The earlier cutoffs are not all above that level. The share within 3 days is ahead on the main run and at the two later cutoffs, and equal at 2025-05-15. Range coverage does not keep one direction: equal on the main run and on 2025-09-04, TabPFN ahead on 2025-07-10, tuned LightGBM ahead on 2025-05-15.

The lead time test call took 145.9 seconds at 200,000 context rows, about 3.5 cost units. Account assignment took 101.0 seconds for its two calls, and material group 97.4 seconds, on the context sizes above. A nightly batch can spend a few minutes on one call per target. A 200,000-row call is not a response a buyer waits for on a click.

Interpretation. On this export, the accuracy comparison supports TabPFN on the two scored free-text targets. The oracle coverage at 0.90 does too. At 0.95 the material-group interval includes 0. The lead time error advantage holds at the earlier cutoffs. The lead time range coverage does not keep one direction. It is not a claim that the accepted test rows themselves reach 0.95 accuracy. Purchasing group and supplier remain outside this run because of the 160-class limit.

## Discussion

The relative change in lead time error, against the comparison model's own error, runs from 0.046 at 250 rows in the clustered sensitivity to 0.088 on the pooled run. That is about 5 to 9 percent. The full-context accuracy differences are 0.029 and 0.054, about 3 and 5 points. The planned delivery time reading rule is not met for any source overall. For the product, TabPFN improves the estimate, and the decision rule still governs what is proposed.

LightGBM with library defaults scores 0.169 on material group, below the majority class of 0.332, so that fit is not a comparison. Tuning that target for 50 trials took 6,249.3 seconds. Account assignment tuning took 1,126.5 seconds and lead time tuning took 422.3 seconds. The lead time test call took 145.9 seconds and about 3.5 cost units. The free-text calls took 101.0 and 97.4 seconds.

There is no CatBoost baseline. There is no censoring-aware evaluation. The small-context arm was tuned with seed 1 only. TabPFN seed variance was not measured. The per-plant large-context runs do not record an endpoint version. Cost units are not converted to currency. Tuning time is a one-off, and inference is recurring.

The counterpoints are the logged cost and the limits of the endpoint. The plausibility run on this export made 1,173 calls. Median latency was 15.9 / 19.3 / 27.6 seconds for free text and 0.1 / 3.5 / 7.3 seconds for lead time. A later check made 225 calls and 0.77 cost units. If the endpoint is unavailable, there is no score. A request accepts at most 160 classes, and the earlier per-plant lead time comparison sends up to 10,000 rows per plant.

## Limit

The results come from one company, one export and one time window. They may not transfer.

## Conclusion

On the pooled run, free text uses every earlier row, about 27,000 per target. Lead time uses 200,000 rows. TabPFN accuracy is ahead of tuned LightGBM on both scored free-text targets. Coverage at an oracle threshold of 0.90 is ahead on both. At 0.95 it is ahead for account assignment, and the material-group interval includes 0. Lead time mean absolute error is ahead on that run and at all three earlier cutoffs. The share within 3 days is not ahead at every cutoff, and range coverage changes direction.

In the small-context arm, against tuned LightGBM and seed 1 only, lead time error is equal at 250 rows and ahead at 1,000 and 2,500. It is ahead of an L2 quantile regression at all three sizes. Material-master fields are ahead at 250 rows. At 1,000 and 2,500 rows some fields stay ahead and some intervals include 0.

TabPFN is not ahead on lead time at 10,000 rows per plant. That comparison is the earlier per-plant design and is exploratory. Material-master accuracy at full size is exploratory in the same sense. Purchasing group and supplier are not scored when the context is pooled, because 99 percent coverage needs about 210 and about 2,200 classes. Label noise is not a consistent advantage. Error detection has no TabPFN win. Rollout to a plant not in the context is mixed.

## Appendix. Product checks

These checks use the same export. They are not in the count table above. Each row has its own population.

A proposal for planned delivery time is better than the maintained value only when both the error of the median and the quantile-matched pinball are significantly lower, for a source and a history bucket. On keys with 1 to 4 earlier lead times (about 61,000 items), the pinball of TabPFN against the lookup ladder is not significant (+0.03). On keys with 5 to 19 earlier lead times (about 150,000 items), both are significant. Across keys with 1 to 19 earlier lead times, TabPFN minus the ladder is -0.63 days of error and -0.23 of pinball. Keys with no earlier lead time have no proposal. Median proposals have a lower error than the maintained value (empirical -0.78 days, ladder -1.17, TabPFN -1.80). The pinball favours the maintained value, so the reading rule is not met for any source overall. A slice that drops the largest supplier is a breakdown in the protocol, not part of that decision. A sentence that the rule is met only on that slice is exploratory.

The worklist backtest uses about 400,000 items from 2025-07-16. The maintained value is late on a share 0.481 of items, and its error is 10.2 days. TabPFN marks about 4.5 percent of the eligible keys. On the flagged keys the median is 24.9 days closer than the maintained value. A ladder that flags the same number of keys, among keys with 1 to 19 history rows, is 31.0 days closer on its flagged items. That population is not the later check in the table.

| Check | Population | Result |
| --- | --- | --- |
| Late against plan, later check | about 2,000 scored keys and 24,000 later items | Late rate 0.650 with the maintained value, 0.132 with the p80 proposal |
| Thresholds before the Wilson bound | 20 cells, youngest 20% of the context, at most 300 rows | The interval lies below 0.95 in 18 cells. It contains 0.95 in 2 cells (account assignment category, both context sizes) |
| Purchasing group, Wilson bound | about 13,000 test rows, 6 segments, context of 250 rows, no category input | Auto-accepted accuracy 0.945, share auto-accepted 0.260. The interval contains the 0.95 target |
| Account assignment category, Wilson bound | same test rows as purchasing group | Auto-accepted accuracy 0.982, share auto-accepted 0.246. The interval is above the 0.95 target |
| Material group, Wilson bound | about 13,000 test rows, same setting | Auto-accepted accuracy 0.959, share auto-accepted 0.122. The interval is below the 0.98 target |
| Delivery-date list | about 1,300 listed items | Tool minus value alone +0.049, against a bar of +0.10. The check does not pass |
| Free-text proposals, volume-weighted sample | 200 items | Overall accuracy is 13 to 24 points below the balanced free-text draw. Accepted rows are about 0.96 correct |
| Lead time ranges on a later sample | 200 items (100 long, 100 short history) | Coverage of p10 to p90 is inside 0.70 to 0.90. The share at or below p80 is 0.851 and 0.889, above 0.75 to 0.85. The check does not pass |
| New materials | 100 cases | Rule fields together 0.74, against a bar of 0.98. Lookups 0.990, against a bar of 0.95 |
| Invariants | free-text codes of the test | 2 percent of the codes from a pooled segment are unused in the plant. 2 non-positive p10 values |
| Repeated calls | 23 repeated requests | 23 of 23 answers identical |
| Chat faithfulness | 50 sessions, then a later check of 15 sessions | 50 of 50 answers matched the tool outputs. The later check matched 10 of 15 |
| Keys with no own history | 30 keys, 29 of 30 answered | The p10 to p90 range contained the later lead time in 22 of 29 answers (0.76) |

The later faithfulness check added rule tools and scored 15 sessions. It matched 10 of 15. All 5 misses were overdue sessions, and the answer did not name the source as a rule. There was no mismatch of a number, a code, or a date.

## Protocols

| Protocol | SHA256 |
| --- | --- |
| Lead time, categorical encoding correction | 2332e851cbf6508be77a72681b1e84fa6359bf881608ee11e0e01de346122b47 |
| Material master fields over context size | 9ac59916837d5b9f027d2f8100c342b6ab11dee4a8ec8207bfcf48d7cc508b3e |
| Lead time over context size | c01d2319557a92747d52b569a1df640971a115e389bdb03ffcc5c4a39b66632e |
| Rollout to a plant not in the context | f68fad85914a5b1fae4fd9a9bbd8b9e7ac43508cde69f18827cc8de953c9d81c |
| Description as a text column | 1510df559a4eb037231f6486a0d56a5f87cb4042dfeb0d65197524f8475d490f |
| Label noise in the context | 16eecf370482b6be2106009288e30de32dcb43b9c9073c07af3d561f716843be |
| Error detection by ranking stored values | 913bab49a143a4e5bcd5971e78a70b26b391784b6bdfb72d6abe18801455a1e4 |
| Calibration and selective prediction | a7cab35e99f7b4c008d5ea08a435a9bfd983bcfab60bc3d2372c43f780e391d8 |
| Text baselines for the description | c116c367e97c5ccb54f54ccf7a8276b805c90e007157d4ddb5de2808590a679e |
| Bootstrap clustered by material | 078e669d1b710a53e7bcb2fd2830ea12def3909ba550dcb31a2c1931ae1fb7bc |
| Frozen nearest-neighbour baselines | d61efb644a1675b977be734bebbe8dbc3435f983f79517812f80cfbe27906eba |
| Lead time feature attribution | 0b68a25656ffb344f43be5aa3deacb8f9471bceaa6f15f402c2f1364f493971c |
| Free-text purchase items to codes | c2248967de6b135d03d65935498566efe0210d79cba5831d3e031fd72f0f6cf5 |
| Free-text thresholds, Wilson bound | 1a09eeafcb3e774f19652de6efa1c4f337f0a5ed6d990858d1612dc6fe58c59c |
| Free-text threshold check | e6bb06be9a76d4540e52c96dd17863d63a83ff86d5e92f5f448a8635c82eb25b |
| Planned delivery time worklist backtest | c95914c222927c718dabaec50c4e357374fbf808d2955ab74aa4f59dc76303b9 |
| Chat and tool plausibility | 83d8fc3cc7b986e8ae4e58ee121d297bb17bfec0f3ca110f4b25b96b06dbda34 |
| Chat and tool plausibility, second section | f69b64141fd1e8433d8394a71f07cefb3b2358795863338b152679d15549d4d5 |
| Core checks and keys without own history | e35af434d94981110a715d254eba458b721ba1fcb1cbaee5ed1797fa315a19a8 |
| Full context, pooled plants | a6df466d5c4a0c77cd77846d73fae9afbd88a3d1e88bfc7102fb40688fd4109c |
| Lead time, three earlier cutoffs | cc601a6da29b87ac3d6aaa1cdd78a88ac23a217f1d8489b7c9487a9bb7ff9067 |
