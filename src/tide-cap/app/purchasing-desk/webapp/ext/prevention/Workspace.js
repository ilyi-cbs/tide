sap.ui.define(
  [
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/NumberFormat",
    "sap/ui/core/format/DateFormat",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "tide/cockpit/ext/shared/WorkflowPending",
  ],
  function (JSONModel, NumberFormat, DateFormat, Filter, FilterOperator, WorkflowPending) {
    "use strict";

    const pages = new WeakMap();
    const number = NumberFormat.getFloatInstance({ maxFractionDigits: 2 });
    const priceNumber = NumberFormat.getFloatInstance({
      minFractionDigits: 2,
      maxFractionDigits: 2,
    });
    const date = DateFormat.getDateTimeInstance({ style: "medium" });
    const configurations = {
      PriceDeviations: {
        navigation: "priceHistory,assessment",
        predictionTitle: "Expected Unit Price",
        primary: "Prepare Price Clarification",
        alternative: "Accept Price as Justified",
        description:
          "Prepare a clarification for the responsible buyer. No purchase-order price is changed.",
        acceptance:
          "Close this case when the entered price is valid. Record the business reason.",
        message: "Why is this price justified?",
      },
      DuplicateMaterials: {
        navigation: "candidates",
        predictionTitle: "Suggested Planning Values",
        primary: "Prepare Master-Data Review",
        alternative: "Keep Materials Separate",
        description:
          "Send the complete candidate group for master-data review. No materials are merged or changed.",
        acceptance:
          "Keep the materials separate and record why the matching descriptions are intentional.",
        message: "Why should these materials remain separate?",
      },
      UnusualSettings: {
        navigation: "settingPairs",
        predictionTitle: "Suggested Planning Settings",
        primary: "Request Configuration Review",
        alternative: "Accept Settings as Intentional",
        description:
          "Ask the MRP controller or master-data owner whether this configuration is intentional and appropriate. Rarity alone does not justify a correction. No SAP settings are changed.",
        acceptance:
          "Close this case when the settings are intentional for this material and plant.",
        message: "Why are these settings intentional?",
      },
      SupplierPlannedTimes: {
        predictionTitle: "Expected Supplier Delivery Time",
        primary: "Prepare Supplier Lead-Time Change",
        alternative: "Keep Current Supplier Setting",
        description:
          "Prepare the proposed purchasing-info-record change for approval. The supplier setting is not changed immediately.",
        acceptance:
          "Keep the current supplier setting and record the business reason.",
        message: "Why should the current supplier setting be kept?",
      },
      MaterialPlannedTimes: {
        predictionTitle: "Expected Delivery Time by Supplier",
        primary: "Prepare Material Lead-Time Change",
        alternative: "Keep Current Material Setting",
        description:
          "Prepare the proposed material-and-plant change for approval. The master-data setting is not changed immediately.",
        acceptance:
          "Keep the current material setting and record the business reason.",
        message: "Why should the current material setting be kept?",
      },
    };

    function numeric(value) {
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        typeof value === "boolean"
      )
        return null;
      const result = Number(value);
      return Number.isFinite(result) ? result : null;
    }

    function viewOf(control) {
      let current = control;
      while (current && !current.isA("sap.ui.core.mvc.View"))
        current = current.getParent();
      return current;
    }

    function state(entity, row) {
      function validRange(low, median, high, intermediate) {
        const values = [low, median, high].map(numeric);
        const middle = numeric(intermediate);
        return (
          values.every(function (value) {
            return value !== null && value >= 0;
          }) &&
          values[0] <= values[1] &&
          values[1] <= values[2] &&
          (middle === null || (values[1] <= middle && middle <= values[2]))
        );
      }
      const config = configurations[entity];
      const facts = [];
      function fact(label, value, unit) {
        if (value === null || value === undefined || value === "") return;
        facts.push({
          label: label,
          value:
            (typeof value === "number" ? number.format(value) : String(value)) +
            (unit ? " " + unit : ""),
        });
      }
      const source = row.header || {};
      const members = row.candidates || row.settingPairs || [];
      const lines = members.map(function (line) {
        return {
          ...line,
          orders: numeric(line.n1),
          movements: numeric(line.n2),
          count: numeric(line.n3),
          reference: line.label === row.Material,
        };
      });
      const active = (row.caseActions || []).find(function (link) {
        return ["needs_decision", "waiting"].includes(link.action?.status);
      });
      const result = {
        loaded: true,
        loading: false,
        error: "",
        busy: false,
        modelAI: false,
        modelTrigger: false,
        pricePage: entity === "PriceDeviations",
        hasCandidatePredictions: false,
        entity: entity,
        config: config,
        row: row,
        fingerprint: source.sourceFingerprint,
        sourceChanged: !!row.caseSourceChanged,
        canPrepare:
          row.caseStatus === "open" && !!source.sourceFingerprint && !active,
        canAccept:
          row.caseStatus === "open" && !!source.sourceFingerprint && !active,
        activeAction: !!active,
        actionHref: active ? "#/Actions(" + active.action_ID + ")" : "",
        actionStatus:
          active?.action?.status === "needs_decision"
            ? "Awaiting approval decision"
            : "Waiting for review outcome",
        closed: row.caseStatus === "closed",
        closureNote: source.closureNote || "",
        lines: lines,
        hasLines: lines.length > 0,
        facts: facts,
        chart: null,
        events: (row.caseEvents || [])
          .slice()
          .sort(function (left, right) {
            return String(right.occurredAt).localeCompare(
              String(left.occurredAt),
            );
          })
          .map(function (event) {
            return {
              ...event,
              label: event.event.replace(/_/g, " "),
              date: date.format(new Date(event.occurredAt)),
            };
          }),
      };
      if (entity === "PriceDeviations") {
        const current = numeric(row.unitPrice);
        const median = numeric(row.priorMedian);
        const deviation =
          current !== null && median > 0 ? (current / median - 1) * 100 : null;
        result.deviation =
          deviation === null
            ? "Not available"
            : number.format(Math.abs(deviation)) +
              "% " +
              (deviation < 0 ? "below" : "above");
        result.banner =
          deviation === null
            ? "The entered price requires comparison with the available price evidence."
            : "Entered unit price is " +
              result.deviation +
              " the historical median.";
        const points = (row.priceHistory || [])
          .map(function (line) {
            return {
              x: Date.parse(line.date),
              y: numeric(line.amount),
              name: line.label || "Comparable observation",
              current: !!line.isCurrent,
            };
          })
          .filter(function (point) {
            return Number.isFinite(point.x) && point.y !== null && point.y >= 0;
          });
        result.priceLines = row.priceHistory || [];
        result.hasPriceHistory = points.length > 0;
        result.chart = points.length
          ? {
              kind: "price",
              title: "Comparable price history",
              unit: row.currency,
              median: median,
              points: points,
            }
          : null;
        result.priceModel = row.assessment || {};
        try {
          const retainedPrice = JSON.parse(
            row.assessmentJson || "null",
          )?.metrics?.find(function (entry) {
            return (
              entry.label === "Expected unit price P10/P50/P90" &&
              numeric(entry.value?.p50) !== null
            );
          });
          if (retainedPrice) {
            result.priceModel = {
              ...result.priceModel,
              ...retainedPrice.detail,
              source: retainedPrice.source,
              expectedP10: retainedPrice.value.p10,
              expectedP50: retainedPrice.value.p50,
              expectedP90: retainedPrice.value.p90,
            };
          }
        } catch (_) {}
        result.modelSource =
          result.priceModel.source === "tabpfn"
            ? "TabPFN expected price"
            : result.priceModel.source === "fallback"
              ? "Fallback estimate (not TabPFN)"
              : "No TabPFN estimate retained";
        result.modelAI = result.priceModel.source === "tabpfn";
        result.modelTrigger =
          result.modelAI &&
          result.priceModel.alert === true &&
          result.priceModel.calibrationStatus === "calibrated";
        result.modelValidation =
          result.priceModel.calibrationStatus === "calibrated"
            ? "Calibrated prediction; not an error probability"
            : "Uncalibrated estimate; not an error probability";
        result.hasModel = numeric(result.priceModel.expectedP50) !== null;
        result.hasModelRange = validRange(
          result.priceModel.expectedP10,
          result.priceModel.expectedP50,
          result.priceModel.expectedP90,
        );
        const expectedPrice = numeric(result.priceModel.expectedP50);
        result.modelDeviation =
          expectedPrice > 0 && current !== null
            ? number.format(Math.abs((current / expectedPrice - 1) * 100)) +
              "% " +
              (current < expectedPrice ? "below" : "above") +
              " expected price"
            : "Not available";
        if (result.modelTrigger)
          result.banner =
            "TabPFN flagged the entered unit price against the expected comparable-price range. " +
            result.modelDeviation +
            ".";
        else if (result.hasModel)
          result.banner =
            result.modelDeviation +
            ". " +
            (result.modelAI
              ? "No calibrated model alert is retained; review the available evidence."
              : "Fallback evidence is not a TabPFN prediction.");
        result.priceQuantiles = [
          { label: "P10", value: numeric(result.priceModel.expectedP10) },
          { label: "P50", value: numeric(result.priceModel.expectedP50) },
          { label: "P90", value: numeric(result.priceModel.expectedP90) },
        ].map(function (quantile) {
          return {
            label: quantile.label,
            value:
              quantile.value === null
                ? "Not available"
                : number.format(quantile.value),
          };
        });
        fact("Raw entered amount", row.currentPrice, row.currency);
        fact(
          "Potential unit-price difference",
          row.potentialDifference,
          row.currency,
        );
        fact(
          "Comparison scope",
          "Same material, plant, currency, and order unit",
        );
        fact(
          "Model evidence",
          result.hasModel
            ? result.priceModel.calibrationStatus === "calibrated"
              ? "Calibrated expected range"
              : "Uncalibrated estimate; not an error probability"
            : "Historical comparison only; no model estimate available",
        );
        fact(
          "Case creation basis",
          result.modelTrigger
            ? "Background TabPFN price assessment"
            : "No retained calibrated model alert",
        );
        fact("Model source", result.modelSource);
        fact("Model backend", result.priceModel.backend);
        fact(
          "Prediction contract",
          result.priceModel.predictionContractVersion,
        );
        fact("Training rows", result.priceModel.trainingRows);
        fact("Validation period", result.priceModel.validationPeriod);
        fact("Prediction run", result.priceModel.run_ID);
        fact("Imported data as of", result.priceModel.asOf);
        fact("Assessment computed", result.priceModel.computedAt);
        fact("Comparable observations", row.priorCount);
        fact("Price quantity", row.priceQuantity);
        const modelLabels = [
          "Model evidence",
          "Case creation basis",
          "Model source",
          "Model backend",
          "Prediction contract",
          "Training rows",
          "Validation period",
          "Prediction run",
          "Imported data as of",
          "Assessment computed",
        ];
        result.priceModelFacts = facts.filter(function (entry) {
          return modelLabels.includes(entry.label);
        });
        result.priceEmpiricalFacts = facts.filter(function (entry) {
          return !modelLabels.includes(entry.label);
        });
      } else if (entity === "DuplicateMaterials") {
        result.banner =
          row.candidateCount +
          " materials have similar descriptions. Similarity and planning predictions do not establish technical equivalence.";
        result.incomplete = numeric(row.candidateCount) !== lines.length;
        result.orders =
          !result.incomplete &&
          lines.length &&
          lines.every(function (line) {
            return line.orders !== null;
          })
            ? lines.reduce(function (sum, line) {
                return sum + line.orders;
              }, 0)
            : null;
        result.movements =
          !result.incomplete &&
          lines.length &&
          lines.every(function (line) {
            return line.movements !== null;
          })
            ? lines.reduce(function (sum, line) {
                return sum + line.movements;
              }, 0)
            : null;
        result.chart = lines.length
          ? { kind: "activity", title: "Candidate activity", rows: lines }
          : null;
        result.ordersChart = {
          kind: "candidateActivity",
          title: "Purchase orders",
          metric: "orders",
          rows: lines,
        };
        result.movementsChart = {
          kind: "candidateActivity",
          title: "Material movements",
          metric: "movements",
          rows: lines,
        };
        fact(
          "Matching basis",
          "Fuzzy description search within the same material type; matching numeric tokens. Similarity is not duplicate probability.",
        );
        fact("Technical equivalence", "Not established by this finding");
        fact("Activity window", "Last 12 months");
      } else if (entity === "UnusualSettings") {
        result.banner =
          "These setting combinations are uncommon in the recorded peer group. They may be intentional.";
        const counted = lines.filter(function (line) {
          return line.count !== null;
        });
        result.chart = counted.length
          ? {
              kind: "peers",
              title: "Observed combination counts",
              rows: counted,
            }
          : null;
        result.incomplete = numeric(row.unusualPairCount) !== lines.length;
        fact("Peer-group material type", row.materialType);
        fact(
          "Count interpretation",
          "Individual columns count each value; the combined count is their observed intersection",
        );
        fact(
          "Review signal",
          "Rarity does not establish that a setting is incorrect",
        );
      } else {
        const current = numeric(row.currentDays);
        const proposed = numeric(row.proposedDays);
        result.change =
          current !== null && proposed !== null
            ? number.format(current) +
              " to " +
              number.format(proposed) +
              " days"
            : "Recommendation unavailable";
        result.delta =
          current !== null && proposed !== null
            ? number.format(proposed - current)
            : "Not available";
        result.banner =
          (entity === "SupplierPlannedTimes"
            ? "Supplier planned-time recommendation: "
            : "Material planned-time recommendation: ") +
          result.change +
          ".";
        result.chart =
          current !== null && proposed !== null && current >= 0 && proposed >= 0
            ? {
                kind: "setting",
                title: "Current and proposed planned time",
                current: current,
                proposed: proposed,
                tolerance:
                  entity === "MaterialPlannedTimes"
                    ? numeric(row.tolerance)
                    : null,
              }
            : null;
        result.hasRange =
          entity === "SupplierPlannedTimes" &&
          validRange(row.rangeP10, row.rangeP50, row.rangeP90, row.rangeP80);
        result.rangeTitle =
          row.rangeSource === "empirical"
            ? "Observed delivery-time quantiles"
            : "Estimated delivery-time quantiles";
        let retained = {};
        try {
          retained =
            typeof row.detail === "string"
              ? JSON.parse(row.detail)
              : row.detail || {};
        } catch (_) {
          retained = {};
        }
        const evidenceSources =
          entity === "SupplierPlannedTimes"
            ? [
                {
                  Supplier: row.Supplier,
                  range: retained.settingRange,
                  empiricalRange: retained.range || {
                    source: retained.rangeSource,
                    n: retained.rangeCount,
                    p10: retained.rangeP10,
                    p50: retained.rangeP50,
                    p80: retained.rangeP80,
                    p90: retained.rangeP90,
                  },
                },
              ]
            : retained.settingSources || [];
        result.deliveryEvidence = evidenceSources.flatMap(function (source) {
          return [
            {
              range: source.range,
              ai: source.range?.source === "tabpfn",
              expected: "AI",
            },
            { range: source.empiricalRange, ai: false, expected: "Empirical" },
          ].map(function (entry) {
            const range = entry.range || {};
            const supported = validRange(
              range.p10,
              range.p50,
              range.p90,
              range.p80,
            );
            return {
              Supplier: source.Supplier,
              supported,
              currentDays: numeric(row.currentDays),
              ai: !!entry.ai && supported,
              source: !supported
                ? entry.expected + " unavailable"
                : entry.ai
                  ? "TabPFN"
                  : range.source === "empirical"
                    ? "Empirical"
                    : "Fallback",
              p10: supported ? range.p10 : "Not available",
              p50: supported ? range.p50 : "Not available",
              p80: supported ? range.p80 : "Not available",
              p90: supported ? range.p90 : "Not available",
              count: range.contextRows ?? range.n,
              run: range.runID ?? range.modelRunID ?? "",
            };
          });
        });
        result.hasDeliveryEvidence = result.deliveryEvidence.length > 0;
        result.proposalBasis =
          retained.proposalRule ||
          row.proposalRule ||
          "No supported rewrite proposal";
        result.modelComparison = retained.settingComparison?.value;
        fact("Recommendation basis", row.proposalRule);
        if (entity === "SupplierPlannedTimes") {
          fact("Evidence source", row.rangeSource);
          fact("12-month order value", row.value12mEUR, "EUR");
          fact("Scope", "Supplier purchasing-info-record setting");
        } else {
          fact("Orders in the last 12 months", row.orders12m);
          fact("Master-data flag", row.masterFlag);
          fact("Scope", "Material and plant master-data setting");
          fact(
            "Uncertainty",
            "This recommendation is not a probabilistic delivery-time range",
          );
        }
      }
      fact("Source revision", row.caseSourceRevision);
      fact(
        "Case updated",
        row.caseUpdatedAt ? date.format(new Date(row.caseUpdatedAt)) : null,
      );
      if (result.incomplete) {
        result.canPrepare = false;
        result.canAccept = false;
        fact(
          "Evidence completeness",
          "The retained comparison is incomplete. Reload the evidence before making a decision.",
        );
      }
      result.assessing = false;
      result.assessmentError = "";
      result.assessmentMetric = "overview";
      result.lateDays = 1;
      result.unusual = entity === "UnusualSettings";
      result.canAssess =
        row.caseStatus === "open" && !!source.sourceFingerprint && !active;
      result.assessment = null;
      try {
        const assessment = JSON.parse(row.assessmentJson || "null");
        if (assessment && Array.isArray(assessment.metrics)) {
          result.assessment = {
            ...assessment,
            generatedText: assessment.generatedAt
              ? date.format(new Date(assessment.generatedAt))
              : "",
            ai: ["tabpfn", "mixed"].includes(assessment.source),
            metrics: assessment.metrics.map(function (entry) {
              const display = function (value) {
                if (value === null || value === undefined) return "Unavailable";
                if (Array.isArray(value)) return value.map(display).join(", ");
                if (typeof value === "object")
                  return Object.entries(value)
                    .map(function (pair) {
                      return pair[0] + ": " + display(pair[1]);
                    })
                    .join("; ");
                return typeof value === "number"
                  ? number.format(value)
                  : String(value);
              };
              const detail =
                entry.detail && typeof entry.detail === "object"
                  ? entry.detail
                  : {};
              const notes = [];
              if (detail.recheck || detail.trigger)
                notes.push(
                  "Recheck required: maintained setting differs from independent model evidence.",
                );
              if (detail.peerRows !== undefined)
                notes.push("Peer records: " + display(detail.peerRows) + ".");
              if (detail.deliveries !== undefined)
                notes.push(
                  "Observed deliveries: " + display(detail.deliveries) + ".",
                );
              if (detail.contextRows !== undefined)
                notes.push(
                  "Prediction context records: " +
                    display(detail.contextRows) +
                    ".",
                );
              if (detail.asOf)
                notes.push("Imported data as of " + detail.asOf + ".");
              if (detail.probabilities)
                notes.push(
                  "Peer likelihoods: " +
                    Object.entries(detail.probabilities)
                      .sort(function (left, right) {
                        return Number(right[1]) - Number(left[1]);
                      })
                      .slice(0, 3)
                      .map(function (pair) {
                        return (
                          pair[0] +
                          " (" +
                          number.format(Number(pair[1]) * 100) +
                          "%)"
                        );
                      })
                      .join(", ") +
                    ".",
                );
              if (detail.scored !== undefined)
                notes.push(
                  "Scored orders: " +
                    display(detail.scored) +
                    "; eligible orders: " +
                    display(detail.eligible) +
                    ".",
                );
              if (detail.reason) notes.push(String(detail.reason));
              if (detail.limitation) notes.push(String(detail.limitation));
              if (detail.runID)
                notes.push("Prediction run: " + detail.runID + ".");
              const fieldKey = entry.label.split(": ").pop();
              const fieldNames = {
                MRPType: "MRP type",
                ProcurementType: "Procurement type",
                ProcurementSubType: "Procurement subtype",
                LotSizingProcedure: "Lot-sizing",
                MRPResponsible: "MRP responsible",
              };
              const probability = numeric(detail.probabilities?.[entry.value]);
              const hasConfidence =
                entry.source === "tabpfn" &&
                probability !== null &&
                probability >= 0 &&
                probability <= 1;
              const changed =
                entry.source === "tabpfn" &&
                !!fieldNames[fieldKey] &&
                entry.current !== null &&
                entry.current !== undefined &&
                entry.value !== null &&
                entry.value !== undefined &&
                String(entry.current) !== String(entry.value);
              return {
                ...entry,
                field: fieldNames[fieldKey] || entry.label,
                isPlanning: !!fieldNames[fieldKey],
                predictionState: changed ? "Information" : "None",
                comparisonText:
                  entry.source !== "tabpfn"
                    ? "No supported AI suggestion"
                    : changed
                      ? "Differs from current"
                      : entry.current === null || entry.current === undefined
                        ? "Current unavailable"
                        : "Matches current",
                hasConfidence,
                confidence: hasConfidence ? probability * 100 : 0,
                confidenceText: hasConfidence
                  ? number.format(probability * 100) + "%"
                  : "Unavailable",
                currentText: display(entry.current),
                valueText:
                  entry.unit === "probability" &&
                  typeof entry.value === "number"
                    ? number.format(entry.value * 100) + "%"
                    : display(entry.value) +
                      (entry.unit ? " " + entry.unit : ""),
                detailText:
                  typeof entry.detail === "string"
                    ? entry.detail
                    : notes.join(" "),
                ai: entry.source === "tabpfn",
                sourceText:
                  entry.source === "tabpfn"
                    ? "TabPFN"
                    : entry.source === "fallback"
                      ? "Fallback (not AI)"
                      : "Empirical",
              };
            }),
          };
        }
      } catch {
        result.assessmentError =
          "The retained assessment could not be read. Recheck before using it.";
      }
      const assessmentMetrics = result.assessment?.metrics || [];
      result.planningPredictions = assessmentMetrics.filter(function (entry) {
        return entry.isPlanning;
      });
      result.hasPlanningPredictions = result.planningPredictions.length > 0;
      result.hasTabPFNPlanning = result.planningPredictions.some(
        function (entry) {
          return entry.ai && entry.source === "tabpfn";
        },
      );
      result.latePredictions = assessmentMetrics.filter(function (entry) {
        return entry.unit === "probability";
      });
      result.hasLatePredictions = result.latePredictions.length > 0;
      result.hasTabPFNLate = result.latePredictions.some(function (entry) {
        return entry.ai && entry.source === "tabpfn";
      });
      if (result.hasLatePredictions)
        result.lateDays = result.latePredictions[0].detail?.lateDays || 1;
      if (
        entity === "SupplierPlannedTimes" ||
        entity === "MaterialPlannedTimes" ||
        entity === "UnusualSettings"
      ) {
        const deliveryMetrics = assessmentMetrics.filter(function (entry) {
          return (
            entry.unit === "days" &&
            ((entry.value &&
              typeof entry.value === "object" &&
              "p50" in entry.value) ||
              entry.label.endsWith(": delivery range"))
          );
        });
        if (deliveryMetrics.length) {
          result.deliveryEvidence = deliveryMetrics.map(function (entry) {
            const range = entry.value || {};
            const supported = validRange(
              range.p10,
              range.p50,
              range.p90,
              range.p80,
            );
            return {
              Supplier: entry.label.split(": ")[0],
              supported,
              ai: entry.ai && supported,
              source: supported ? entry.sourceText : "Unavailable",
              p10: supported ? range.p10 : "Unavailable",
              p50: supported ? range.p50 : "Unavailable",
              p80:
                supported && numeric(range.p80) !== null
                  ? range.p80
                  : "Unavailable",
              p90: supported ? range.p90 : "Unavailable",
              count:
                entry.detail?.contextRows ??
                entry.detail?.deliveries ??
                entry.detail?.n,
              run: entry.detail?.runID || "",
              detailText: entry.detailText,
              currentDays: numeric(entry.current),
            };
          });
        }
        result.hasDeliveryEvidence = !!result.deliveryEvidence?.length;
        const weighted = assessmentMetrics.find(function (entry) {
          return (
            entry.label === "Order-share weighted supplier model medians" &&
            entry.ai
          );
        });
        if (weighted) result.modelComparison = weighted.value;
        result.hasModelComparison = numeric(result.modelComparison) !== null;
        result.leadTimePrediction =
          result.deliveryEvidence?.find(function (entry) {
            return entry.ai && numeric(entry.p50) !== null;
          }) ||
          result.deliveryEvidence?.find(function (entry) {
            return numeric(entry.p50) !== null;
          });
        result.hasLeadTimePrediction = !!result.leadTimePrediction;
        result.deliveryRanges = (result.deliveryEvidence || []).filter(
          function (entry) {
            return entry.supported;
          },
        );
      }
      result.hasTabPFNDelivery = !!result.deliveryEvidence?.some(
        function (entry) {
          return entry.ai && entry.source === "TabPFN";
        },
      );
      result.hasAI =
        result.modelAI ||
        assessmentMetrics.some(function (entry) {
          return entry.ai && entry.value !== null && entry.value !== undefined;
        }) ||
        !!result.deliveryEvidence?.some(function (entry) {
          return entry.ai;
        });
      if (entity === "DuplicateMaterials") {
        result.duplicatePage = true;
        const similarities = result.lines
          .filter(function (line) {
            return !line.reference;
          })
          .map(function (line) {
            return numeric(line.similarityScore);
          })
          .filter(function (value) {
            return value !== null;
          });
        const minimumSimilarity = Math.min(...similarities);
        const maximumSimilarity = Math.max(...similarities);
        result.descriptionSimilarity = similarities.length
          ? number.format(minimumSimilarity) +
            (minimumSimilarity !== maximumSimilarity
              ? " - " + number.format(maximumSimilarity)
              : "")
          : "Unavailable";
        const fieldNames = {
          MRPType: "MRP type",
          ProcurementType: "Procurement type",
          ProcurementSubType: "Procurement subtype",
          LotSizingProcedure: "Lot-sizing",
          MRPResponsible: "MRP responsible",
        };
        const predictions = (result.assessment?.metrics || []).filter(
          function (entry) {
            return entry.source === "tabpfn";
          },
        );
        result.candidatePredictions = predictions;
        result.hasCandidatePredictions = predictions.length > 0;
        result.lines.forEach(function (line) {
          const currentPlanning = (row.currentPlanning || []).find(
            function (entry) {
              return entry.Material === line.label && entry.Plant === row.Plant;
            },
          );
          const retainedFields = result.assessment?.metrics || [];
          line.planningFields = Object.keys(fieldNames)
            .map(function (fieldKey) {
              const retained = retainedFields.find(function (entry) {
                return entry.label === line.label + ": " + fieldKey;
              });
              const current = currentPlanning
                ? currentPlanning[fieldKey]
                : retained?.current;
              return {
                label: line.label + ": " + fieldKey,
                value: null,
                valueText: "Unavailable",
                ai: false,
                sourceText: "Not assessed",
                detailText:
                  "No retained prediction is available for this field.",
                ...retained,
                current,
                currentText:
                  current === null || current === undefined || current === ""
                    ? "Unavailable"
                    : String(current),
              };
            })
            .map(function (entry) {
              const probability = numeric(
                entry.detail?.probabilities?.[entry.value],
              );
              const fieldKey = entry.label.slice(line.label.length + 2);
              const hasConfidence =
                entry.ai &&
                probability !== null &&
                probability >= 0 &&
                probability <= 1;
              const changed =
                entry.ai &&
                entry.current !== null &&
                entry.current !== undefined &&
                entry.value !== null &&
                entry.value !== undefined &&
                String(entry.current) !== String(entry.value);
              return {
                ...entry,
                fieldKey,
                field: fieldNames[fieldKey] || fieldKey,
                changed,
                predictionState: changed ? "Information" : "None",
                comparisonText: entry.ai
                  ? changed
                    ? "Differs from current"
                    : entry.current === null || entry.current === undefined
                      ? "Current unavailable"
                      : "Matches current"
                  : "No supported AI prediction",
                hasConfidence,
                confidence: hasConfidence ? probability * 100 : 0,
                confidenceText: hasConfidence
                  ? number.format(probability * 100) + "%"
                  : "Unavailable",
                support: hasConfidence
                  ? number.format(probability * 100) + "% model confidence"
                  : "Confidence unavailable",
              };
            });
          line.hasPlanningFields = line.planningFields.length > 0;
          line.changedCount = line.planningFields.filter(function (field) {
            return field.changed;
          }).length;
          line.differencesText =
            line.changedCount +
            (line.changedCount === 1
              ? " planning difference"
              : " planning differences");
          line.expanded = !line.reference && line.changedCount > 0;
          line.primaryField = line.planningFields.find(function (field) {
            return field.fieldKey === "MRPType";
          }) ||
            line.planningFields[0] || {
              field: "MRP type",
              currentText: "Unavailable",
              valueText: "Unavailable",
              ai: false,
              hasConfidence: false,
              confidence: 0,
              confidenceText: "Unavailable",
              predictionState: "None",
              comparisonText: "No supported AI prediction",
            };
          line.predictionComparisonText = line.planningFields
            .filter(function (field) {
              return field.ai;
            })
            .map(function (field) {
              return (
                field.field +
                ": " +
                field.valueText +
                " (current " +
                field.currentText +
                "; " +
                field.support +
                ")"
              );
            })
            .join("; ");
          line.similarityText =
            numeric(line.similarityScore) === null
              ? "Not yet assessed"
              : line.reference
                ? "Reference"
                : number.format(line.similarityScore) + "%";
          line.predictionText = predictions
            .filter(function (entry) {
              return entry.label.startsWith(line.label + ": ");
            })
            .map(function (entry) {
              return (
                entry.label.slice(line.label.length + 2) +
                ": " +
                entry.valueText
              );
            })
            .join("; ");
          line.hasPrediction = !!line.predictionText;
        });
      }
      return result;
    }

    function load(view, context, force) {
      const path = context?.getPath() || "";
      const entity = path.split("/")[1]?.split("(")[0];
      if (!configurations[entity]) return Promise.resolve();
      const cached = context.getObject() || {};
      const key =
        path +
        "|" +
        cached.caseSourceRevision +
        "|" +
        cached.caseAttention +
        "|" +
        cached.caseStatus;
      const previous = pages.get(view);
      if (!force && previous?.key === key) return previous.promise;
      let model = view.getModel("prevention");
      if (!model) {
        model = new JSONModel();
        model.setSizeLimit(1000);
      }
      const request = { key: key, context: context };
      pages.set(view, request);
      model.setData({
        loading: true,
        loaded: false,
        error: "",
        canPrepare: false,
        canAccept: false,
        lines: [],
        facts: [],
        events: [],
      });
      view.setModel(model, "prevention");
      const expansion =
        "header,caseActions($expand=action),caseEvents" +
        (configurations[entity].navigation
          ? "," + configurations[entity].navigation
          : "");
      const binding = context.getModel().bindContext(path, undefined, {
        $expand: expansion,
        $$groupId: "$auto",
      });
      request.promise = binding
        .requestObject()
        .then(function (row) {
          return WorkflowPending.reconcile(view.getModel("workflow"), "case:" + row.header_ID, row.header_ID).then(function () {
              if (pages.get(view) === request && !view.isDestroyed())
                model.setData(state(entity, row));
            });
        })
        .catch(function () {
          if (pages.get(view) === request && !view.isDestroyed())
            model.setData({
              loading: false,
              loaded: false,
              error:
                "The case evidence could not be loaded. Reload before making a decision.",
              canPrepare: false,
              canAccept: false,
              lines: [],
              facts: [],
              events: [],
            });
        })
        .finally(function () {
          binding.destroy();
        });
      return request.promise;
    }

    return {
      formatPrice: function (value) {
        const amount = numeric(value);
        return amount === null ? "" : priceNumber.format(amount);
      },
      state: state,
      viewOf: viewOf,
      assess: async function (event) {
        const control = event.getSource();
        const view = viewOf(control);
        const request = pages.get(view);
        const context = request?.context;
        const model = view?.getModel("prevention");
        if (
          !context ||
          !model?.getProperty("/canAssess") ||
          model.getProperty("/assessing")
        )
          return;
        model.setProperty("/assessing", true);
        model.setProperty("/busy", true);
        model.setProperty("/assessmentError", "");
        const binding = view.getModel("assessment").bindContext("/assessPrevention(...)");
        try {
          binding.setParameter("caseID", context.getProperty("header_ID") || context.getProperty("ID"));
          binding.setParameter(
            "metric",
            model.getProperty("/assessmentMetric") || "overview",
          );
          binding.setParameter(
            "lateDays",
            Number(model.getProperty("/lateDays") || 1),
          );
          binding.setParameter(
            "expectedFingerprint",
            model.getProperty("/fingerprint"),
          );
          await binding.invoke();
          const assessment = binding.getBoundContext()?.getObject();
          if (pages.get(view) === request && !view.isDestroyed()) {
            await context.requestRefresh();
            if (pages.get(view) === request) {
              await load(view, context, true);
              if (
                pages.get(view)?.context === context &&
                assessment &&
                assessment.status !== "available"
              )
                model.setProperty(
                  "/assessmentError",
                  assessment.summary ||
                    "The reassessment is unavailable. Any previous successful evidence remains retained.",
                );
            }
          }
        } catch (error) {
          if (pages.get(view) === request && !view.isDestroyed())
            model.setProperty(
              "/assessmentError",
              error.message || "Assessment unavailable. Reload and try again.",
            );
        } finally {
          binding.destroy();
          if (pages.get(view) === request && !view.isDestroyed()) {
            model.setProperty("/assessing", false);
            model.setProperty("/busy", false);
          }
        }
      },
      onContextChange: function (event) {
        const control = event.getSource();
        const view = viewOf(control);
        if (view) {
          load(view, control.getBindingContext());
          const model = view.getModel("prevention");
          if (model && control.getModel("prevention") !== model)
            control.setModel(model, "prevention");
        }
      },
      reload: function (control) {
        const view = viewOf(control);
        const context = control.getBindingContext() || view.getBindingContext();
        return context.requestRefresh().then(function () {
          return load(view, context, true);
        });
      },
      retry: function (event) {
        const control = event.getSource();
        const view = viewOf(control);
        const context = control.getBindingContext();
        return load(view, context, true);
      },
      onSearch: function (event) {
        const search =
          event.getParameter("newValue") || event.getParameter("query") || "";
        const toolbar = event.getSource().getParent();
        const table = toolbar.getParent();
        table.getBinding("items").filter(
          search
            ? [
                new Filter({
                  filters: [
                    new Filter("label", FilterOperator.Contains, search),
                    new Filter("text", FilterOperator.Contains, search),
                  ],
                  and: false,
                }),
              ]
            : [],
        );
      },
    };
  },
);
