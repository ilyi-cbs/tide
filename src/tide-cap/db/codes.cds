namespace tide.codes;

/* Buyer-facing S/4 code descriptions are seeded at deploy; keys retain source field values. */

aspect CodeList {
  key code : String(4)  @title: 'Code';
      text : String(60) @title: 'Description';
}

/** Confirmation control key (EKPO-BSTAE): which confirmations the supplier sends. */
@cds.autoexpose  @readonly
entity SupplierConfirmationControlKey : CodeList {}

/** Confirmation category (EKES-EBTYP): order acknowledgment, shipping notification. */
@cds.autoexpose  @readonly
entity SupplierConfirmationCategory : CodeList {}

/** MRP type (MARC-DISMM). */
@cds.autoexpose  @readonly
entity MRPType : CodeList {}

/** Procurement type (MARC-BESKZ). */
@cds.autoexpose  @readonly
entity ProcurementType : CodeList {}

/** Special procurement type (MARC-SOBSL). */
@cds.autoexpose  @readonly
entity SpecialProcurementType : CodeList {}

annotate SupplierConfirmationControlKey with @title: 'Confirmation control key' {
  code  @Common.Text: text  @Common.TextArrangement: #TextFirst;
};

annotate SupplierConfirmationCategory with @title: 'Confirmation category' {
  code  @Common.Text: text  @Common.TextArrangement: #TextFirst;
};

annotate MRPType with @title: 'MRP type' {
  code  @Common.Text: text  @Common.TextArrangement: #TextFirst;
};

annotate ProcurementType with @title: 'Procurement type' {
  code  @Common.Text: text  @Common.TextArrangement: #TextFirst;
};

annotate SpecialProcurementType with @title: 'Special procurement type' {
  code  @Common.Text: text  @Common.TextArrangement: #TextFirst;
};
