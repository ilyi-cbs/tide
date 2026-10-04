// Compatibility shape for the v3 Finding read model. Keep all extensions in
// this file so CAP has one deterministic owner while legacy consumers remain.
using {tide.cockpit as c} from '../db';
using {tide.s4 as s4} from '../../../db/s4';
using {tide.cockpit.AtRiskDetail as AtRiskDetail} from '../atrisk/model';
using {tide.cockpit.FreetextDetail as FreetextDetail} from '../freetext/model';
using {tide.cockpit.PdtDetail as PdtDetail, tide.cockpit.MmPdtDetail as MmPdtDetail} from '../leadtimes/model';
using {
    tide.cockpit.RuleLine as RuleLine,
    tide.cockpit.OverdueDetail as OverdueDetail,
    tide.cockpit.PriceDetail as PriceDetail,
    tide.cockpit.DuplicateDetail as DuplicateDetail,
    tide.cockpit.RareDetail as RareDetail
} from '../rules/model';

extend c.Finding with {
    atRiskDetail          : Association to one AtRiskDetail
                                on atRiskDetail.finding = $self;
    freetextDetail        : Association to one FreetextDetail
                                on freetextDetail.finding = $self;
    pdtDetail             : Association to one PdtDetail
                                on pdtDetail.finding = $self;
    mmPdtDetail           : Association to one MmPdtDetail
                                on mmPdtDetail.finding = $self;
    order                 : Association to one s4.PurchaseOrder
                                on order.PurchaseOrder = $self.PurchaseOrder;
    siblings              : Association to many s4.PurchaseOrderItem
                                on  siblings.PurchaseOrder = $self.PurchaseOrder
                                and siblings.PurchaseOrderItem <> $self.PurchaseOrderItem;
    rootCause             : Association to one c.Finding
                                on  rootCause.Material = $self.Material
                                and rootCause.Supplier = $self.Supplier
                                and rootCause.Plant    = $self.Plant
                                and rootCause.list     in ('pdt', 'mm_pdt')
                                and rootCause.status   = 'open';
    materialMasterFinding : Association to one c.Finding
                                on  materialMasterFinding.Material = $self.Material
                                and materialMasterFinding.Plant    = $self.Plant
                                and materialMasterFinding.list     = 'mm_pdt'
                                and materialMasterFinding.status   = 'open';
    affectedItems         : Association to many c.Finding
                                on  (($self.list = 'pdt'
                                   and affectedItems.Material = $self.Material
                                   and affectedItems.Supplier = $self.Supplier
                                   and affectedItems.Plant    = $self.Plant)
                                   or ($self.list = 'mm_pdt'
                                   and affectedItems.Material = $self.Material
                                   and affectedItems.Plant    = $self.Plant))
                                and affectedItems.list   in ('at_risk', 'overdue', 'price')
                                and affectedItems.status = 'open';
    caseStatus            : String(30);
    caseStatusText        : String(80);
    caseStatusCriticality : Integer;
    caseStatusUpdatedAt   : Timestamp;
    ruleLines             : Association to many RuleLine
                                on ruleLines.findingID = $self.ID;
    confirmations         : Association to many c.Confirmation
                                on  confirmations.PurchaseOrder     = $self.PurchaseOrder
                                and confirmations.PurchaseOrderItem = $self.PurchaseOrderItem;
    overdueDetail         : Association to one OverdueDetail
                                on overdueDetail.finding = $self;
    priceDetail           : Association to one PriceDetail
                                on priceDetail.finding = $self;
    duplicateDetail       : Association to one DuplicateDetail
                                on duplicateDetail.finding = $self;
    rareDetail            : Association to one RareDetail
                                on rareDetail.finding = $self;
};
