sap.ui.define(
  [
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Text",
    "sap/m/Label",
    "sap/m/MessageBox",
    "sap/m/MessageStrip",
    "sap/ui/layout/form/Form",
    "sap/ui/layout/form/ColumnLayout",
    "sap/ui/layout/form/FormContainer",
    "sap/ui/layout/form/FormElement",
    "sap/ui/core/InvisibleMessage",
    "sap/ui/core/library",
    "sap/ui/core/format/NumberFormat",
    "sap/ui/core/format/DateFormat",
    "sap/base/Log",
    "sap/ui/core/Messaging",
    "tide/cockpit/ext/requisition/WorkspaceFormatters",
    "tide/cockpit/ext/shared/WorkflowPending",
  ],
  function (
    ControllerExtension,
    JSONModel,
    Fragment,
    Dialog,
    Button,
    Text,
    Label,
    MessageBox,
    MessageStrip,
    Form,
    ColumnLayout,
    FormContainer,
    FormElement,
    InvisibleMessage,
    coreLibrary,
    NumberFormat,
    DateFormat,
    Log,
    Messaging,
    Workspace,
    WorkflowPending,
  ) {
    "use strict";

    const FIELDS = [
      {
        field: "MaterialGroup",
        property: "MaterialGroup",
        label: "materialGroup",
      },
      {
        field: "PurchasingGroup",
        property: "reviewedPurchasingGroup",
        label: "purchasingGroup",
      },
      { field: "Supplier", property: "Supplier", label: "supplier" },
      {
        field: "PurchasingInfoRecord",
        property: "reviewedPurchasingInfoRecord",
        label: "infoRecord",
      },
      {
        field: "AccountAssignmentCategory",
        property: "reviewedAccountAssignmentCategory",
        label: "accountAssignment",
      },
      {
        field: "PurchasingDocumentItemCategory",
        property: "reviewedItemCategory",
        label: "itemCategory",
      },
    ];
    const emptyEvidence = () =>
      Object.fromEntries(
        FIELDS.map(({ property }) => [
          property,
          { alternatives: [], status: "unavailable" },
        ]),
      );

    return ControllerExtension.extend(
      "tide.cockpit.ext.controller.RequisitionWorkspace",
      {
        formatOrigin: function (...values) {
          return Workspace.origin.apply(this, values);
        },
        formatProvenance: function (...values) {
          return Workspace.provenance.apply(this, values);
        },
        assistanceIcon: Workspace.assistanceIcon,
        assistanceType: Workspace.assistanceType,
        assistanceEnabled: Workspace.assistanceEnabled,
        refreshSelected: Workspace.refreshSelected,
        canUse: Workspace.canUse,
        showServices: Workspace.showServices,
        override: {
          onInit: function () {
            this._workspace = new JSONModel({
              evidence: emptyEvidence(),
              origins: {},
              demo: false,
              loadFailed: false,
              selectedEvidenceProperty: null,
              selectedEvidence: null,
              predictionChoices: [],
              predictionRunning: false,
              canStartPrediction: false,
              actionBusy: false,
            });
            this._contextEpoch = 0;
            this._patchWaiters = [];
            this.base.getView().setModel(this._workspace, "workspace");
            this._contextChanged = () => this._watchContext();
            this.base.getView().attachModelContextChange(this._contextChanged);
          },
          onAfterRendering: function () {
            this._watchContext();
          },
          routing: {
            onAfterBinding: function (context) {
              this._watchContext();
              this._loadEvidence(context || this.base.getView().getBindingContext());
            },
          },
          onExit: function () {
            this._destroyed = true;
            this._contextEpoch++;
            this._loadSequence = (this._loadSequence || 0) + 1;
            this.base.getView().detachModelContextChange(this._contextChanged);
            if (this._binding) {
              this._binding.detachPatchSent(this._patchSent);
              this._binding.detachPatchCompleted(this._patchCompleted);
            }
            this._releasePatchWaiters(false);
            this._resolveEvidenceClose?.();
            this._stopPolling();
            if (this._evidencePopover) this._evidencePopover.destroy();
            if (this._predictionChooser) this._predictionChooser.destroy();
            if (this._allocationChooser) this._allocationChooser.destroy();
            if (this._dialog) this._dialog.destroy();
            this._workspace.destroy();
          },
        },

        _text: function (key, values) {
          const view = this.base.getView();
          const model = view.getModel("i18nFreetext");
          return model ? model.getResourceBundle().getText(key, values) : key;
        },
        _api: function () {
          return this.base.getExtensionAPI();
        },
        _error: function (error) {
          MessageBox.error(error.message || String(error));
        },
        _announce: function (key) {
          InvisibleMessage.getInstance().announce(
            this._text(key),
            coreLibrary.InvisibleMessageMode.Polite,
          );
        },

        _function: async function (name, context, parameters) {
          await context.requestObject();
          const binding = context
            .getModel()
            .bindContext("PurchasingDeskService." + name + "(...)", context);
          try {
            Object.entries(parameters || {}).forEach(([name, value]) =>
              binding.setParameter(name, value),
            );
            await binding.invoke(undefined, true);
            const result = binding.getBoundContext().getObject();
            return typeof result.value === "string"
              ? JSON.parse(result.value)
              : result;
          } finally {
            binding.destroy();
          }
        },

        _watchContext: function () {
          const context = this.base.getView().getBindingContext();
          if (
            context === this._context &&
            context?.getPath() === this._contextPath
          )
            return;
          if (this._binding) {
            this._binding.detachPatchSent(this._patchSent);
            this._binding.detachPatchCompleted(this._patchCompleted);
          }
          this._contextEpoch++;
          this._loadSequence = (this._loadSequence || 0) + 1;
          this._releasePatchWaiters(false);
          this._patchCount = 0;
          this._patchFailed = false;
          this._context = context;
          this._contextPath = context?.getPath();
          this._binding = context?.getBinding();
          this._patchSent = () => {
            this._patchCount = (this._patchCount || 0) + 1;
          };
          this._patchCompleted = (event) => {
            this._patchCount = Math.max(0, (this._patchCount || 0) - 1);
            if (event.getParameter("success") === false)
              this._patchFailed = true;
            if (!this._patchCount) {
              this._releasePatchWaiters(!this._patchFailed);
              if (!this._patchFailed && !this._mutationBusy)
                this._loadEvidence(context);
            }
          };
          this._binding?.attachPatchSent(this._patchSent);
          this._binding?.attachPatchCompleted(this._patchCompleted);
          this._prefillContextPath = null;
          this._stopPolling();
          this._evidencePopover?.close();
          this._predictionChooser?.close();
          this._allocationChooser?.close();
          this._dialog?.close();
          this._workspace.setData({
            evidence: emptyEvidence(),
            origins: {},
            demo: false,
            loadFailed: false,
            selectedEvidenceProperty: null,
            selectedEvidence: null,
            predictionChoices: [],
            predictionRunning: false,
            canStartPrediction: false,
            actionBusy: !!this._mutationBusy,
          });
          if (context) this._loadEvidence(context);
        },

        _isCurrent: function (context, epoch) {
          return (
            !this._destroyed &&
            this._context === context &&
            this._contextPath === context?.getPath() &&
            this._contextEpoch === epoch &&
            this.base.getView().getBindingContext() === context
          );
        },

        _releasePatchWaiters: function (success) {
          (this._patchWaiters || [])
            .splice(0)
            .forEach((resolve) => resolve(success));
        },

        _requireEvidence: async function (context, epoch) {
          if (!this._isCurrent(context, epoch))
            throw new Error(this._text("workspaceChanged"));
          if (!(await this._loadEvidence(context)))
            throw new Error(this._text("evidenceLoadFailed"));
          if (!this._isCurrent(context, epoch))
            throw new Error(this._text("workspaceChanged"));
        },

        _mutate: async function (operation) {
          if (this._mutationBusy || this._destroyed) return;
          this._mutationBusy = true;
          this._workspace.setProperty("/actionBusy", true);
          this._evidencePopover?.setBusy(true);
          this._predictionChooser?.setBusy(true);
          try {
            await operation();
          } catch (error) {
            if (!this._destroyed) this._error(error);
          } finally {
            this._mutationBusy = false;
            if (!this._destroyed) {
              this._workspace.setProperty("/actionBusy", false);
              this._evidencePopover?.setBusy(false);
              this._predictionChooser?.setBusy(false);
            }
          }
        },

        _loadEvidence: async function (context) {
          const epoch = this._contextEpoch;
          if (!context || !this._isCurrent(context, epoch)) return false;
          const sequence = (this._loadSequence = (this._loadSequence || 0) + 1);
          try {
            const requisition = context.getProperty("PurchaseRequisition");
            const item = context.getProperty("PurchaseRequisitionItem");
            if (requisition && item)
              await this._reconcileReviewSubmission("requisition:" + requisition + "/" + item);
            const data = await this._function("reviewWorkspaceV5", context);
            if (
              sequence !== this._loadSequence ||
              !this._isCurrent(context, epoch)
            )
              return false;
            this._setWorkspaceData(data);
            return true;
          } catch (error) {
            Log.error(
              "Unable to load requisition prediction evidence",
              error.message,
              "tide.cockpit.RequisitionWorkspace",
            );
            if (
              sequence === this._loadSequence &&
              this._isCurrent(context, epoch)
            ) {
              this._workspace.setProperty("/evidence", emptyEvidence());
              this._workspace.setProperty("/selectedEvidence", null);
              this._workspace.setProperty("/selectedCandidateID", null);
              this._workspace.setProperty("/canApplySelected", false);
              this._workspace.setProperty("/canStartPrediction", false);
              this._workspace.setProperty("/loadFailed", true);
            }
            return false;
          }
        },

        _setWorkspaceData: function (data) {
          if (data.schemaVersion === 5) {
            data.evidence = Object.fromEntries(
              data.fields.map((field) => {
                const stored = field.evidence;
                const alternatives = (stored.candidates || []).map(
                  (candidate) => ({
                    id: candidate.id,
                    value: candidate.value.code,
                    kind: candidate.value.kind,
                    name: candidate.value.displayName,
                    displayText: this._valueText(candidate.value),
                    score: candidate.modelScore,
                  }),
                );
                return [
                  field.property,
                  {
                    ...stored,
                    field: field.field,
                    property: field.property,
                    current: field.current,
                    capabilities: field.capabilities,
                    origin: field.origin === "manual" ? "buyer" : field.origin,
                    reviewed: field.reviewed,
                    decision: field.decision,
                    selectedName: field.current.displayName,
                    selectedText: this._valueText(field.current),
                    cleared: field.cleared,
                    alternatives,
                    invalidation: stored.staleReasons?.length
                      ? { reasons: stored.staleReasons }
                      : null,
                    explanation: {
                      summary: stored.summary || "",
                      supportingHistory: {
                        agreementText: stored.supportingHistory,
                      },
                      reliability: {
                        value: stored.historicalReliability,
                        evaluationScope: stored.evaluationScope,
                        sampleSize: stored.sampleSize,
                      },
                      calculation: stored,
                    },
                  },
                ];
              }),
            );
            data.draftUUID = data.identity.draftUUID;
            data.modifiedAt = data.identity.modifiedAt;
            data.inputHash = data.identity.inputHash;
          }
          Object.entries(data.evidence || {}).forEach(([key, evidence]) =>
            this._decorateEvidence(key, evidence),
          );
          const property = this._workspace.getProperty(
            "/selectedEvidenceProperty",
          );
          const selected = property ? data.evidence?.[property] : null;
          const candidateID = this._workspace.getProperty(
            "/selectedCandidateID",
          );
          const selectedCandidateID = selected?.alternatives.some(
            (candidate) => candidate.id === candidateID,
          )
            ? candidateID
            : null;
          this._workspace.setData({
            ...data,
            splitAllocation:
              this._workspace.getProperty("/splitAllocation") || false,
            selectedEvidenceProperty: property,
            selectedEvidence: selected,
            selectedCandidateID,
            canApplySelected:
              !!selectedCandidateID &&
              !!(
                selected?.capabilities.canApply ||
                selected?.capabilities.canEditToApply
              ),
            predictionChoices:
              this._workspace.getProperty("/predictionChoices") || [],
            predictionStage:
              this._workspace.getProperty("/predictionStage") || "targets",
            predictionReviewIdentity: this._workspace.getProperty(
              "/predictionReviewIdentity",
            ),
            predictionRunning:
              this._workspace.getProperty("/predictionRunning") || false,
            allocationStage:
              this._workspace.getProperty("/allocationStage") || "targets",
            allocationChoices:
              this._workspace.getProperty("/allocationChoices") || [],
            canRunAllocationCommand:
              this._workspace.getProperty("/canRunAllocationCommand") || false,
            actionBusy: !!this._mutationBusy,
            canStartPrediction: false,
            loadFailed: false,
          });
          const choices = this._workspace.getProperty("/predictionChoices");
          choices.forEach((choice) => {
            const evidence = data.evidence?.[choice.property];
            choice.enabled =
              this._workspace.getProperty("/predictionStage") === "targets"
                ? !!evidence?.capabilities?.canPredict
                : !!(
                    evidence?.capabilities?.canApply ||
                    evidence?.capabilities?.canEditToApply
                  ) && evidence.id === choice.evidenceID;
            if (!choice.enabled) choice.selected = false;
          });
          this._updatePredictionSelection();
        },

        _valueText: function (value) {
          if (value.kind === "missing") return this._text("notProvided");
          return value.kind === "blank" || value.code === value.displayName
            ? value.displayName
            : value.code + " (" + value.displayName + ")";
        },

        _identityParameters: function () {
          const identity = this._workspace.getProperty("/identity");
          return {
            expectedDraftUUID: identity.draftUUID,
            expectedModifiedAt: identity.modifiedAt,
            expectedInputHash: identity.inputHash,
          };
        },

        _refreshWorkingFields: async function (context) {
          await context.requestSideEffects(
            FIELDS.map(({ property }) => ({ $PropertyPath: property })).concat(
              [
                "materialGroupName",
                "purchasingGroupName",
                "supplierName",
                "modifiedAt",
                "fieldOrigins",
                "materialGroupState",
                "purchasingGroupState",
                "supplierState",
                "accountAssignmentCategoryState",
                "itemCategoryState",
                "materialState",
                "infoRecordState",
              ].map((property) => ({ $PropertyPath: property })),
            ),
          );
        },

        onFieldChange: function () {
          this._loadSequence = (this._loadSequence || 0) + 1;
          this._stopPolling();
          this._predictionChooser?.close();
          this._patchFailed = false;
          FIELDS.forEach(({ property }) => {
            const evidence = this._workspace.getProperty(
              "/evidence/" + property,
            );
            if (!evidence) return;
            this._workspace.setProperty(
              "/evidence/" + property,
              this._decorateEvidence(property, {
                ...evidence,
                status: "stale",
                capabilities: {
                  ...evidence.capabilities,
                  canApply: false,
                  canConfirm: false,
                  canPredict: false,
                },
                invalidation: { reasons: ["context_changed"] },
              }),
            );
          });
          const property = this._workspace.getProperty(
            "/selectedEvidenceProperty",
          );
          if (property)
            this._workspace.setProperty(
              "/selectedEvidence",
              this._workspace.getProperty("/evidence/" + property),
            );
          this._workspace.setProperty("/selectedCandidateID", null);
          this._workspace.setProperty("/canApplySelected", false);
          this._workspace.setProperty("/canStartPrediction", false);
        },

        onSplitAllocation: function () {
          this._workspace.setProperty("/splitAllocation", true);
        },

        _selection: function (event) {
          const control = event.getSource();
          const property =
            control.data("property") ||
            this._workspace.getProperty("/selectedEvidenceProperty");
          return {
            property,
            context: control.getBindingContext(),
            evidence: this._workspace.getProperty("/evidence/" + property),
          };
        },

        _decorateEvidence: function (property, evidence) {
          const field = FIELDS.find((entry) => entry.property === property);
          evidence.label = field ? this._text(field.label) : evidence.field;
          evidence.statusText = this._text(
            {
              pending: "suggestionPending",
              available: "suggestionReady",
              stale: "suggestionStale",
              failed: "suggestionFailed",
              canceled: "suggestionCanceled",
              unavailable:
                evidence.reason === "qualification_required"
                  ? "qualificationRequired"
                  : "suggestionUnavailable",
            }[evidence.status] || "suggestionUnavailable",
          );
          evidence.state =
            evidence.status === "pending"
              ? "Information"
              : evidence.status === "failed" || evidence.status === "stale"
                ? "Warning"
                : "None";
          evidence.hasCandidates = !!evidence.alternatives?.length;
          evidence.hasSummary = evidence.status === "available" && !!evidence.explanation?.summary;
          evidence.hasReliability = evidence.status === "available" && evidence.explanation?.reliability?.value != null;
          evidence.hasHistory = evidence.status === "available" && !!evidence.explanation?.supportingHistory?.agreementText;
          evidence.hasExplanation = evidence.hasSummary || evidence.hasReliability || evidence.hasHistory;
          evidence.hasModelMetadata = !!(evidence.backend || evidence.modelVersion || evidence.computedAt);
          evidence.failureText = this._text("predictionFailureRetry");
          evidence.hasCalculation = !!(
            evidence.backend || evidence.modelVersion || evidence.computedAt ||
            (evidence.status === "failed" && evidence.reason)
          );
          evidence.provenance = this.formatProvenance(
            evidence,
            evidence.current
              ? evidence.current.code
              : this._context?.getProperty(property),
          );
          return evidence;
        },

        _showEvidence: async function (property, source) {
          const epoch = this._contextEpoch;
          const context = this._context;
          const sequence = (this._evidenceOpenSequence =
            (this._evidenceOpenSequence || 0) + 1);
          if (!this._evidencePopover) {
            this._evidencePopoverPromise ||= Fragment.load({
              id: this.base.getView().getId(),
              name: "tide.cockpit.ext.requisition.EvidencePopover",
              controller: this.base,
            })
              .then((popover) => {
                if (this._destroyed) {
                  popover.destroy();
                  return null;
                }
                this.base.getView().addDependent(popover);
                this._evidencePopover = popover;
                return popover;
              })
              .catch((error) => {
                this._evidencePopoverPromise = null;
                throw error;
              });
            await this._evidencePopoverPromise;
          }
          if (this._evidenceClosePromise) await this._evidenceClosePromise;
          if (
            !this._isCurrent(context, epoch) ||
            source.isDestroyed() ||
            this._evidenceOpenSequence !== sequence
          )
            return;
          const evidence = this._workspace.getProperty("/evidence/" + property);
          if (!evidence) return;
          this._workspace.setProperty("/selectedEvidenceProperty", property);
          this._workspace.setProperty(
            "/selectedEvidence",
            this._decorateEvidence(property, evidence),
          );
          this._workspace.setProperty("/selectedCandidateID", null);
          this._workspace.setProperty("/canApplySelected", false);
          this._evidencePopover?.openBy(source);
        },

        onEvidenceClosing: function () {
          this._evidenceClosePromise = new Promise((resolve) => {
            this._resolveEvidenceClose = resolve;
          });
        },

        onEvidenceClosed: function () {
          const resolve = this._resolveEvidenceClose;
          this._evidenceClosePromise = null;
          this._resolveEvidenceClose = null;
          resolve?.();
          if (this._destroyed) return;
          this._workspace.setProperty("/selectedEvidenceProperty", null);
          this._workspace.setProperty("/selectedEvidence", null);
          this._workspace.setProperty("/selectedCandidateID", null);
          this._workspace.setProperty("/canApplySelected", false);
        },
        onEvidencePress: function (event) {
          this._showEvidence(
            this._selection(event).property,
            event.getSource(),
          ).catch((error) => {
            if (!this._destroyed) this._error(error);
          });
        },

        _fieldForProperty: function (property) {
          return FIELDS.find((entry) => entry.property === property)?.field;
        },

        onAccountingContextChange: function (event) {
          const container = event.getSource();
          const context = this.base.getView().getBindingContext();
          if (context && container.getBindingContext() !== context)
            container.setBindingContext(context);
        },

        _allocationDescription: function (field) {
          const reason = field.evidence?.reason || field.capabilities?.reason;
          const text = {
            accounting_master_data_missing: "accountingMasterMissing",
            controlling_area_master_missing: "controllingAreaMissing",
            company_code_required: "accountingCompanyRequired",
            account_assignment_category_not_applicable:
              "accountingCategoryNotApplicable",
            insufficient_unambiguous_history: "accountingHistoryMissing",
            allocation_removed: "allocationRemoved",
          }[reason];
          return text
            ? this._text(text)
            : reason
              ? String(reason).replaceAll("_", " ")
              : field.evidence?.status === "available"
                ? this._text("suggestionAvailable")
                : this._text("suggestionUnavailable");
        },

        _allocationChoice: function (field, stage) {
          return {
            ...field,
            label: this._text("allocationTargetLabel", [
              this._text(
                field.field === "GLAccount" ? "glAccount" : "costCenter",
              ),
              field.allocationNumber,
            ]),
            currentText: this._text("predictionCurrentValue", [
              this._valueText(field.current),
            ]),
            description: this._allocationDescription(field),
            selected: false,
            calculationText: this.formatCalculation(
              field.evidence.backend,
              field.evidence.modelVersion,
              field.evidence.computedAt,
            ),
            candidateID: field.evidence.candidates[0]?.id || "",
            enabled:
              stage === "targets"
                ? !!field.capabilities.canPredict
                : !!(
                    field.capabilities.canApply ||
                    field.capabilities.canEditToApply
                  ) && !!field.evidence.candidates.length,
          };
        },

        _openAllocationChooser: async function () {
          if (!this._allocationChooser) {
            this._allocationChooserPromise ||= Fragment.load({
              id: this.base.getView().getId(),
              name: "tide.cockpit.ext.requisition.AllocationChooser",
              controller: this.base,
            });
            this._allocationChooser = await this._allocationChooserPromise;
            this.base.getView().addDependent(this._allocationChooser);
          }
          this._allocationChooser.open();
        },

        onCloseAllocationChooser: function () {
          this._allocationChooser?.close();
        },

        onAllocationAssistance: async function (event) {
          const context = this.base.getView().getBindingContext();
          const epoch = this._contextEpoch;
          const button = event?.getSource();
          const field = button?.data("predictionField");
          const number = field
            ? button
                .getBindingContext()
                ?.getProperty("PurchaseReqnAcctAssgmtNumber")
            : null;
          await this._mutate(async () => {
            await this._waitForPendingUpdates(context, epoch);
            await this._requireEvidence(context, epoch);
            const fields = (
              this._workspace.getProperty("/allocationFields") || []
            ).filter(
              (entry) =>
                !field ||
                (entry.field === field && entry.allocationNumber === number),
            );
            const stage = fields.some(
              (entry) => entry.evidence.status === "available",
            )
              ? "results"
              : "targets";
            this._workspace.setProperty("/allocationStage", stage);
            this._workspace.setProperty(
              "/allocationChoices",
              fields.map((entry) => this._allocationChoice(entry, stage)),
            );
            this._workspace.setProperty("/canRunAllocationCommand", false);
            await this._openAllocationChooser();
          });
        },

        onAllocationChoiceChanged: function () {
          this._workspace.setProperty(
            "/canRunAllocationCommand",
            (this._workspace.getProperty("/allocationChoices") || []).some(
              (choice) =>
                choice.enabled &&
                choice.selected &&
                (this._workspace.getProperty("/allocationStage") ===
                  "targets" ||
                  !!choice.candidateID),
            ),
          );
          this._workspace.checkUpdate(true);
        },

        onAllocationStageChanged: function (event) {
          const stage = event.getParameter("key");
          this._workspace.setProperty("/allocationStage", stage);
          this._workspace.setProperty(
            "/allocationChoices",
            (this._workspace.getProperty("/allocationChoices") || []).map(
              (choice) => this._allocationChoice(choice, stage),
            ),
          );
          this._workspace.setProperty("/canRunAllocationCommand", false);
        },

        _allocationIdentityParameters: function () {
          const identity = this._workspace.getProperty("/allocationIdentity");
          return {
            expectedDraftUUID: identity.draftUUID,
            expectedModifiedAt: identity.modifiedAt,
            expectedInputHash: identity.inputHash,
          };
        },

        _enterAllocationDraft: async function (context, choices) {
          const originalIdentity = this._workspace.getProperty(
            "/allocationIdentity",
          );
          const originals = choices.map((choice) => ({
            choice,
            candidate: choice.evidence.candidates.find(
              (candidate) => candidate.id === choice.candidateID,
            ),
          }));
          if (
            originals.some(
              ({ choice, candidate }) =>
                !choice.capabilities.canEditToApply || !candidate,
            )
          )
            throw new Error(this._text("suggestionStale"));
          const edited = await this.base
            .getExtensionAPI()
            .getEditFlow()
            .editDocument(context);
          const draftContext =
            edited || this.base.getView().getBindingContext();
          if (draftContext?.getProperty("IsActiveEntity") !== false)
            throw new Error(this._text("editBeforeSelecting"));
          await this._waitForPendingUpdates(draftContext, this._contextEpoch);
          await this._requireEvidence(draftContext, this._contextEpoch);
          const identity = this._workspace.getProperty("/allocationIdentity");
          if (
            identity.inputHash !== originalIdentity.inputHash ||
            identity.sourceRevision !== originalIdentity.sourceRevision ||
            identity.sourceFingerprint !== originalIdentity.sourceFingerprint
          )
            throw new Error(this._text("suggestionStale"));
          const mapped = originals.map(({ choice, candidate }) => {
            const field = this._workspace
              .getProperty("/allocationFields")
              .find(
                (field) =>
                  field.allocationNumber === choice.allocationNumber &&
                  field.field === choice.field,
              );
            const copied = field?.evidence.candidates.find(
              (entry) =>
                entry.value.kind === candidate.value.kind &&
                entry.value.code === candidate.value.code,
            );
            if (
              !field?.capabilities.canApply ||
              field.evidence.generation !== choice.evidence.generation ||
              field.current.kind !== choice.current.kind ||
              field.current.code !== choice.current.code ||
              !copied
            )
              throw new Error(this._text("suggestionStale"));
            return { ...field, candidateID: copied.id };
          });
          return { context: draftContext, choices: mapped };
        },

        onAllocationPredictionCommand: async function () {
          let context = this.base.getView().getBindingContext();
          let epoch = this._contextEpoch;
          let choices = (
            this._workspace.getProperty("/allocationChoices") || []
          ).filter((choice) => choice.enabled && choice.selected);
          const stage = this._workspace.getProperty("/allocationStage");
          if (!choices.length) return;
          await this._mutate(async () => {
            await this._waitForPendingUpdates(context, epoch);
            await this._requireEvidence(context, epoch);
            if (stage === "targets") {
              const receipt = await this._function(
                "predictAllocationFieldsV5",
                context,
                {
                  ...this._allocationIdentityParameters(),
                  selectedTargets: choices.map(
                    ({ allocationNumber, field }) => ({
                      allocationNumber,
                      field,
                    }),
                  ),
                },
              );
              if (!this._isCurrent(context, epoch)) return;
              await context.requestSideEffects([
                { $PropertyPath: "allocationPredictionGeneration" },
                { $PropertyPath: "modifiedAt" },
              ]);
              this._allocationChooser.close();
              this._pollAllocationPrediction(context, receipt);
            } else {
              if (context.getProperty("IsActiveEntity") === true) {
                const draft = await this._enterAllocationDraft(
                  context,
                  choices,
                );
                context = draft.context;
                choices = draft.choices;
                epoch = this._contextEpoch;
              }
              await this._function("applyAllocationSelectionsV5", context, {
                ...this._allocationIdentityParameters(),
                selections: choices.map((choice) => ({
                  allocationNumber: choice.allocationNumber,
                  field: choice.field,
                  expectedValue: choice.current,
                  evidenceID: choice.evidence.id,
                  candidateID: choice.candidateID,
                })),
              });
              if (!this._isCurrent(context, epoch)) return;
              await context.requestSideEffects([
                { $NavigationPropertyPath: "reviewAccountAssignments" },
                { $PropertyPath: "modifiedAt" },
              ]);
              await this._requireEvidence(context, epoch);
              this._allocationChooser.close();
              this._announce("selectionSaved");
            }
          });
        },

        _pollAllocationPrediction: function (context, receipt) {
          this._stopPolling();
          const pollEpoch = this._pollEpoch;
          const epoch = this._contextEpoch;
          this._workspace.setProperty("/predictionRunning", true);
          const current = () =>
            this._pollEpoch === pollEpoch && this._isCurrent(context, epoch);
          const poll = async () => {
            if (!current()) return;
            if (this._mutationBusy) {
              this._predictionTimer = setTimeout(poll, 1000);
              return;
            }
            const loaded = await this._loadEvidence(context);
            if (!current()) return;
            const fields = receipt.outcomes.map((target) =>
              this._workspace
                .getProperty("/allocationFields")
                .find(
                  (field) =>
                    field.allocationNumber === target.allocationNumber &&
                    field.field === target.field,
                ),
            );
            if (
              loaded &&
              fields.every(
                (field) =>
                  field?.evidence.generation === receipt.generation &&
                  [
                    "available",
                    "unavailable",
                    "failed",
                    "stale",
                    "canceled",
                  ].includes(field.evidence.status),
              )
            ) {
              this._stopPolling();
              this._workspace.setProperty("/allocationStage", "results");
              this._workspace.setProperty(
                "/allocationChoices",
                fields.map((field) => this._allocationChoice(field, "results")),
              );
              this._workspace.setProperty("/canRunAllocationCommand", false);
              await this._openAllocationChooser();
            } else if (Date.now() >= Date.parse(receipt.deadlineAt)) {
              this._stopPolling();
              this._error(new Error(this._text("suggestionUnavailable")));
            } else this._predictionTimer = setTimeout(poll, 1000);
          };
          this._predictionTimer = setTimeout(poll, 0);
        },

        onConfirmAllocationValue: async function (event) {
          const choice = event
            .getSource()
            .getBindingContext("workspace")
            .getObject();
          const context = this.base.getView().getBindingContext();
          const epoch = this._contextEpoch;
          await this._mutate(async () => {
            await this._waitForPendingUpdates(context, epoch);
            await this._requireEvidence(context, epoch);
            await this._function("confirmAllocationValueV5", context, {
              ...this._allocationIdentityParameters(),
              allocationNumber: choice.allocationNumber,
              field: choice.field,
              expectedValue: choice.current,
            });
            await this._requireEvidence(context, epoch);
            this._allocationChooser.close();
            this._announce("valueConfirmed");
          });
        },

        _enterPredictionDraft: async function (context, selections) {
          const epoch = this._contextEpoch;
          await this._requireEvidence(context, epoch);
          const identity = this._workspace.getProperty("/identity");
          const originals = selections.map((selection) => {
            const entry = FIELDS.find(
              (entry) => entry.field === selection.field,
            );
            const evidence = this._workspace.getProperty(
              "/evidence/" + entry?.property,
            );
            const candidate = evidence?.alternatives.find(
              (candidate) => candidate.id === selection.candidateID,
            );
            if (
              !evidence?.capabilities?.canEditToApply ||
              evidence.id !== selection.evidenceID ||
              !candidate ||
              evidence.current.kind !== selection.expectedValue.kind ||
              evidence.current.code !== selection.expectedValue.code
            )
              throw new Error(this._text("suggestionStale"));
            return { entry, evidence, candidate };
          });
          const edited = await this.base
            .getExtensionAPI()
            .getEditFlow()
            .editDocument(context);
          const draftContext =
            edited || this.base.getView().getBindingContext();
          const draftEpoch = this._contextEpoch;
          if (
            !draftContext ||
            draftContext.getProperty("IsActiveEntity") !== false
          )
            throw new Error(this._text("editBeforeSelecting"));
          await this._waitForPendingUpdates(draftContext, draftEpoch);
          await this._requireEvidence(draftContext, draftEpoch);
          const draftIdentity = this._workspace.getProperty("/identity");
          if (
            identity.inputHash !== draftIdentity.inputHash ||
            identity.sourceRevision !== draftIdentity.sourceRevision ||
            identity.sourceFingerprint !== draftIdentity.sourceFingerprint
          )
            throw new Error(this._text("suggestionStale"));
          const mapped = originals.map(({ entry, evidence, candidate }) => {
            const current = this._workspace.getProperty(
              "/evidence/" + entry.property,
            );
            const copied = current?.alternatives.find(
              (alternative) =>
                alternative.kind === candidate.kind &&
                alternative.value === candidate.value,
            );
            if (
              !current?.capabilities?.canApply ||
              current.generation !== evidence.generation ||
              current.current.kind !== evidence.current.kind ||
              current.current.code !== evidence.current.code ||
              !copied
            )
              throw new Error(this._text("suggestionStale"));
            return {
              field: entry.field,
              evidenceID: current.id,
              candidateID: copied.id,
              expectedValue: current.current,
            };
          });
          return { context: draftContext, selections: mapped };
        },

        _apply: async function (context, property, candidate) {
          if (context?.getProperty("IsActiveEntity") === true) {
            const evidence = this._workspace.getProperty(
              "/evidence/" + property,
            );
            const draft = await this._enterPredictionDraft(context, [
              {
                field: this._fieldForProperty(property),
                evidenceID: evidence.id,
                candidateID: candidate.id,
                expectedValue: evidence.current,
              },
            ]);
            const copied = this._workspace
              .getProperty("/evidence/" + property)
              .alternatives.find(
                (alternative) =>
                  alternative.id === draft.selections[0].candidateID,
              );
            return this._apply(draft.context, property, copied);
          }
          const epoch = this._contextEpoch;
          if (!context || context.getProperty("IsActiveEntity") !== false)
            throw new Error(this._text("editBeforeSelecting"));
          await this._waitForPendingUpdates(context, epoch);
          await this._requireEvidence(context, epoch);
          const evidence = this._workspace.getProperty("/evidence/" + property);
          if (
            !evidence?.capabilities?.canApply ||
            !evidence.alternatives.some((entry) => entry.id === candidate.id)
          )
            throw new Error(this._text("suggestionStale"));
          if (
            evidence.current.kind !== "missing" &&
            (evidence.current.kind !== candidate.kind ||
              evidence.current.code !== candidate.value)
          ) {
            const apply = this._text("applySuggestion");
            const approved = await new Promise((resolve) =>
              MessageBox.confirm(
                this._text("replaceWorkingValue", [
                  evidence.selectedText,
                  candidate.displayText,
                ]),
                {
                  actions: [apply, MessageBox.Action.CANCEL],
                  emphasizedAction: apply,
                  onClose: (action) => resolve(action === apply),
                },
              ),
            );
            if (!approved) return;
            if (!this._isCurrent(context, epoch))
              throw new Error(this._text("workspaceChanged"));
            await this._waitForPendingUpdates(context, epoch);
          }
          await this._function("applyDraftSuggestionV5", context, {
            ...this._identityParameters(),
            field: this._fieldForProperty(property),
            evidenceID: evidence.id,
            candidateID: candidate.id,
            expectedValue: evidence.current,
          });
          if (!this._isCurrent(context, epoch)) return;
          await this._refreshWorkingFields(context);
          await this._requireEvidence(context, epoch);
          this._announce("selectionSaved");
        },

        onConfirmCurrent: async function () {
          const context = this.base.getView().getBindingContext();
          const property = this._workspace.getProperty(
            "/selectedEvidenceProperty",
          );
          if (!property) return;
          const epoch = this._contextEpoch;
          await this._mutate(async () => {
            await this._waitForPendingUpdates(context, epoch);
            await this._requireEvidence(context, epoch);
            if (
              !this._workspace.getProperty(
                "/evidence/" + property + "/capabilities/canConfirm",
              )
            )
              throw new Error(this._text("suggestionStale"));
            await this._function("confirmDraftValueV5", context, {
              ...this._identityParameters(),
              field: this._fieldForProperty(property),
              expectedValue: this._workspace.getProperty(
                "/evidence/" + property + "/current",
              ),
            });
            if (!this._isCurrent(context, epoch)) return;
            await this._refreshWorkingFields(context);
            await this._requireEvidence(context, epoch);
            this._announce("valueConfirmed");
          });
        },

        _waitForPendingUpdates: async function (
          context = this._context,
          epoch = this._contextEpoch,
        ) {
          if (!this._isCurrent(context, epoch))
            throw new Error(this._text("workspaceChanged"));
          if (context.getProperty("IsActiveEntity") !== false) {
            await context.requestObject();
            if (!this._isCurrent(context, epoch))
              throw new Error(this._text("workspaceChanged"));
            return;
          }
          const viewID = this.base.getView().getId();
          const invalid = Messaging.getMessageModel()
            .getData()
            .some(
              (message) =>
                message.getType() === "Error" &&
                (message.getTarget()?.startsWith(context.getPath()) ||
                  message.getControlIds().some((id) => id.startsWith(viewID))),
            );
          if (invalid) throw new Error(this._text("correctFieldErrors"));
          const model = context.getModel();
          const group =
            this._binding?.getUpdateGroupId() || model?.getUpdateGroupId();
          if (model?.hasPendingChanges(group) && group !== "$direct")
            await model.submitBatch(group);
          if (this._patchCount) {
            const success = await new Promise((resolve) =>
              this._patchWaiters.push(resolve),
            );
            if (!success) throw new Error(this._text("correctFieldErrors"));
          }
          if (model?.hasPendingChanges(group))
            throw new Error(this._text("correctFieldErrors"));
          if (!this._isCurrent(context, epoch))
            throw new Error(this._text("workspaceChanged"));
          this._patchFailed = false;
          await context.requestObject();
        },

        _choiceDescription: function (evidence, enabled) {
          if (enabled && evidence?.status === "failed")
            return this._text("predictionRetryAvailable");
          if (enabled)
            return evidence?.current?.kind !== "missing"
              ? this._text("predictionCurrentValue", [
                  evidence?.selectedText || this._text("notProvided"),
                ])
              : this._text("unresolvedField");
          const reason = evidence?.capabilities?.reason;
          return this._text(
            {
              qualification_required: "qualificationRequired",
              manual_material_selection: "manualMaterialSelection",
              fixed_source: "notApplicable",
              read_only: "predictionReadOnly",
            }[reason] ||
              (evidence?.status === "pending"
                ? "suggestionPending"
                : "suggestionUnavailable"),
          );
        },

        _updatePredictionSelection: function () {
          this._workspace.setProperty(
            "/canStartPrediction",
            (this._workspace.getProperty("/predictionChoices") || []).some(
              (choice) => choice.enabled && choice.selected,
            ),
          );
          this._workspace.setProperty(
            "/canAcceptPredictions",
            (this._workspace.getProperty("/predictionChoices") || []).some(
              (choice) =>
                choice.enabled && choice.selected && choice.candidateID,
            ),
          );
          this._workspace.checkUpdate(true);
        },

        _predictionChoices: function (onlyProperty) {
          const context = this.base.getView().getBindingContext();
          const choices = FIELDS.filter(
            ({ property }) => !onlyProperty || property === onlyProperty,
          ).map(({ field, property, label }) => {
            const evidence =
              this._workspace.getProperty("/evidence/" + property) || {};
            const current = evidence.current
              ? evidence.current.code
              : context?.getProperty(property);
            const enabled =
              field !== "Material" && !!evidence.capabilities?.canPredict;
            const selected =
              enabled && Workspace.refreshSelected(evidence, current);
            const description = this._choiceDescription(evidence, enabled);
            return {
              field,
              property,
              label: this._text(label),
              description,
              enabled,
              selected,
            };
          });
          if (!onlyProperty) {
            for (const [field, label] of [
              ["OutlineAgreement", "outlineAgreement"],
            ])
              choices.push({
                field,
                property: null,
                label: this._text(label),
                description: this._text("predictionNotImplemented"),
                enabled: false,
                selected: false,
              });
          }
          return choices;
        },

        _selectPredictionTargets: function (mode) {
          const choices =
            this._workspace.getProperty("/predictionChoices") || [];
          choices.forEach((choice) => {
            const evidence = this._workspace.getProperty(
              "/evidence/" + choice.property,
            );
            choice.selected =
              !!choice.enabled &&
              (mode === "missing"
                ? evidence?.current?.kind === "missing"
                : mode === "stale" && evidence?.status === "stale");
          });
          this._workspace.setProperty("/predictionChoices", choices);
          this._updatePredictionSelection();
        },
        onSelectMissingPredictions: function () {
          this._selectPredictionTargets("missing");
        },
        onSelectStalePredictions: function () {
          this._selectPredictionTargets("stale");
        },
        onClearPredictionSelection: function () {
          this._selectPredictionTargets("clear");
        },

        onRefreshSuggestions: async function () {
          const context = this.base.getView().getBindingContext();
          if (!context) return;
          const epoch = this._contextEpoch;
          await this._mutate(async () => {
            await this._waitForPendingUpdates(context, epoch);
            await this._requireEvidence(context, epoch);
            this._workspace.setProperty("/predictionStage", "targets");
            this._workspace.setProperty(
              "/predictionChoices",
              this._predictionChoices().map((choice) => ({
                ...choice,
                selected: false,
              })),
            );
            this._updatePredictionSelection();
            await this._openPredictionChooser(context, epoch);
          });
        },

        _showPredictionResults: async function (context, receipt) {
          const epoch = this._contextEpoch;
          this._workspace.setProperty("/predictionStage", "results");
          this._workspace.setProperty(
            "/predictionReviewIdentity",
            this._identityParameters(),
          );
          this._workspace.setProperty(
            "/predictionChoices",
            receipt.outcomes.map(({ field }) => {
              const entry = FIELDS.find((entry) => entry.field === field);
              const evidence = this._workspace.getProperty(
                "/evidence/" + entry.property,
              );
              const matches = evidence?.generation === receipt.generation;
              const alternatives = matches ? evidence.alternatives || [] : [];
              return {
                ...entry,
                label: this._text(entry.label),
                currentText:
                  evidence?.selectedText || this._text("notProvided"),
                expectedValue: evidence?.current,
                evidenceID: evidence?.id,
                alternatives,
                candidateID: alternatives[0]?.id || "",
                enabled:
                  matches &&
                  !!(
                    evidence.capabilities?.canApply ||
                    evidence.capabilities?.canEditToApply
                  ) &&
                  !!alternatives.length,
                selected: false,
                description: matches
                  ? evidence.statusText
                  : this._text("predictionStatusUnknown"),
              };
            }),
          );
          this._updatePredictionSelection();
          await this._openPredictionChooser(context, epoch);
        },

        _openPredictionChooser: async function (context, epoch) {
          try {
            if (!this._predictionChooser) {
              this._predictionChooserPromise ||= Fragment.load({
                id: this.base.getView().getId(),
                name: "tide.cockpit.ext.requisition.PredictionChooser",
                controller: this.base,
              })
                .then((dialog) => {
                  if (this._destroyed) {
                    dialog.destroy();
                    return null;
                  }
                  this.base.getView().addDependent(dialog);
                  this._predictionChooser = dialog;
                  return dialog;
                })
                .catch((error) => {
                  this._predictionChooserPromise = null;
                  throw error;
                });
              await this._predictionChooserPromise;
            }
            if (this._isCurrent(context, epoch))
              this._predictionChooser?.open();
          } catch (error) {
            if (!this._destroyed) this._error(error);
          }
        },

        onClosePredictionChooser: function () {
          this._predictionChooser?.close();
        },

        onPredictionChoiceChanged: function (event) {
          const checkbox = event.getSource();
          const choice = checkbox.getBindingContext("workspace")?.getObject();
          if (!choice) return;
          if (!choice.enabled) {
            checkbox.setSelected(false);
            return;
          }
          choice.selected = event.getParameter("selected");
          this._updatePredictionSelection();
        },

        onRefreshCurrent: async function () {
          const property = this._workspace.getProperty(
            "/selectedEvidenceProperty",
          );
          if (!property) return;
          await this.onStartPrediction(property);
        },

        onPredictionCandidateChanged: function () {
          this._updatePredictionSelection();
        },

        onPredictionCommand: async function () {
          if (this._workspace.getProperty("/predictionStage") === "targets") {
            const fields = (
              this._workspace.getProperty("/predictionChoices") || []
            )
              .filter((choice) => choice.enabled && choice.selected)
              .map((choice) => choice.field);
            if (!fields.length) return;
            await this.onStartPrediction(fields);
          } else {
            await this.onAcceptPredictions();
          }
        },

        onAcceptPredictions: async function () {
          let context = this.base.getView().getBindingContext();
          let epoch = this._contextEpoch;
          let identity = this._workspace.getProperty(
            "/predictionReviewIdentity",
          );
          let selections = (
            this._workspace.getProperty("/predictionChoices") || []
          )
            .filter(
              (choice) =>
                choice.enabled && choice.selected && choice.candidateID,
            )
            .map(({ field, expectedValue, evidenceID, candidateID }) => ({
              field,
              expectedValue,
              evidenceID,
              candidateID,
            }));
          if (!identity || !selections.length) return;
          await this._mutate(async () => {
            if (context?.getProperty("IsActiveEntity") === true) {
              const draft = await this._enterPredictionDraft(
                context,
                selections,
              );
              context = draft.context;
              selections = draft.selections;
              epoch = this._contextEpoch;
              identity = this._identityParameters();
            }
            await this._waitForPendingUpdates(context, epoch);
            const result = await this._function(
              "applyPredictionSelections",
              context,
              { ...identity, selections },
            );
            if (!this._isCurrent(context, epoch)) return;
            this._setWorkspaceData(result);
            await this._refreshWorkingFields(context);
            if (!this._isCurrent(context, epoch)) return;
            this._predictionChooser?.close();
            this._announce("selectionSaved");
          });
        },

        onStartPrediction: async function (onlyProperty) {
          const context = this.base.getView().getBindingContext();
          const epoch = this._contextEpoch;
          if (this._workspace.getProperty("/predictionRunning")) return;
          await this._mutate(async () => {
            await this._waitForPendingUpdates(context, epoch);
            await this._requireEvidence(context, epoch);
            const selectedFields = this._predictionChoices(
              typeof onlyProperty === "string" ? onlyProperty : null,
            )
              .filter(
                (choice) =>
                  choice.enabled &&
                  (Array.isArray(onlyProperty)
                    ? onlyProperty.includes(choice.field)
                    : typeof onlyProperty === "string"),
              )
              .map((choice) => choice.field);
            if (
              Array.isArray(onlyProperty) &&
              selectedFields.length !== new Set(onlyProperty).size
            )
              throw new Error(this._text("suggestionStale"));
            if (!selectedFields.length)
              throw new Error(this._text("suggestionUnavailable"));
            if (
              selectedFields.some(
                (field) =>
                  !this._workspace.getProperty(
                    "/evidence/" +
                      FIELDS.find((entry) => entry.field === field).property +
                      "/capabilities/canPredict",
                  ),
              )
            )
              throw new Error(this._text("suggestionStale"));
            const result = await this._function(
              "predictDraftFieldsV5",
              context,
              {
                selectedFields,
                ...this._identityParameters(),
              },
            );
            if (!this._isCurrent(context, epoch)) return;
            await context.requestSideEffects?.([
              { $PropertyPath: "predictionGeneration" },
              { $PropertyPath: "modifiedAt" },
            ]);
            if (!this._isCurrent(context, epoch)) return;
            this._predictionChooser?.close();
            this._pollPrediction(
              context,
              result.generation,
              Date.parse(result.deadlineAt),
              result,
            );
            this._announce("predictionStarted");
          });
        },

        _pollPrediction: function (context, generation, deadline, receipt) {
          this._stopPolling();
          this._workspace.setProperty("/predictionRunning", true);
          const pollEpoch = this._pollEpoch;
          const epoch = this._contextEpoch;
          const current = () =>
            this._pollEpoch === pollEpoch && this._isCurrent(context, epoch);
          const expires = Number.isFinite(deadline) ? deadline : Date.now();
          const started = Date.now();
          const poll = async () => {
            if (!current()) return;
            if (this._mutationBusy) {
              this._predictionTimer = setTimeout(poll, 1000);
              return;
            }
            const loaded = await this._loadEvidence(context);
            if (!current()) return;
            const selected = receipt.outcomes.map(({ field }) =>
              this._workspace.getProperty(
                "/evidence/" +
                  FIELDS.find((entry) => entry.field === field).property,
              ),
            );
            const complete =
              loaded &&
              selected.length > 0 &&
              selected.every(
                (evidence) =>
                  evidence?.generation === generation &&
                  evidence.status !== "pending",
              );
            if (complete || Date.now() >= expires) {
              this._stopPolling();
              this._announce(
                complete ? "suggestionsRefreshed" : "predictionStatusUnknown",
              );
              await this._showPredictionResults(context, receipt);
              return;
            }
            const delay = Date.now() - started < 5000 ? 1000 : 5000;
            this._predictionTimer = setTimeout(poll, delay);
          };
          this._predictionTimer = setTimeout(poll, 1000);
        },

        _stopPolling: function () {
          this._pollEpoch = (this._pollEpoch || 0) + 1;
          if (this._predictionTimer) clearTimeout(this._predictionTimer);
          this._predictionTimer = null;
          if (!this._destroyed)
            this._workspace?.setProperty("/predictionRunning", false);
        },

        _openDialog: function (options) {
          if (this._dialog) this._dialog.destroy();
          const dialog = new Dialog({
            ...options,
            resizable: true,
            draggable: true,
          });
          this.base.getView().addDependent(dialog);
          this._dialog = dialog;
          dialog.open();
          return dialog;
        },

        onCandidateSelected: function (event) {
          const candidate = event
            .getParameter("listItem")
            .getBindingContext("workspace")
            .getObject();
          this._workspace.setProperty("/selectedCandidateID", candidate.id);
          this._workspace.setProperty(
            "/canApplySelected",
            !!(
              this._workspace.getProperty(
                "/selectedEvidence/capabilities/canApply",
              ) ||
              this._workspace.getProperty(
                "/selectedEvidence/capabilities/canEditToApply",
              )
            ),
          );
        },

        onApplySelected: async function () {
          const candidate = this._workspace
            .getProperty("/selectedEvidence/alternatives")
            ?.find(
              (entry) =>
                entry.id ===
                this._workspace.getProperty("/selectedCandidateID"),
            );
          const context = this.base.getView().getBindingContext();
          const property = this._workspace.getProperty(
            "/selectedEvidenceProperty",
          );
          if (!candidate || !property) return;
          await this._mutate(() => this._apply(context, property, candidate));
        },

        _readOnlyForm: function (rows, title) {
          return new Form({
            editable: false,
            layout: new ColumnLayout({
              columnsM: 2,
              columnsL: 2,
              columnsXL: 2,
            }),
            formContainers: [
              new FormContainer({
                title,
                formElements: rows.map(
                  ([label, value]) =>
                    new FormElement({
                      label: new Label({ text: label }),
                      fields: [
                        new Text({ wrapping: true }).setText(
                          value === null || value === undefined || value === ""
                            ? this._text("notProvided")
                            : String(value),
                        ),
                      ],
                    }),
                ),
              }),
            ],
          });
        },

        formatScore: function (score) {
          return typeof score !== "number" || !Number.isFinite(score)
            ? this._text("notProvided")
            : this._text("modelScore", [
                score.toLocaleString(undefined, {
                  maximumSignificantDigits: 12,
                }),
              ]);
        },
        formatReliability: function (value, scope, sampleSize) {
          return value === null || value === undefined
            ? this._text("notProvided")
            : this._text("historicalReliabilityDetail", [
                Math.round(value * 100),
                scope || this._text("notProvided"),
                sampleSize || this._text("notProvided"),
              ]);
        },
        formatCalculation: function (backend, version, computedAt) {
          const providers = {
            priorlabs: "Prior Labs API",
            aicore: "SAP AI Core",
            fake: "Offline test backend",
          };
          const model = /^v3\.5(?:_|$)/.test(version || "")
            ? "TabPFN 3.5 (" + version + ")"
            : version && version !== "tabpfn"
              ? /^tabpfn/i.test(version)
                ? version.replace(/^tabpfn\s*/i, "TabPFN")
                : "TabPFN" + version
              : this._text("modelVersionUnrecorded");
          const timestamp = computedAt ? new Date(computedAt) : null;
          return this._text("calculationSource", [
            model,
            providers[backend] ||
              (backend && backend !== "tabpfn"
                ? backend
                : this._text("backendUnrecorded")),
            timestamp && Number.isFinite(timestamp.getTime())
              ? timestamp.toLocaleString()
              : this._text("notProvided"),
          ]);
        },
        formatInvalidation: function (reasons) {
          return this._text("evidenceStale", [
            Array.isArray(reasons)
              ? reasons.join(", ").replaceAll("_", " ")
              : "context changed",
          ]);
        },

        onOriginalRequest: async function () {
          const context = this.base.getView().getBindingContext();
          const epoch = this._contextEpoch;
          try {
            const data = await this._function("reviewWorkspace", context);
            if (!this._isCurrent(context, epoch)) return;
            const source = data.source;
            const number = (value) =>
              value == null
                ? value
                : NumberFormat.getFloatInstance().format(value);
            const date = (value) =>
              value
                ? DateFormat.getDateInstance(
                    { style: "medium" },
                    undefined,
                    true,
                  ).format(new Date(value), true)
                : value;
            const request = [
              [this._text("description"), source.text],
              [this._text("requestedBy"), source.RequisitionerName],
              [this._text("requestedOn"), date(source.requestedAt)],
              [
                this._text("quantity"),
                source.RequestedQuantity == null
                  ? null
                  : number(source.RequestedQuantity) +
                    " " +
                    (source.BaseUnit || ""),
              ],
              [this._text("requiredDate"), date(source.DeliveryDate)],
              [this._text("longText"), source.itemLongText],
              [this._text("headerNote"), source.headerNote],
            ];
            const purchasing = [
              [this._text("plant"), source.Plant],
              [this._text("materialGroup"), source.MaterialGroup],
              [this._text("purchasingGroup"), source.PurchasingGroup],
              [this._text("supplier"), source.Supplier],
              [this._text("organisation"), source.PurchasingOrganization],
              [this._text("companyCode"), source.CompanyCode],
              [
                this._text("itemCategory"),
                source.PurchasingDocumentItemCategory,
              ],
            ];
            const valuation = [
              [
                this._text("valuationPrice"),
                number(source.PurchaseRequisitionPrice),
              ],
              [this._text("currency"), source.PurReqnItemCurrency],
              [this._text("priceUnit"), number(source.PurReqnPriceQuantity)],
              [
                this._text("accountAssignment"),
                source.AccountAssignmentCategory,
              ],
            ];
            const allocations =
              typeof source.accountAssignments === "string"
                ? JSON.parse(source.accountAssignments || "[]")
                : source.accountAssignments || [];
            const content = [
              this._readOnlyForm(
                [
                  [
                    this._text("sourceSnapshotUpdated"),
                    source.sourceUpdatedAt
                      ? DateFormat.getDateTimeInstance({
                          style: "medium",
                        }).format(new Date(source.sourceUpdatedAt))
                      : null,
                  ],
                ],
                this._text("latestImportedRequest"),
              ),
              this._readOnlyForm(request, this._text("itemAndDelivery")),
              this._readOnlyForm(
                purchasing,
                this._text("purchasingAndClassification"),
              ),
              this._readOnlyForm(valuation, this._text("valuationAndAccount")),
              ...allocations.map((allocation, index) =>
                this._readOnlyForm(
                  [
                    [this._text("glAccount"), allocation.GLAccount],
                    [this._text("costCenter"), allocation.CostCenter],
                    [
                      this._text("distributionPercent"),
                      number(allocation.DistributionPercent),
                    ],
                  ],
                  this._text("sourceAllocation", [index + 1]),
                ),
              ),
            ];
            const dialog = this._openDialog({
              title: this._text("originalRequest"),
              contentWidth: "48rem",
              content,
              endButton: new Button({
                text: this._text("close"),
                press: () => dialog.close(),
              }),
            });
          } catch (error) {
            this._error(error);
          }
        },

        _reconcileReviewSubmission: async function (caseID) {
          const workflow = this.base.getView().getModel("workflow");
          return WorkflowPending.reconcile(workflow, "review:" + caseID, caseID);
        },

        _submitWorkflowReview: async function (caseID, summary) {
          if (this._reviewSubmissionBusy) return;
          this._reviewSubmissionBusy = true;
          try {
            const workflow = this.base.getView().getModel("workflow");
            return await WorkflowPending.execute(workflow, "review:" + caseID, caseID, "submitRequisitionReview", {
              caseID: caseID,
              expectedModifiedAt: summary.expectedModifiedAt,
              expectedReviewToken: summary.expectedReviewToken,
            });
          } finally {
            this._reviewSubmissionBusy = false;
          }
        },

        onReviewOrder: async function () {
          if (this._reviewOpening) return;
          this._reviewOpening = true;
          let context = this.base.getView().getBindingContext();
          let savedBinding;
          try {
            if (context.getProperty("IsActiveEntity") === false) {
              await this._waitForPendingUpdates(context, this._contextEpoch);
              const model = context.getModel();
              const activePath = context
                .getPath()
                .replace("IsActiveEntity=false", "IsActiveEntity=true");
              await this._api().editFlow.saveDocument(context);
              savedBinding = model.bindContext(activePath, null, {
                $$ownRequest: true,
              });
              context = savedBinding.getBoundContext();
              await context.requestObject();
            }
            if (
              !context ||
              context.getProperty("IsActiveEntity") === false ||
              context.getProperty("HasDraftEntity")
            ) {
              MessageBox.information(this._text("saveBeforeReview"));
              return;
            }
            const caseID = "requisition:" + context.getProperty("PurchaseRequisition") +
              "/" + context.getProperty("PurchaseRequisitionItem");
            if (await this._reconcileReviewSubmission(caseID)) {
              context.getModel().refresh();
              this._api().refresh();
              return;
            }
            const summary = await this._function("reviewOrder", context);
            const c = summary.completed;
            const amount =
              Number.isFinite(c.ValuationPrice) &&
              c.PriceQuantity > 0 &&
              c.Currency
                ? NumberFormat.getFloatInstance({
                    maxFractionDigits: 2,
                  }).format((c.ValuationPrice * c.Quantity) / c.PriceQuantity) +
                  " " +
                  c.Currency
                : this._text("amountUnavailable");
            const form = this._readOnlyForm(
              [
                [this._text("description"), c.ShortDescription],
                [this._text("quantity"), c.Quantity + " " + c.Unit],
                [this._text("requiredDate"), c.RequiredDate],
                [this._text("plant"), c.Plant],
                [
                  this._text("supplier"),
                  c.Supplier
                    ? c.Supplier +
                      (context.getProperty("supplierName")
                        ? " - " + context.getProperty("supplierName")
                        : "")
                    : null,
                ],
                [this._text("material"), c.Material],
                [this._text("infoRecord"), c.PurchasingInfoRecord],
                [this._text("estimatedAmount"), amount],
                [
                  this._text("accountAssignment"),
                  summary.accountAssignments.length
                    ? summary.accountAssignments
                        .map((row) =>
                          [
                            row.GLAccount,
                            row.CostCenter,
                            row.InternalOrder,
                            row.WBSElement,
                            row.MainAsset,
                          ]
                            .filter(Boolean)
                            .join(" / "),
                        )
                        .join("; ")
                    : this._text("noAccountAssignment"),
                ],
              ].filter(
                (row) =>
                  row[1] !== null && row[1] !== undefined && row[1] !== "",
              ),
            );
            const changes = (
              summary.changesFromRequest ||
              summary.decisions ||
              []
            )
              .filter(
                (change) =>
                  String(change.source ?? "") !== String(change.selected ?? ""),
              )
              .map((change) => [
                this._text(
                  FIELDS.find((target) => target.field === change.field)
                    ?.label ||
                    { GLAccount: "glAccount", CostCenter: "costCenter" }[
                      change.field
                    ] ||
                    change.field,
                ),
                (change.source ?? this._text("missingValue")) +
                  " -> " +
                  (change.selected ?? this._text("missingValue")),
              ]);
            const submit = new Button({
              text: this._text("submitForApproval"),
              type: "Emphasized",
              press: async () => {
                if (this._reviewSubmissionBusy) return;
                dialog.setBusy(true);
                try {
                  await this._submitWorkflowReview(caseID, summary);
                  dialog.close();
                  context.getModel().refresh();
                  this._api().refresh();
                  this._announce("reviewSubmitted");
                } catch (error) {
                  this._error(error);
                } finally {
                  dialog.setBusy(false);
                }
              },
            });
            const dialog = this._openDialog({
              title: this._text("reviewOrder"),
              contentWidth: "44rem",
              initialFocus: "backToEditing",
              content: [
                form,
                this._readOnlyForm(
                  changes.length
                    ? changes
                    : [
                        [
                          this._text("changesFromRequest"),
                          this._text("noChangesFromRequest"),
                        ],
                      ],
                  this._text("changesFromRequest"),
                ),
              ],
              beginButton: submit,
              endButton: new Button("backToEditing", {
                text: this._text("backToEditing"),
                press: () => dialog.close(),
              }),
            });
            if (savedBinding)
              dialog.attachAfterClose(() => savedBinding.destroy());
          } catch (error) {
            savedBinding?.destroy();
            this._error(error);
          } finally {
            this._reviewOpening = false;
          }
        },

      },
    );
  },
);
