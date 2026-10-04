// Feature "ordercontext" (Object Page additions): order context (PO header
// fields) and sibling PO items, shown on Worklist finding types (at_risk,
// overdue, price). Descriptive only — no
// shipment-status aggregation across siblings, kept simple.
using {tide.cockpit as c} from '../db';
using {tide.s4 as s4} from '../../../db/s4';
using {PurchasingDeskService} from '../../purchasing-desk-service';
using from '../kernel/kernel';

// Order context: purchasing org, payment terms, incoterms, creator/creation
// date and manual-vs-MRP origin, associated by PurchaseOrder. A root-cause
// explainer on relevant findings, not a new column set — the object page
// fragment picks the fields it needs.
//
// Sibling PO items: other items of the same PurchaseOrder, excluding the
// finding's own item. Descriptive list only; each sibling's own worklist
// status (if any) is reached via its `finding` association below (first
// open Finding of that PO+Item) — no shipment-status aggregation across
// siblings.
//
// Root-cause pointer: at_risk/overdue/price findings share
// Material+Supplier+Plant with their root-cause pdt/mm_pdt finding, if one
// is open (same precedent as legacy.cds `#SourceFinding`). Declarative join,
// no backend change: every Finding row already carries Material/Supplier/
// Plant (kernel/findings.ts complete()).
//
// Supplier comparison: mm_pdt findings are keyed by Material+Plant (no
// single Supplier — the section computes across every supplier of that
// material and plant). Any at_risk/overdue/price finding naming the same
// Material+Plant reuses the same open mm_pdt row's supplier table
// (own-history numbers per supplier, from expert.sources), reframed
// descriptively; never a supplier-vs-supplier claim.
//
extend s4.PurchaseOrderItem with {
    finding : Association to one c.Finding
                  on  finding.PurchaseOrder     = $self.PurchaseOrder
                  and finding.PurchaseOrderItem = $self.PurchaseOrderItem
                  and finding.status            = 'open';
}

extend PurchasingDeskService.Findings with columns {
    order                 : Association to one PurchasingDeskService.PurchaseOrderContext
                                on order.PurchaseOrder = $self.PurchaseOrder,
    siblings              : Association to many PurchasingDeskService.SiblingItems
                                on  siblings.PurchaseOrder = $self.PurchaseOrder
                                and siblings.PurchaseOrderItem <> $self.PurchaseOrderItem,
    rootCause             : Association to one PurchasingDeskService.Findings
                                on  rootCause.Material = $self.Material
                                and rootCause.Supplier = $self.Supplier
                                and rootCause.Plant    = $self.Plant
                                and rootCause.list     in ('pdt', 'mm_pdt')
                                and rootCause.status   = 'open',
    materialMasterFinding : Association to one PurchasingDeskService.Findings
                                on  materialMasterFinding.Material = $self.Material
                                and materialMasterFinding.Plant    = $self.Plant
                                and materialMasterFinding.list     = 'mm_pdt'
                                and materialMasterFinding.status   = 'open',
    affectedItems         : Association to many PurchasingDeskService.Findings
                                on  (($self.list = 'pdt'
                                   and affectedItems.Material = $self.Material
                                   and affectedItems.Supplier = $self.Supplier
                                   and affectedItems.Plant    = $self.Plant)
                                   or ($self.list = 'mm_pdt'
                                   and affectedItems.Material = $self.Material
                                   and affectedItems.Plant    = $self.Plant))
                                and affectedItems.list   in ('at_risk', 'overdue', 'price')
                                  and affectedItems.status = 'open'
}

@readonly
entity PurchasingDeskService.PurchaseOrderContext as
    projection on s4.PurchaseOrder {
        PurchaseOrder,
        PurchasingOrganization,
        PaymentTerms,
        IncotermsClassification,
        CreatedByUser,
        CreationDate,
        PurchasingDocumentOrigin,
        // PurchasingDocumentOrigin: 9 = MRP conversion, B/blank = manual —
        // surfaced as a root-cause explainer, human label, never the bare
        // S/4 code.
        case
            when PurchasingDocumentOrigin = '9' then 'Created by MRP'
            else 'Manually created'
        end as originText : String(30)
    };

@readonly
entity PurchasingDeskService.SiblingItems         as
    projection on s4.PurchaseOrderItem {
        *,
        finding : redirected to PurchasingDeskService.Findings
            on finding.PurchaseOrder = $self.PurchaseOrder
            and finding.PurchaseOrderItem = $self.PurchaseOrderItem
            and finding.status = 'open',
        finding.issue             as siblingIssue,
        finding.sourceText        as siblingSourceText,
        finding.impactText        as siblingImpactText,
        finding.impactCriticality as siblingImpactCriticality,
        finding.ID                as siblingFindingID
    };

// Price findings retain their PO context without exposing it on unrelated
// prevention contracts.
extend PurchasingDeskService.DeliveryRisks with columns {
    order : Association to one PurchasingDeskService.PurchaseOrderContext
                on order.PurchaseOrder = $self.PurchaseOrder
};

extend PurchasingDeskService.PriceFindings with columns {
    order : Association to one PurchasingDeskService.PurchaseOrderContext
                on order.PurchaseOrder = $self.PurchaseOrder
};
