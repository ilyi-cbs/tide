namespace tide.s4;

using {tide.codes as codes} from './codes';

/* S/4 source tables for the purchasing desk; names follow OData APIs and only consumed fields are modeled.
 * The source loader populates them; services expose them read-only. DatasetInfo records provenance and as-of date.
 */

entity DatasetInfo {
  key ID                   : String(20); // always 'current'
      name                 : String;
      source               : String; // synthetic | extract
      asOf                 : Date; // Effective "today" for the dataset
      historyStart         : Date;
      containsCustomerData : Boolean not null default true;
      loadId               : String(36);
      loadedAt             : Timestamp;
      plants               : LargeString; // JSON array of loaded plants
      rowCounts            : LargeString; // JSON object table -> rows
      absentTables         : LargeString; // JSON array of tables without a file in the dataset
}

entity PurchaseOrder {
  key PurchaseOrder              : String(10);
      PurchaseOrderType          : String(4);
      PurchaseOrderDate          : Date;
      CompanyCode                : String(4);
      PurchasingOrganization     : String(4);
      PurchasingGroup            : String(3);
      Supplier                   : String(10);
      DocumentCurrency           : String(5);
      PurchasingDocumentOrigin   : String(1); // 9 = MRP conversion, B/blank = manual
      CreatedByUser              : String(12);
      CreationDate               : Date;
      PurchasingProcessingStatus : String(2);
      PaymentTerms               : String(4);
      IncotermsClassification    : String(3);
      items                      : Association to many PurchaseOrderItem
                                     on items.PurchaseOrder = $self.PurchaseOrder;
      supplier                   : Association to one Supplier
                                     on supplier.Supplier = $self.Supplier;
}

entity PurchaseOrderItem {
  key PurchaseOrder                  : String(10);
  key PurchaseOrderItem              : String(5);
      Material                       : String(40);
      MaterialGroup                  : String(9);
      MaterialType                   : String(4);
      PurchaseOrderItemText          : String(40);
      Plant                          : String(4);
      OrderQuantity                  : Double;
      PurchaseOrderQuantityUnit      : String(3);
      NetPriceAmount                 : Double;
      NetPriceQuantity               : Double;
      NetAmount                      : Double;
      DocumentCurrency               : String(5);
      PlannedDeliveryDurationInDays  : Double;
      GoodsReceiptDurationInDays     : Double;
      PurchaseOrderItemCategory      : String(1);
      AccountAssignmentCategory      : String(1);
      PurchasingInfoRecord           : String(10);
      IsCompletelyDelivered          : Boolean;
      PurchasingDocumentDeletionCode : String(1);
      IsReturnsItem                  : Boolean;
      Customer                       : String(10);
      CompanyCode                    : String(4);
      StorageLocation                : String(4);
      BaseUnit                       : String(3);
      PurchaseRequisition            : String(10);
      PurchaseRequisitionItem        : String(5);
      IsOrderAcknRqd                 : Boolean;
      SupplierConfirmationControlKey : String(4);
      GoodsReceiptIsExpected         : Boolean;
      IsFinallyInvoiced              : Boolean;
      ItemIsRejectedBySupplier       : Boolean;
      PurgItemIsBlockedForDelivery   : Boolean;
      OverdelivTolrtdLmtRatioInPct   : Double;
      UnderdelivTolrtdLmtRatioInPct  : Double;
      header                         : Association to one PurchaseOrder
                                         on header.PurchaseOrder = $self.PurchaseOrder;
      scheduleLines                  : Association to many PurchaseOrderScheduleLine
                                         on  scheduleLines.PurchaseOrder     = $self.PurchaseOrder
                                         and scheduleLines.PurchaseOrderItem = $self.PurchaseOrderItem;
      accountAssignments             : Association to many PurchaseOrderAccountAssignment
                                         on  accountAssignments.PurchaseOrder     = $self.PurchaseOrder
                                         and accountAssignments.PurchaseOrderItem = $self.PurchaseOrderItem;
}

entity PurchaseOrderScheduleLine {
  key PurchaseOrder             : String(10);
  key PurchaseOrderItem         : String(5);
  key ScheduleLine              : String(4);
      ScheduleLineDeliveryDate  : Date;
      ScheduleLineOrderQuantity : Double;
      OpenPurchaseOrderQuantity : Double;
      SchedLineStscDeliveryDate : Date; // first (statistical) delivery date
      ScheduleLineOrderDate     : Date;
      DelivDateCategory         : String(1);
      PurchaseRequisition       : String(10);
      PurchaseRequisitionItem   : String(5);
}

entity PurchaseOrderAccountAssignment {
  key PurchaseOrder           : String(10);
  key PurchaseOrderItem       : String(5);
  key AccountAssignmentNumber : String(2);
      SalesOrder              : String(10);
      SalesOrderItem          : String(6);
      CostCenter              : String(10);
      GLAccount               : String(10);
      Quantity                : Double;
      IsDeleted               : Boolean;
}

entity AccountingCompanyCode {
  key CompanyCode     : String(4);
      ControllingArea : String(4);
}

entity GLAccountCompany {
  key CompanyCode         : String(4);
  key GLAccount           : String(10);
      GLAccountName       : String(120);
      IsBlockedForPosting : Boolean;
}

entity AccountingCostCenter {
  key ControllingArea     : String(4);
  key CostCenter          : String(10);
  key ValidityEndDate     : Date;
      CompanyCode         : String(4);
      ValidityStartDate   : Date;
      CostCenterName      : String(120);
      IsBlockedForPosting : Boolean;
}

/** Header and item of material documents, flattened (posting date on the item). */
entity MaterialDocumentItem {
  key MaterialDocumentYear       : String(4);
  key MaterialDocument           : String(10);
  key MaterialDocumentItem       : String(4);
      PostingDate                : Date;
      GoodsMovementType          : String(3);
      GoodsMovementIsCancelled   : Boolean;
      PurchaseOrder              : String(10);
      PurchaseOrderItem          : String(5);
      Material                   : String(40);
      Plant                      : String(4);
      QuantityInEntryUnit        : Double;
      QuantityInBaseUnit         : Double;
      DebitCreditCode            : String(1);
      SalesOrder                 : String(10);
      SalesOrderItem             : String(6);
      StorageLocation            : String(4);
      InventoryStockType         : String(2);
      InventorySpecialStockType  : String(1);
      Supplier                   : String(10);
      ManufacturingOrder         : String(12);
      Reservation                : String(10);
      ReservationItem            : String(4);
      ReservationIsFinallyIssued : Boolean;
      AccountAssignmentCategory  : String(1);
      CostCenter                 : String(10);
      EntryUnit                  : String(3);
      MaterialBaseUnit           : String(3);
      IsCompletelyDelivered      : Boolean;
      // from the header
      DocumentDate               : Date;
      ReferenceDocument          : String(16); // inbound delivery for 107/109
      CreatedByUser              : String(12);
      CreationTime               : String(20);
}

entity SalesOrder {
  key SalesOrder            : String(10);
      SalesOrderType        : String(4);
      SoldToParty           : String(10);
      SalesOrganization     : String(4);
      SalesOrderDate        : Date;
      RequestedDeliveryDate : Date;
      TransactionCurrency   : String(5);
      DistributionChannel   : String(2);
      OrganizationDivision  : String(2);
      TotalNetAmount        : Double;
      items                 : Association to many SalesOrderItem
                                on items.SalesOrder = $self.SalesOrder;
      customer              : Association to one Customer
                                on customer.Customer = $self.SoldToParty;
}

entity SalesOrderItem {
  key SalesOrder                  : String(10);
  key SalesOrderItem              : String(6);
      Product                     : String(40);
      Plant                       : String(4);
      RequestedDeliveryDate       : Date;
      ConfirmedDeliveryDate       : Date;
      RequestedQuantity           : Double;
      ConfdDelivQtyInOrderQtyUnit : Double;
      NetAmount                   : Double;
      TransactionCurrency         : String(5);
      DeliveryStatus              : String(1);
      SalesOrderItemCategory      : String(4);
      RequestedQuantitySAPUnit    : String(3);
      productionOrders            : Association to many ProductionOrder
                                      on  productionOrders.SalesOrder     = $self.SalesOrder
                                      and productionOrders.SalesOrderItem = $self.SalesOrderItem;
      header                      : Association to one SalesOrder
                                      on header.SalesOrder = $self.SalesOrder;
}

/** Customer; CustomerName falls back to the business partner's name. */
entity Customer {
  key Customer             : String(10);
      CustomerName         : String(80);
      CustomerFullName     : String(220);
      CustomerAccountGroup : String(4);
      DeletionIndicator    : Boolean;
}

/** Supplier; SupplierName falls back to the business partner's name, Country from its address. */
entity Supplier {
  key Supplier               : String(10);
      SupplierName           : String(80);
      Country                : String(3);
      SupplierFullName       : String(220);
      SupplierAccountGroup   : String(4);
      SupplierCorporateGroup : String(10);
      PurchasingIsBlocked    : Boolean;
      DeletionIndicator      : Boolean;
      purchasingOrgs         : Association to many SupplierPurchasingOrg
                                 on purchasingOrgs.Supplier = $self.Supplier;
}

entity Product {
  key Product             : String(40);
      ProductType         : String(4);
      ProductGroup        : String(9);
      BaseUnit            : String(3);
      CreationDate        : Date;
      CreatedByUser       : String(12);
      IsMarkedForDeletion : Boolean;
      ItemCategoryGroup   : String(4);
      Division            : String(2);
      IndustrySector      : String(1);
      plants              : Association to many ProductPlant
                              on plants.Product = $self.Product;
      description         : Association to one ProductDescription
                              on  description.Product  = $self.Product
                              and description.Language = 'EN';
}

entity ProductDescription {
  key Product            : String(40);
  key Language           : String(2);
      ProductDescription : String(40);
}

entity ProductPlantSupplyPlanning {
  key Product                        : String(40);
  key Plant                          : String(4);
      MRPType                        : String(2);
      MRPResponsible                 : String(3);
      ProcurementType                : String(1);
      ProcurementSubType             : String(2);
      LotSizingProcedure             : String(2);
      PlannedDeliveryDurationInDays  : Double;
      GoodsReceiptDuration           : Double;
      SafetyStockQuantity            : Double;
      PlanningStrategyGroup          : String(2);
      SafetySupplyDurationInDays     : Double;
      ReorderThresholdQuantity       : Double;
      AvailabilityCheckType          : String(2);
      ProdInhProdnDurationInWorkDays : Double;
      BaseUnit                       : String(3);
      Currency                       : String(5);
}

entity ProductPlantProcurement {
  key Product                     : String(40);
  key Plant                       : String(4);
      PurchasingGroup             : String(3);
      IsAutoPurOrdCreationAllowed : Boolean;
      IsSourceListRequired        : Boolean;
}

/** Info record conditions per purchasing organisation and plant (source of supply). */
entity PurgInfoRecdOrgPlantData {
  key PurchasingInfoRecord           : String(10);
  key PurchasingInfoRecordCategory   : String(1);
  key PurchasingOrganization         : String(4);
  key Plant                          : String(4);
      Material                       : String(40);
      Supplier                       : String(10);
      MaterialGroup                  : String(9);
      PurchasingGroup                : String(3);
      MaterialPlannedDeliveryDurn    : Double;
      NetPriceAmount                 : Double;
      MaterialPriceUnitQty           : Double;
      Currency                       : String(5);
      IsMarkedForDeletion            : Boolean;
      PurchasingDocumentDate         : Date;
      CreatedByUser                  : String(12);
      PurgDocOrderQuantityUnit       : String(3);
      PurchaseOrderPriceUnit         : String(3);
      PriceValidityEndDate           : Date;
      IsOrderAcknRqd                 : Boolean;
      SupplierConfirmationControlKey : String(4);
      InvoiceIsGoodsReceiptBased     : Boolean;
      UnlimitedOverdeliveryIsAllowed : Boolean;
      IsRelevantForAutomSrcg         : String(1);
}

/** Rates to EUR: 1 SourceCurrency = ExchangeRate EUR. */
entity ExchangeRate {
  key SourceCurrency : String(5);
      ExchangeRate   : Double;
}

/** Business partner: the name behind a supplier or customer number. */
entity BusinessPartner {
  key BusinessPartner          : String(10);
      Customer                 : String(10);
      Supplier                 : String(10);
      BusinessPartnerCategory  : String(1);
      BusinessPartnerGrouping  : String(4);
      BusinessPartnerFullName  : String(81);
      BusinessPartnerName      : String(81);
      OrganizationBPName1      : String(40);
      SearchTerm1              : String(20);
      Language                 : String(2);
      CreationDate             : Date;
      BusinessPartnerIsBlocked : Boolean;
      IsMarkedForArchiving     : Boolean;
}

entity BusinessPartnerAddress {
  key BusinessPartner   : String(10);
  key AddressID         : String(10);
      CityName          : String(40);
      Country           : String(3);
      Language          : String(2);
      ValidityStartDate : Date;
      ValidityEndDate   : Date;
}

entity CustomerSalesArea {
  key Customer                  : String(10);
  key SalesOrganization         : String(4);
  key DistributionChannel       : String(2);
  key Division                  : String(2);
      Currency                  : String(5);
      CustomerPaymentTerms      : String(4);
      CustomerABCClassification : String(2);
      IncotermsClassification   : String(3);
      ShippingCondition         : String(2);
      CompleteDeliveryIsDefined : Boolean;
      DeletionIndicator         : Boolean;
}

entity SupplierCompany {
  key Supplier                    : String(10);
  key CompanyCode                 : String(4);
      PaymentTerms                : String(4);
      Currency                    : String(5);
      ReconciliationAccount       : String(10);
      SupplierIsBlockedForPosting : Boolean;
      DeletionIndicator           : Boolean;
}

/** Supplier defaults per purchasing organisation (confirmation expected, planned delivery time). */
entity SupplierPurchasingOrg {
  key Supplier                       : String(10);
  key PurchasingOrganization         : String(4);
      IsOrderAcknRqd                 : Boolean;
      SupplierConfirmationControlKey : String(4);
      MaterialPlannedDeliveryDurn    : Double;
      PurchaseOrderCurrency          : String(5);
      PaymentTerms                   : String(4);
      IncotermsClassification        : String(3);
      InvoiceIsGoodsReceiptBased     : Boolean;
      PurOrdAutoGenerationIsAllowed  : Boolean;
      PurchasingIsBlockedForSupplier : Boolean;
      SupplierIsReturnsSupplier      : Boolean;
      DeletionIndicator              : Boolean;
}

entity ProductPlant {
  key Product                   : String(40);
  key Plant                     : String(4);
      ProfitCenter              : String(10);
      IsMarkedForDeletion       : Boolean;
      IsBatchManagementRequired : Boolean;
      IsNegativeStockAllowed    : Boolean;
      ProductIsCriticalPrt      : Boolean;
      GoodsIssueUnit            : String(3);
      BaseUnit                  : String(3);
}

/** MRP data per MRP area (the plant's own area has MRPArea = Plant). */
entity ProductPlantMRP {
  key Product                       : String(40);
  key Plant                         : String(4);
  key MRPArea                       : String(10);
      MRPType                       : String(2);
      MRPResponsible                : String(3);
      LotSizingProcedure            : String(2);
      SafetyStockQuantity           : Double;
      ReorderThresholdQuantity      : Double;
      SafetySupplyDurationInDays    : Double;
      PlannedDeliveryDurationInDays : Double;
      IsPlannedDeliveryTime         : Boolean;
      ProductSafetyTimeMRPRelevance : String(1);
      IsMarkedForDeletion           : Boolean;
      BaseUnit                      : String(3);
      Currency                      : String(5);
}

entity ProductValuation {
  key Product                     : String(40);
  key ValuationArea               : String(4); // = plant
  key ValuationType               : String(10);
      ValuationClass              : String(4);
      PriceDeterminationControl   : String(1);
      InventoryValuationProcedure : String(1); // S standard, V moving average
      StandardPrice               : Double;
      MovingAveragePrice          : Double;
      ProductPriceUnitQuantity    : Double;
      Currency                    : String(5);
      BaseUnit                    : String(3);
      IsProducedInhouse           : Boolean;
      IsMarkedForDeletion         : Boolean;
}

/** Material group texts from API_PRODUCTGROUP_SRV. */
entity ProductGroupText {
  key ProductGroup     : String(9);
  key Language         : String(2);
      ProductGroupName : String(20);
      ProductGroupText : String(60);
}

entity PurchasingInfoRecord {
  key PurchasingInfoRecord     : String(10);
      Supplier                 : String(10);
      Material                 : String(40);
      MaterialGroup            : String(9);
      CreationDate             : Date;
      IsDeleted                : Boolean;
      PurgDocOrderQuantityUnit : String(3);
      BaseUnit                 : String(3);
      IsRegularSupplier        : Boolean;
}

entity InbDeliveryHeader {
  key DeliveryDocument           : String(10);
      DeliveryDocumentType       : String(4);
      DeliveryDocumentBySupplier : String(35);
      Supplier                   : String(10);
      ReceivingPlant             : String(4);
      DeliveryDate               : Date;
      ActualGoodsMovementDate    : Date;
      DocumentDate               : Date;
      CreationDate               : Date;
      CreationTime               : String(20);
      CreatedByUser              : String(12);
      OverallGoodsMovementStatus : String(1);
      OverallSDProcessStatus     : String(1);
      items                      : Association to many InbDeliveryItem
                                     on items.DeliveryDocument = $self.DeliveryDocument;
}

/** Inbound delivery item; ReferenceSDDocument/Item is the PO item (item without leading zeros). */
entity InbDeliveryItem {
  key DeliveryDocument             : String(10);
  key DeliveryDocumentItem         : String(6);
      DeliveryDocumentItemCategory : String(4);
      Material                     : String(40);
      Plant                        : String(4);
      StorageLocation              : String(4);
      ActualDeliveryQuantity       : Double;
      ActualDeliveredQtyInBaseUnit : Double;
      OriginalDeliveryQuantity     : Double;
      DeliveryQuantityUnit         : String(3);
      BaseUnit                     : String(3);
      ReferenceSDDocument          : String(10);
      ReferenceSDDocumentItem      : String(6);
      ReferenceSDDocumentCategory  : String(4);
      GoodsMovementStatus          : String(1);
      GoodsMovementType            : String(3);
      CreationDate                 : Date;
      header                       : Association to one InbDeliveryHeader
                                       on header.DeliveryDocument = $self.DeliveryDocument;
}

/** Document flow PO item (preceding, item without leading zeros) -> inbound delivery item. */
entity InbDeliveryDocFlow {
  key PrecedingDocument          : String(10);
  key PrecedingDocumentItem      : String(6);
  key SubsequentDocument         : String(10);
  key SubsequentDocumentItem     : String(6);
      PrecedingDocumentCategory  : String(4);
      SubsequentDocumentCategory : String(4);
      QuantityInBaseUnit         : Double;
}

/** Stock per stock segment (API_MATERIAL_STOCK_SRV); InventoryStockType 01 = unrestricted. */
entity MatlStkInAcctMod {
  key Material                     : String(40);
  key Plant                        : String(4);
  key StorageLocation              : String(4);
  key Batch                        : String(10);
  key Supplier                     : String(10);
  key Customer                     : String(10);
  key WBSElementInternalID         : String(24);
  key SDDocument                   : String(10);
  key SDDocumentItem               : String(6);
  key InventorySpecialStockType    : String(1);
  key InventoryStockType           : String(2);
      WBSElementExternalID         : String(24);
      MaterialBaseUnit             : String(3);
      MatlWrhsStkQtyInMatlBaseUnit : Double;
}

entity ProductionOrder {
  key ManufacturingOrder         : String(12);
      ManufacturingOrderType     : String(4);
      Material                   : String(40);
      ProductionPlant            : String(4);
      TotalQuantity              : Double;
      ProductionUnit             : String(3);
      MfgOrderPlannedStartDate   : Date;
      MfgOrderPlannedEndDate     : Date;
      MfgOrderScheduledStartDate : Date;
      MfgOrderScheduledEndDate   : Date;
      OrderIsCreated             : String(1);
      OrderIsReleased            : String(1);
      SalesOrder                 : String(10);
      SalesOrderItem             : String(6);
      components                 : Association to many ProductionOrderComponent
                                     on components.ManufacturingOrder = $self.ManufacturingOrder;
}

/** Component (reservation item) of a production order: requirement date and quantity. */
entity ProductionOrderComponent {
  key Reservation               : String(10);
  key ReservationItem           : String(4);
      ManufacturingOrder        : String(12);
      Material                  : String(40);
      Plant                     : String(4);
      StorageLocation           : String(4);
      MatlCompRequirementDate   : Date;
      RequiredQuantity          : Double;
      WithdrawnQuantity         : Double;
      BaseUnit                  : String(3);
      InventorySpecialStockType : String(1); // E denotes make-to-order stock
      order                     : Association to one ProductionOrder
                                    on order.ManufacturingOrder = $self.ManufacturingOrder;
}

entity MaterialBOM {
  key BillOfMaterial              : String(8);
  key BillOfMaterialCategory      : String(1);
  key BillOfMaterialVariant       : String(2);
  key BillOfMaterialVersion       : String(4);
  key Material                    : String(40);
  key Plant                       : String(4);
      BillOfMaterialVariantUsage  : String(1);
      BOMHeaderBaseUnit           : String(3);
      BOMHeaderQuantityInBaseUnit : Double;
      ValidityStartDate           : Date;
}

entity MaterialBOMItem {
  key BillOfMaterial               : String(8);
  key BillOfMaterialCategory       : String(1);
  key BillOfMaterialVariant        : String(2);
  key BillOfMaterialVersion        : String(4);
  key BillOfMaterialItemNodeNumber : String(8);
  key Material                     : String(40);
  key Plant                        : String(4);
      BillOfMaterialItemNumber     : String(4);
      BillOfMaterialItemCategory   : String(1);
      BillOfMaterialComponent      : String(40);
      BillOfMaterialItemQuantity   : Double;
      BillOfMaterialItemUnit       : String(3);
      ValidityStartDate            : Date;
}

entity PurchaseReqn {
  key PurchaseRequisition     : String(10);
      PurchaseRequisitionType : String(4);
      PurReqnDescription      : String(40);
      texts                   : Association to many PurchaseReqnText
                                  on texts.PurchaseRequisition = $self.PurchaseRequisition;
      items                   : Association to many PurchaseReqnItem
                                  on items.PurchaseRequisition = $self.PurchaseRequisition;
}

/** Requisition item; PurchasingDocument/Item is the PO item it was converted into. */
entity PurchaseReqnItem {
  key PurchaseRequisition            : String(10);
  key PurchaseRequisitionItem        : String(5);
      PurchaseRequisitionItemText    : String(40);
      PurchasingDocumentItemCategory : String(1);
      AccountAssignmentCategory      : String(1);
      Material                       : String(40);
      MaterialGroup                  : String(9);
      Plant                          : String(4);
      StorageLocation                : String(4);
      CompanyCode                    : String(4);
      PurchasingOrganization         : String(4);
      PurchasingGroup                : String(3);
      MRPController                  : String(3);
      RequestedQuantity              : Double;
      OrderedQuantity                : Double;
      BaseUnit                       : String(3);
      PurchaseRequisitionPrice       : Double;
      PurReqnPriceQuantity           : Double;
      ItemNetAmount                  : Double;
      PurReqnItemCurrency            : String(5);
      DeliveryDate                   : Date;
      PurReqCreationDate             : Date;
      PurchaseRequisitionReleaseDate : Date;
      MaterialPlannedDeliveryDurn    : Double;
      MaterialGoodsReceiptDuration   : Double;
      Supplier                       : String(10);
      FixedSupplier                  : String(10);
      SourceOfSupplyIsAssigned       : Boolean;
      PurReqnOrigin                  : String(1);
      PurReqnReleaseStatus           : String(2);
      ProcessingStatus               : String(2);
      IsDeleted                      : Boolean;
      IsClosed                       : Boolean;
      PurchaseRequisitionIsFixed     : Boolean;
      PurchasingDocument             : String(10);
      PurchasingDocumentItem         : String(5);
      CreatedByUser                  : String(12);
      RequisitionerName              : String(80);
      PurchasingInfoRecord           : String(10);
      OutlineAgreement               : String(10);
      OutlineAgreementItem           : String(5);
      RequirementTracking            : String(10);
      TaxCode                        : String(2);
      GoodsReceiptIsExpected         : Boolean;
      InvoiceIsGoodsReceiptBased     : Boolean;
      IsEvaluatedRcptSettlmtAllowed  : Boolean;
      ServicePerformer               : String(80);
      PerformancePeriodStartDate     : Date;
      PerformancePeriodEndDate       : Date;
      ExpectedOverallLimitAmount     : Double;
      OverallLimitAmount             : Double;
      header                         : Association to one PurchaseReqn
                                         on header.PurchaseRequisition = $self.PurchaseRequisition;
}

/** Imported text preserves paragraphs and may not have been typed manually by the requester. */
entity PurchaseReqnText {
  key PurchaseRequisition : String(10);
  key TextType            : String(4);
  key Language            : String(2);
      Text                : LargeString;
}

entity PurchaseReqnItemText {
  key PurchaseRequisition     : String(10);
  key PurchaseRequisitionItem : String(5);
  key TextType                : String(4);
  key Language                : String(2);
      Text                    : LargeString;
}

entity PurchaseReqnDelivAddress {
  key PurchaseRequisition     : String(10);
  key PurchaseRequisitionItem : String(5);
      Name                    : String(80);
      Street                  : String(120);
      HouseNumber             : String(20);
      City                    : String(40);
      PostalCode              : String(10);
      Country                 : String(3);
      UnloadingPoint          : String(25);
}

entity PurchaseReqnAcctAssgmt {
  key PurchaseRequisition          : String(10);
  key PurchaseRequisitionItem      : String(5);
  key PurchaseReqnAcctAssgmtNumber : String(2);
      CostCenter                   : String(10);
      GLAccount                    : String(10);
      SalesOrder                   : String(10);
      SalesOrderItem               : String(6);
      MasterFixedAsset             : String(12);
      FixedAsset                   : String(4);
      OrderID                      : String(12);
      WBSElement                   : String(24);
      BaseUnit                     : String(3);
      Quantity                     : Double;
      DistributionPercent          : Double;
      PurReqnItemCurrency          : String(5);
      PurReqnNetAmount             : Double;
      IsDeleted                    : Boolean;
}

/** Supplier confirmation (order acknowledgment, CE_SUPPLIERCONFIRMATION_0001 Confirmation; v4). */
entity SupplierConfirmation {
  key SupplierConfirmation       : String(10);
      SuplrConfRefPurchaseOrder  : String(10);
      SuplrConfProcessingStatus  : String(2);
      SuplrConfExternalReference : String(70);
      CreationDate               : Date;
}

/** ConfirmationItem; SuplrConfRefPurchaseOrder/Item is the PO item (item without leading zeros). */
entity SupplierConfirmationItem {
  key SupplierConfirmation          : String(10);
  key SupplierConfirmationItem      : String(5);
      SuplrConfRefPurchaseOrder     : String(10);
      SuplrConfRefPurchaseOrderItem : String(5);
      SupplierConfirmedNetPrice     : Double;
      DocumentCurrency              : String(5);
      ItemIsRejectedBySupplier      : Boolean;
      lines                         : Association to many SupplierConfirmationLine
                                        on  lines.SupplierConfirmation     = $self.SupplierConfirmation
                                        and lines.SupplierConfirmationItem = $self.SupplierConfirmationItem;
}

/** ConfirmationLine: confirmed date and quantity. */
entity SupplierConfirmationLine {
  key SupplierConfirmation      : String(10);
  key SupplierConfirmationItem  : String(5);
  key SupplierConfirmationLine  : String(4);
      DeliveryDate              : Date;
      DelivDateCategory         : String(1);
      ConfirmedQuantity         : Double;
      PurchaseOrderQuantityUnit : String(3);
}

/** Planned order (OP_PLANNEDORDER_0001 PlannedOrderHeader; v4). */
entity PlannedOrder {
  key PlannedOrder                : String(10);
      PlannedOrderType            : String(4);
      Material                    : String(40);
      MaterialName                : String(40);
      MRPPlant                    : String(4);
      ProductionPlant             : String(4);
      MRPArea                     : String(10);
      MaterialProcurementCategory : String(1); // E in-house, F external
      MaterialProcurementType     : String(1);
      TotalQuantity               : Double;
      BaseUnit                    : String(3);
      PlndOrderPlannedStartDate   : Date;
      PlndOrderPlannedEndDate     : Date;
      PlannedOrderOpeningDate     : Date;
      SalesOrder                  : String(10);
      SalesOrderItem              : String(6);
      MRPController               : String(3);
      PurchasingGroup             : String(3);
      PurchasingOrganization      : String(4);
      FixedSupplier               : String(10);
      SupplierName                : String(80);
      PlannedOrderIsFirm          : Boolean;
      PlannedOrderIsConvertible   : Boolean;
      components                  : Association to many PlannedOrderComponent
                                      on components.PlannedOrder = $self.PlannedOrder;
}

entity PlannedOrderComponent {
  key PlannedOrder            : String(10);
  key Reservation             : String(10);
  key ReservationItem         : String(4);
      Material                : String(40);
      Plant                   : String(4);
      StorageLocation         : String(4);
      MatlCompRequirementDate : Date;
      RequiredQuantity        : Double;
      WithdrawnQuantity       : Double;
      BaseUnit                : String(3);
      BOMItemDescription      : String(40);
}

/** Planned independent requirement from API_PLND_INDEP_RQMT_SRV. */
entity PlannedIndepRqmt {
  key Product               : String(40);
  key Plant                 : String(4);
  key MRPArea               : String(10);
  key PlngIndepRqmtType     : String(4);
  key PlngIndepRqmtVersion  : String(2);
  key RequirementPlan       : String(10);
  key RequirementSegment    : String(40);
      PlngIndepRqmtIsActive : Boolean;
}

entity PlannedIndepRqmtItem {
  key Product              : String(40);
  key Plant                : String(4);
  key MRPArea              : String(10);
  key PlngIndepRqmtType    : String(4);
  key PlngIndepRqmtVersion : String(2);
  key RequirementPlan      : String(10);
  key RequirementSegment   : String(40);
  key PlngIndepRqmtPeriod  : String(8);
  key PeriodType           : String(1);
      WorkingDayDate       : Date;
      PlannedQuantity      : Double;
      WithdrawalQuantity   : Double;
      UnitOfMeasure        : String(3);
}

entity Plant {
  key Plant       : String(4);
      PlantName   : String(30);
      CompanyCode : String(4);
      Country     : String(3);
      Language    : String(2);
}

entity CompanyCode {
  key CompanyCode     : String(4);
      CompanyCodeName : String(25);
      Country         : String(3);
      Currency        : String(5);
}

entity PurchasingOrganization {
  key PurchasingOrganization     : String(4);
      PurchasingOrganizationName : String(20);
      CompanyCode                : String(4);
}

entity PurchasingGroup {
  key PurchasingGroup     : String(3);
      PurchasingGroupName : String(18);
      PhoneNumber         : String(30);
      EmailAddress        : String(241);
}

entity StorageLocation {
  key Plant               : String(4);
  key StorageLocation     : String(4);
      StorageLocationName : String(16);
}

entity MRPController {
  key Plant             : String(4);
  key MRPController     : String(3);
      MRPControllerName : String(18);
      PurchasingGroup   : String(3);
}

entity SalesOrganization {
  key SalesOrganization     : String(4);
      SalesOrganizationName : String(20);
      CompanyCode           : String(4);
}

annotate Plant with @title: 'Plant' {
  Plant     @title: 'Plant'  @Common.Text: PlantName  @Common.TextArrangement: #TextFirst;
  PlantName @title        : 'Plant name';
};

annotate PurchasingGroup with @title: 'Purchasing group' {
  PurchasingGroup     @title: 'Purchasing group'  @Common.Text: PurchasingGroupName  @Common.TextArrangement: #TextFirst;
  PurchasingGroupName @title        : 'Purchasing group name';
};

annotate Supplier with @title: 'Supplier' {
  Supplier     @title: 'Supplier'  @Common.Text: SupplierName  @Common.TextArrangement: #TextFirst;
  SupplierName @title        : 'Supplier name';
};

annotate Product with @title: 'Material' {
  Product  @title: 'Material'  @Common.Text: description.ProductDescription  @Common.TextArrangement: #TextFirst;
};

annotate ProductDescription with {
  ProductDescription @title: 'Material description';
};

extend PurchaseOrderItem with {
  _confirmationControl : Association to one codes.SupplierConfirmationControlKey
                           on _confirmationControl.code = $self.SupplierConfirmationControlKey;
};

extend PurgInfoRecdOrgPlantData with {
  _confirmationControl : Association to one codes.SupplierConfirmationControlKey
                           on _confirmationControl.code = $self.SupplierConfirmationControlKey;
};

extend SupplierPurchasingOrg with {
  _confirmationControl : Association to one codes.SupplierConfirmationControlKey
                           on _confirmationControl.code = $self.SupplierConfirmationControlKey;
};

extend ProductPlantSupplyPlanning with {
  _mrpType            : Association to one codes.MRPType
                          on _mrpType.code = $self.MRPType;
  _procurementType    : Association to one codes.ProcurementType
                          on _procurementType.code = $self.ProcurementType;
  _specialProcurement : Association to one codes.SpecialProcurementType
                          on _specialProcurement.code = $self.ProcurementSubType;
};

extend ProductPlantMRP with {
  _mrpType : Association to one codes.MRPType
               on _mrpType.code = $self.MRPType;
};

extend PlannedOrder with {
  _procurementType : Association to one codes.ProcurementType
                       on _procurementType.code = $self.MaterialProcurementCategory;
};

annotate PurchaseOrderItem with {
  Material                        @title: 'Material'                  @Common.Text: PurchaseOrderItemText;
  Plant                           @title: 'Plant';
  SupplierConfirmationControlKey  @title: 'Confirmation control key'  @Common.Text: _confirmationControl.text;
};

annotate PurgInfoRecdOrgPlantData with {
  SupplierConfirmationControlKey  @title: 'Confirmation control key'  @Common.Text: _confirmationControl.text;
};

annotate SupplierPurchasingOrg with {
  SupplierConfirmationControlKey  @title: 'Confirmation control key'  @Common.Text: _confirmationControl.text;
};

annotate ProductPlantSupplyPlanning with {
  MRPType             @title: 'MRP type'                  @Common.Text: _mrpType.text;
  ProcurementType     @title: 'Procurement type'          @Common.Text: _procurementType.text;
  ProcurementSubType  @title: 'Special procurement type'  @Common.Text: _specialProcurement.text;
};

annotate ProductPlantMRP with {
  MRPType  @title: 'MRP type'  @Common.Text: _mrpType.text;
};

annotate PlannedOrder with {
  MaterialProcurementCategory  @title: 'Procurement type'  @Common.Text: _procurementType.text;
};

annotate SupplierConfirmationLine with {
  DelivDateCategory @title: 'Delivery date category';
};
