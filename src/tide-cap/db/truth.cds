namespace tide.truth;

/* Synthetic ground truth for evaluation, demos, and tests; never shown as S/4 data.
 * The source loader populates it only for synthetic data; desk rules/models do not read it.
 */

/** truth/lead_times: the drawn lead time of every PO item. */
entity LeadTime {
  key PurchaseOrder      : String(10);
  key PurchaseOrderItem  : String(5);
      Kind               : String(20);
      Material           : String(40);
      Plant              : String(4);
      Supplier           : String(10);
      PurchaseOrderDate  : Date;
      RequestedDate      : Date;
      NeedDate           : Date;
      State              : String(20);
      TrueMedianLeadDays : Double;
      TrueLeadDays       : Double;
      ArrivalDate        : Date;
      AvailableDate      : Date;
      Disrupted          : Boolean;
      EffectivePDT       : Double;
      ForwardScheduled   : Boolean;
}

/** truth/sales_outcomes: the true delivery date of every sales order item. */
entity SalesOutcome {
  key SalesOrder            : String(10);
  key SalesOrderItem        : String(6);
      Product               : String(40);
      Plant                 : String(4);
      ThirdParty            : Boolean;
      RequestedDeliveryDate : Date;
      TrueDeliveryDate      : Date;
}

/** truth/sources: sources of supply with their role and median lead time. */
entity Source {
  key Product               : String(40);
  key Plant                 : String(4);
  key Supplier              : String(10);
      Role                  : String(20); // main | second | new
      SwitchDate            : Date;
      MedianLeadDays        : Double;
      InfoRecordPDTCategory : String(20);
      InfoRecordPDT         : Double;
}

/** truth/suppliers: supplier behaviour parameters. */
entity Supplier {
  key Supplier        : String(10);
      Scale           : Double;
      ChronicallyLate : Boolean;
      DriftFactor     : Double;
      DriftStart      : Date;
      IsIntercompany  : Boolean;
}

/** truth/freetext_codes: the true material group of free-text items. */
entity FreetextCode {
  key PurchaseOrder           : String(10);
  key PurchaseOrderItem       : String(5);
      PurchaseRequisition     : String(10);
      PurchaseRequisitionItem : String(5);
      Text                    : String(255);
      TrueMaterialGroup       : String(9);
      RequesterMaterialGroup  : String(9);
      BuyerMaterialGroup      : String(9);
      NewGroup                : Boolean;
}

/** Injected entry errors in PO items; ID is the source-file row number. */
entity InjectedSlip {
  key ID                : Integer;
      PurchaseOrder     : String(10);
      PurchaseOrderItem : String(5);
      Plant             : String(4);
      field             : String(60);
      original_value    : String(255);
      injected_value    : String(255);
      slip_type         : String(40);
}

/** Injected master-data defects; ID is the source-file row number. */
entity MasterDataDefect {
  key ID              : Integer;
      Product         : String(40);
      Plant           : String(4);
      Supplier        : String(10);
      NearDuplicateOf : String(40);
      defect          : String(40);
      object          : String(40);
      field           : String(60);
}
