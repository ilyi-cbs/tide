# Revision notes

These notes were written before the revision runs. They do not change the hashed protocol of the main run.

## Reproduction of tuned LightGBM

The original tuned parameters for lead time and account assignment category were not saved. Each study is run once, seed 42, 50 trials, the same search space as the main protocol. There is no second run with another seed to chase the published number.

The published rounding is 6.32 for lead time mean absolute error and 0.802 for account assignment accuracy.

If the rerun matches that published rounding, those parameters are kept and the published tuned numbers stay.

If it does not match, the rerun is the tuned LightGBM result. The published tuned numbers in the full-context table are replaced, the differences and intervals are recomputed, and the report says that the original parameters were not saved and the fit was rerun. The same parameters are used for the robustness calls.

## Material group

One 50-trial tuned fit, with no time cap, is used for accuracy, for the validation-rule automation share, and for equal-accuracy coverage. The 18-trial metrics stay only as a footnote labelled "capped run, superseded". The conclusion and the video cards use the 50-trial numbers only.

## Small-context time cap

The local wall time for the small-context tuned comparison is at most 4 hours. Before that grid starts, the time per cell is estimated from one cell. If the full grid would exceed 4 hours, only the plants with the largest test sets are run, up to the cap. The plants are chosen by test-set size before any fit. Cells are not chosen by result. The report states the selection rule and how many cells were covered.

## Equal accuracy

The published automation claim uses coverage at the same realised test accuracy, 0.90 and 0.95. The earlier automation shares stay in the table, labelled "threshold chosen on validation slice, realised accuracy differs".

## Unreliable fit

A fit is unreliable when its accuracy is below the majority class on the same test rows, or when it does not return a usable probability or quantile vector. That rule is applied in every family. LightGBM default on material group is an unreliable fit and is not a comparison value.

## Sign

For a metric where a lower value is better, effect = value of the comparison model minus value of TabPFN. Otherwise effect = value of TabPFN minus value of the comparison model. A positive effect means TabPFN is better.

## Reading rule

The worklist protocol registers the reading rule for a source and a history bucket. It also lists the slice without the dominant supplier as a breakdown. It does not register a decision that the rule is met only on that slice. That sentence is an exploratory note.
