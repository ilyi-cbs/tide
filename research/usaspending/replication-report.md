# Free-text coding on public USAspending contract awards

Two pre-registered experiments on public US federal procurement data. They test the claim behind the free-text inbox of cbs TIDE: TabPFN with the request text as a string column, plus the organisation fields, proposes code fields better than common text classifiers, and it gives probabilities that can drive an auto-accept threshold.

Source: USAspending.gov, Custom Award Data bulk download, contract awards (award types A to D) of four civilian departments (Veterans Affairs, Health and Human Services, Interior, Agriculture), fiscal years 2023 and 2024. 205,586 awards after deduplication. The request is `backend/buyer_agent/data/usaspending_request.json`; the extract used is identified by `backend/buyer_agent/data/usaspending_manifest.json` (file hashes and row counts). Works of the US federal government are not subject to copyright in the US (17 U.S.C. 105). Source: USAspending.gov.

This note is a pre-registered replication of the free-text result on public US federal contract awards. It is not a description of the demo data.

## Protocols

| experiment | protocol title | SHA256 of the protocol section, registered before the first model call |
|---|---|---|
| Replication | Public replication on USAspending contract awards | `e6b389a4c4757cf8eb1d7c2679e7d4673656c0d038a7a41525c80fcfc059e89a` |
| New codes from a few examples | Few-shot adaptation to new classes (USAspending) | `42e9d3bf2eeefc87543d1ab4feadc0a29cfe0edf45bf9153a1276f44c9cbb2db` |

The registered replication text named a different TabPFN endpoint. Before the first model call the runtime was moved to the SAP AI Core deployment. Data, tasks, split, baselines, metrics and the verdict rule stayed as registered; the change is recorded next to the protocol.

## Replication

### Design

- Tasks (the target is never an input):

| task | target | inputs besides the award description |
|---|---|---|
| Product or service code | `product_or_service_code` (1,452 classes) | awarding office, recipient, sub-agency, agency |
| Awarding office | `awarding_office_code` (303 classes) | product or service code, recipient, sub-agency, agency |
| Recipient | `recipient_uei` (28,988 classes) | product or service code, awarding office, sub-agency, agency |

- Holdout by date: awards from April to September 2024 are the test window, earlier awards are context.
- Segments: sub-agency, or agency pool, with at least 1,000 context rows; the 8 largest per task. 500 test rows per segment, 4,000 per task.
- Context sizes per segment: 250 and 1,000 rows (three random draws each) and full (all context rows, at most 10,000).
- Class limit 160 per draw. Test rows whose class is outside the draw's top classes count as wrong for every method: 8.9% for product or service code, 0% for awarding office, 50.7% for recipient.
- Baselines: majority, TF-IDF kNN with k by cross-validation, kNN within the same organisation group, 1-nearest neighbour, logistic regression on TF-IDF plus one-hot inputs, LightGBM on TF-IDF components. The best baseline per cell is the one with the highest test accuracy, which favours the baselines.
- Comparison: TabPFN with text minus the best baseline, paired bootstrap with 2,000 resamples, clustered by parent award. A task is a win if the difference is significantly positive at 2 or more of the 3 sizes.
- Runtime: 336 TabPFN jobs, 672 calls on SAP AI Core, no failed job, no prediction replaced by a fallback.

### Results

TabPFN wins 3 of 3 tasks (0 losses, 0 equal).

![Accuracy by context size](context-size-accuracy.png)

The figure is an overview of accuracy levels. The comparison rests on the paired differences below.

Accuracy difference to the best baseline, with 95% confidence interval (`best-baseline-accuracy-effects.csv`):

| task | 250 rows | 1,000 rows | full |
|---|---|---|---|
| Product or service code | +0.038 [+0.030, +0.046] | +0.051 [+0.044, +0.058] | +0.041 [+0.032, +0.051] |
| Awarding office | +0.062 [+0.053, +0.071] | +0.063 [+0.055, +0.073] | +0.050 [+0.039, +0.060] |
| Recipient | +0.004 [-0.003, +0.011] | +0.015 [+0.007, +0.023] | +0.018 [+0.009, +0.027] |

![Difference to the best baseline](best-baseline-accuracy-effects.png)

- Log loss is significantly lower than the best baseline's in all 9 cells.
- The strongest baseline is logistic regression on TF-IDF in 6 of 9 cells. The gain is not measured against weak baselines.
- The text column matters inside TabPFN: with text minus without text is +0.029 to +0.162, significant in all 9 cells.
- Restricted to test rows whose class is reachable, the verdicts are the same.
- In some sub-agencies the award description starts with the recipient's name (10% of test rows). Without these rows the verdicts are the same and the differences move by at most 0.003.

### Calibration and auto-accept

Share of test rows that can be accepted automatically at 95% accuracy on the test rows (coverage), 1,000 context rows:

| task | TabPFN with text | best baseline |
|---|---|---|
| Product or service code | 0.44 | 0.40 (logistic regression) |
| Awarding office | 0.40 | 0.26 (logistic regression) |
| Recipient | 0.02 | 0.00 (kNN within organisation group) |

- The area under the risk-coverage curve is significantly lower for TabPFN than for logistic regression in all 18 cells (3 tasks, 3 sizes, all rows and reachable rows).
- Expected calibration error is significantly lower in 15 of 18 cells and significantly higher in 3: recipient on all rows. Half of the recipient test rows have a class the model never saw in the context; on reachable recipient rows its calibration error is lower at every size.
- Consequence for the product: the auto-accept threshold of each segment is set on its most recent requests as holdout, with a Wilson lower bound on the accuracy target (`scripts/calibrate_thresholds`), not taken from the model's raw probability.

### Reading

- On code fields with a few hundred classes, TabPFN with the text column beats the best of six baselines by 4 to 6 accuracy points at every context size.
- Recipient is a weak task for every method (TabPFN 0.14 to 0.28). The win there is small; it is not a usable supplier proposal at this level. cbs TIDE does not propose suppliers from free text.
- Limits: one public source, four departments, 8 segments per task, best baseline chosen on the test set.

## New codes from a few examples

Question: when a segment meets a code it has never seen, and a buyer confirms 1, 2 or 4 examples of it, does TabPFN predict the new code on further requests sooner than a refit text classifier, without predicting it on other requests?

- Same extract, tasks and segments as the replication. A new code occurs at least 4 times in the test window and never in the context period.
- Evaluable: product or service code (10 new codes, thin) and recipient (63 new codes). Awarding office has no new office in the data.
- Reading rule, registered: "TabPFN adapts faster" if its recall on the new codes at 1 or 2 examples is significantly higher than both refit baselines (logistic regression and kNN with k by cross-validation), and its accuracy on the other rows does not drop significantly.
- Runtime: 52 TabPFN jobs, 105 calls on SAP AI Core.

![Recall on new codes](new-code-adaptation-recall.png)

The figure shows recall; the precision of new-code predictions was not higher for TabPFN than for the baselines.

| task | reading | recall at 1 / 2 / 4 examples: TabPFN, logistic regression, kNN |
|---|---|---|
| Product or service code | not shown | 0.17 / 0.37 / 0.67; 0.00 / 0.03 / 0.06; 0.21 / 0.47 / 0.78 |
| Recipient | TabPFN adapts faster (1 and 2 examples) | 0.67 / 0.76 / 0.82; 0.00 / 0.04 / 0.58; 0.17 / 0.40 / 0.53 |

- On recipient, accuracy on the other rows does not change significantly. TabPFN predicts a new recipient on 3.4 to 3.9% of the other rows.
- Most of the recipient effect comes from follow-up awards under the same parent award as a confirmed example (61 to 70% of the evaluation rows).
- A baseline added after the run and not part of the registered reading: copying the code of the most similar item (1-nearest neighbour). It reaches 0.57 / 0.69 / 0.77 on recipient; TabPFN is 5 to 10 points ahead, and only on follow-up awards under the same parent. On product or service code the most similar item is better than TabPFN. The precision of new-code predictions is not higher for TabPFN.
- Reading: the claim is narrow. cbs TIDE does not claim faster learning of new codes.

## Files

| file | content |
|---|---|
| `context-size-accuracy.csv` | test accuracy per task, context size and method |
| `best-baseline-accuracy-effects.csv` | TabPFN with text minus the best baseline, accuracy and log loss, 95% intervals |
| `new-code-adaptation-recall.csv` | recall on new codes by number of confirmed examples |
| `plot_usaspending.py` | draws the three figures from the CSV files |
