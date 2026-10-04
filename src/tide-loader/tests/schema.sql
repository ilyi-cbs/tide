CREATE TABLE tide_s4_DatasetInfo (
  ID NVARCHAR(20) NOT NULL,
  name NVARCHAR(255),
  source NVARCHAR(255),
  asOf DATE_TEXT,
  historyStart DATE_TEXT,
  containsCustomerData BOOLEAN NOT NULL DEFAULT TRUE,
  loadId NVARCHAR(36),
  loadedAt TIMESTAMP_TEXT,
  plants NCLOB,
  rowCounts NCLOB,
  absentTables NCLOB,
  PRIMARY KEY(ID)
);

CREATE TABLE tide_s4_PurchaseOrder (
  PurchaseOrder NVARCHAR(10) NOT NULL,
  PurchaseOrderType NVARCHAR(4),
  PurchaseOrderDate DATE_TEXT,
  CompanyCode NVARCHAR(4),
  PurchasingOrganization NVARCHAR(4),
  PurchasingGroup NVARCHAR(3),
  Supplier NVARCHAR(10),
  DocumentCurrency NVARCHAR(5),
  PurchasingDocumentOrigin NVARCHAR(1),
  CreatedByUser NVARCHAR(12),
  CreationDate DATE_TEXT,
  PurchasingProcessingStatus NVARCHAR(2),
  PaymentTerms NVARCHAR(4),
  IncotermsClassification NVARCHAR(3),
  PRIMARY KEY(PurchaseOrder)
);

CREATE TABLE tide_s4_PurchaseOrderItem (
  PurchaseOrder NVARCHAR(10) NOT NULL,
  PurchaseOrderItem NVARCHAR(5) NOT NULL,
  Material NVARCHAR(40),
  MaterialGroup NVARCHAR(9),
  MaterialType NVARCHAR(4),
  PurchaseOrderItemText NVARCHAR(40),
  Plant NVARCHAR(4),
  OrderQuantity DOUBLE,
  PurchaseOrderQuantityUnit NVARCHAR(3),
  NetPriceAmount DOUBLE,
  NetPriceQuantity DOUBLE,
  NetAmount DOUBLE,
  DocumentCurrency NVARCHAR(5),
  PlannedDeliveryDurationInDays DOUBLE,
  GoodsReceiptDurationInDays DOUBLE,
  PurchaseOrderItemCategory NVARCHAR(1),
  AccountAssignmentCategory NVARCHAR(1),
  PurchasingInfoRecord NVARCHAR(10),
  IsCompletelyDelivered BOOLEAN,
  PurchasingDocumentDeletionCode NVARCHAR(1),
  IsReturnsItem BOOLEAN,
  Customer NVARCHAR(10),
  CompanyCode NVARCHAR(4),
  StorageLocation NVARCHAR(4),
  BaseUnit NVARCHAR(3),
  PurchaseRequisition NVARCHAR(10),
  PurchaseRequisitionItem NVARCHAR(5),
  IsOrderAcknRqd BOOLEAN,
  SupplierConfirmationControlKey NVARCHAR(4),
  GoodsReceiptIsExpected BOOLEAN,
  IsFinallyInvoiced BOOLEAN,
  ItemIsRejectedBySupplier BOOLEAN,
  PurgItemIsBlockedForDelivery BOOLEAN,
  OverdelivTolrtdLmtRatioInPct DOUBLE,
  UnderdelivTolrtdLmtRatioInPct DOUBLE,
  PRIMARY KEY(PurchaseOrder, PurchaseOrderItem)
);

CREATE TABLE tide_s4_PurchaseOrderScheduleLine (
  PurchaseOrder NVARCHAR(10) NOT NULL,
  PurchaseOrderItem NVARCHAR(5) NOT NULL,
  ScheduleLine NVARCHAR(4) NOT NULL,
  ScheduleLineDeliveryDate DATE_TEXT,
  ScheduleLineOrderQuantity DOUBLE,
  OpenPurchaseOrderQuantity DOUBLE,
  SchedLineStscDeliveryDate DATE_TEXT,
  ScheduleLineOrderDate DATE_TEXT,
  DelivDateCategory NVARCHAR(1),
  PurchaseRequisition NVARCHAR(10),
  PurchaseRequisitionItem NVARCHAR(5),
  PRIMARY KEY(PurchaseOrder, PurchaseOrderItem, ScheduleLine)
);

CREATE TABLE tide_s4_PurchaseOrderAccountAssignment (
  PurchaseOrder NVARCHAR(10) NOT NULL,
  PurchaseOrderItem NVARCHAR(5) NOT NULL,
  AccountAssignmentNumber NVARCHAR(2) NOT NULL,
  SalesOrder NVARCHAR(10),
  SalesOrderItem NVARCHAR(6),
  CostCenter NVARCHAR(10),
  GLAccount NVARCHAR(10),
  Quantity DOUBLE,
  IsDeleted BOOLEAN,
  PRIMARY KEY(PurchaseOrder, PurchaseOrderItem, AccountAssignmentNumber)
);

CREATE TABLE tide_codes_SupplierConfirmationControlKey (
  code NVARCHAR(4) NOT NULL,
  text NVARCHAR(60),
  PRIMARY KEY(code)
);

CREATE TABLE tide_s4_Supplier (
  Supplier NVARCHAR(10) NOT NULL,
  SupplierName NVARCHAR(80),
  Country NVARCHAR(3),
  SupplierFullName NVARCHAR(220),
  SupplierAccountGroup NVARCHAR(4),
  SupplierCorporateGroup NVARCHAR(10),
  PurchasingIsBlocked BOOLEAN,
  DeletionIndicator BOOLEAN,
  PRIMARY KEY(Supplier)
);

CREATE TABLE tide_s4_SupplierPurchasingOrg (
  Supplier NVARCHAR(10) NOT NULL,
  PurchasingOrganization NVARCHAR(4) NOT NULL,
  IsOrderAcknRqd BOOLEAN,
  SupplierConfirmationControlKey NVARCHAR(4),
  MaterialPlannedDeliveryDurn DOUBLE,
  PurchaseOrderCurrency NVARCHAR(5),
  PaymentTerms NVARCHAR(4),
  IncotermsClassification NVARCHAR(3),
  InvoiceIsGoodsReceiptBased BOOLEAN,
  PurOrdAutoGenerationIsAllowed BOOLEAN,
  PurchasingIsBlockedForSupplier BOOLEAN,
  SupplierIsReturnsSupplier BOOLEAN,
  DeletionIndicator BOOLEAN,
  PRIMARY KEY(Supplier, PurchasingOrganization)
);

CREATE TABLE tide_s4_AccountingCompanyCode (
  CompanyCode NVARCHAR(4) NOT NULL,
  ControllingArea NVARCHAR(4),
  PRIMARY KEY(CompanyCode)
);

CREATE TABLE tide_s4_GLAccountCompany (
  CompanyCode NVARCHAR(4) NOT NULL,
  GLAccount NVARCHAR(10) NOT NULL,
  GLAccountName NVARCHAR(120),
  IsBlockedForPosting BOOLEAN,
  PRIMARY KEY(CompanyCode, GLAccount)
);

CREATE TABLE tide_s4_AccountingCostCenter (
  ControllingArea NVARCHAR(4) NOT NULL,
  CostCenter NVARCHAR(10) NOT NULL,
  ValidityEndDate DATE_TEXT NOT NULL,
  CompanyCode NVARCHAR(4),
  ValidityStartDate DATE_TEXT,
  CostCenterName NVARCHAR(120),
  IsBlockedForPosting BOOLEAN,
  PRIMARY KEY(ControllingArea, CostCenter, ValidityEndDate)
);

CREATE TABLE tide_s4_MaterialDocumentItem (
  MaterialDocumentYear NVARCHAR(4) NOT NULL,
  MaterialDocument NVARCHAR(10) NOT NULL,
  MaterialDocumentItem NVARCHAR(4) NOT NULL,
  PostingDate DATE_TEXT,
  GoodsMovementType NVARCHAR(3),
  GoodsMovementIsCancelled BOOLEAN,
  PurchaseOrder NVARCHAR(10),
  PurchaseOrderItem NVARCHAR(5),
  Material NVARCHAR(40),
  Plant NVARCHAR(4),
  QuantityInEntryUnit DOUBLE,
  QuantityInBaseUnit DOUBLE,
  DebitCreditCode NVARCHAR(1),
  SalesOrder NVARCHAR(10),
  SalesOrderItem NVARCHAR(6),
  StorageLocation NVARCHAR(4),
  InventoryStockType NVARCHAR(2),
  InventorySpecialStockType NVARCHAR(1),
  Supplier NVARCHAR(10),
  ManufacturingOrder NVARCHAR(12),
  Reservation NVARCHAR(10),
  ReservationItem NVARCHAR(4),
  ReservationIsFinallyIssued BOOLEAN,
  AccountAssignmentCategory NVARCHAR(1),
  CostCenter NVARCHAR(10),
  EntryUnit NVARCHAR(3),
  MaterialBaseUnit NVARCHAR(3),
  IsCompletelyDelivered BOOLEAN,
  DocumentDate DATE_TEXT,
  ReferenceDocument NVARCHAR(16),
  CreatedByUser NVARCHAR(12),
  CreationTime NVARCHAR(20),
  PRIMARY KEY(MaterialDocumentYear, MaterialDocument, MaterialDocumentItem)
);

CREATE TABLE tide_s4_SalesOrder (
  SalesOrder NVARCHAR(10) NOT NULL,
  SalesOrderType NVARCHAR(4),
  SoldToParty NVARCHAR(10),
  SalesOrganization NVARCHAR(4),
  SalesOrderDate DATE_TEXT,
  RequestedDeliveryDate DATE_TEXT,
  TransactionCurrency NVARCHAR(5),
  DistributionChannel NVARCHAR(2),
  OrganizationDivision NVARCHAR(2),
  TotalNetAmount DOUBLE,
  PRIMARY KEY(SalesOrder)
);

CREATE TABLE tide_s4_SalesOrderItem (
  SalesOrder NVARCHAR(10) NOT NULL,
  SalesOrderItem NVARCHAR(6) NOT NULL,
  Product NVARCHAR(40),
  Plant NVARCHAR(4),
  RequestedDeliveryDate DATE_TEXT,
  ConfirmedDeliveryDate DATE_TEXT,
  RequestedQuantity DOUBLE,
  ConfdDelivQtyInOrderQtyUnit DOUBLE,
  NetAmount DOUBLE,
  TransactionCurrency NVARCHAR(5),
  DeliveryStatus NVARCHAR(1),
  SalesOrderItemCategory NVARCHAR(4),
  RequestedQuantitySAPUnit NVARCHAR(3),
  PRIMARY KEY(SalesOrder, SalesOrderItem)
);

CREATE TABLE tide_s4_ProductionOrder (
  ManufacturingOrder NVARCHAR(12) NOT NULL,
  ManufacturingOrderType NVARCHAR(4),
  Material NVARCHAR(40),
  ProductionPlant NVARCHAR(4),
  TotalQuantity DOUBLE,
  ProductionUnit NVARCHAR(3),
  MfgOrderPlannedStartDate DATE_TEXT,
  MfgOrderPlannedEndDate DATE_TEXT,
  MfgOrderScheduledStartDate DATE_TEXT,
  MfgOrderScheduledEndDate DATE_TEXT,
  OrderIsCreated NVARCHAR(1),
  OrderIsReleased NVARCHAR(1),
  SalesOrder NVARCHAR(10),
  SalesOrderItem NVARCHAR(6),
  PRIMARY KEY(ManufacturingOrder)
);

CREATE TABLE tide_s4_ProductionOrderComponent (
  Reservation NVARCHAR(10) NOT NULL,
  ReservationItem NVARCHAR(4) NOT NULL,
  ManufacturingOrder NVARCHAR(12),
  Material NVARCHAR(40),
  Plant NVARCHAR(4),
  StorageLocation NVARCHAR(4),
  MatlCompRequirementDate DATE_TEXT,
  RequiredQuantity DOUBLE,
  WithdrawnQuantity DOUBLE,
  BaseUnit NVARCHAR(3),
  InventorySpecialStockType NVARCHAR(1),
  PRIMARY KEY(Reservation, ReservationItem)
);

CREATE TABLE tide_s4_Customer (
  Customer NVARCHAR(10) NOT NULL,
  CustomerName NVARCHAR(80),
  CustomerFullName NVARCHAR(220),
  CustomerAccountGroup NVARCHAR(4),
  DeletionIndicator BOOLEAN,
  PRIMARY KEY(Customer)
);

CREATE TABLE tide_s4_Product (
  Product NVARCHAR(40) NOT NULL,
  ProductType NVARCHAR(4),
  ProductGroup NVARCHAR(9),
  BaseUnit NVARCHAR(3),
  CreationDate DATE_TEXT,
  CreatedByUser NVARCHAR(12),
  IsMarkedForDeletion BOOLEAN,
  ItemCategoryGroup NVARCHAR(4),
  Division NVARCHAR(2),
  IndustrySector NVARCHAR(1),
  PRIMARY KEY(Product)
);

CREATE TABLE tide_s4_ProductPlant (
  Product NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  ProfitCenter NVARCHAR(10),
  IsMarkedForDeletion BOOLEAN,
  IsBatchManagementRequired BOOLEAN,
  IsNegativeStockAllowed BOOLEAN,
  ProductIsCriticalPrt BOOLEAN,
  GoodsIssueUnit NVARCHAR(3),
  BaseUnit NVARCHAR(3),
  PRIMARY KEY(Product, Plant)
);

CREATE TABLE tide_s4_ProductDescription (
  Product NVARCHAR(40) NOT NULL,
  Language NVARCHAR(2) NOT NULL,
  ProductDescription NVARCHAR(40),
  PRIMARY KEY(Product, Language)
);

CREATE TABLE tide_s4_ProductPlantSupplyPlanning (
  Product NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  MRPType NVARCHAR(2),
  MRPResponsible NVARCHAR(3),
  ProcurementType NVARCHAR(1),
  ProcurementSubType NVARCHAR(2),
  LotSizingProcedure NVARCHAR(2),
  PlannedDeliveryDurationInDays DOUBLE,
  GoodsReceiptDuration DOUBLE,
  SafetyStockQuantity DOUBLE,
  PlanningStrategyGroup NVARCHAR(2),
  SafetySupplyDurationInDays DOUBLE,
  ReorderThresholdQuantity DOUBLE,
  AvailabilityCheckType NVARCHAR(2),
  ProdInhProdnDurationInWorkDays DOUBLE,
  BaseUnit NVARCHAR(3),
  Currency NVARCHAR(5),
  PRIMARY KEY(Product, Plant)
);

CREATE TABLE tide_codes_MRPType (
  code NVARCHAR(4) NOT NULL,
  text NVARCHAR(60),
  PRIMARY KEY(code)
);

CREATE TABLE tide_codes_ProcurementType (
  code NVARCHAR(4) NOT NULL,
  text NVARCHAR(60),
  PRIMARY KEY(code)
);

CREATE TABLE tide_codes_SpecialProcurementType (
  code NVARCHAR(4) NOT NULL,
  text NVARCHAR(60),
  PRIMARY KEY(code)
);

CREATE TABLE tide_s4_ProductPlantProcurement (
  Product NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  PurchasingGroup NVARCHAR(3),
  IsAutoPurOrdCreationAllowed BOOLEAN,
  IsSourceListRequired BOOLEAN,
  PRIMARY KEY(Product, Plant)
);

CREATE TABLE tide_s4_PurgInfoRecdOrgPlantData (
  PurchasingInfoRecord NVARCHAR(10) NOT NULL,
  PurchasingInfoRecordCategory NVARCHAR(1) NOT NULL,
  PurchasingOrganization NVARCHAR(4) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  Material NVARCHAR(40),
  Supplier NVARCHAR(10),
  MaterialGroup NVARCHAR(9),
  PurchasingGroup NVARCHAR(3),
  MaterialPlannedDeliveryDurn DOUBLE,
  NetPriceAmount DOUBLE,
  MaterialPriceUnitQty DOUBLE,
  Currency NVARCHAR(5),
  IsMarkedForDeletion BOOLEAN,
  PurchasingDocumentDate DATE_TEXT,
  CreatedByUser NVARCHAR(12),
  PurgDocOrderQuantityUnit NVARCHAR(3),
  PurchaseOrderPriceUnit NVARCHAR(3),
  PriceValidityEndDate DATE_TEXT,
  IsOrderAcknRqd BOOLEAN,
  SupplierConfirmationControlKey NVARCHAR(4),
  InvoiceIsGoodsReceiptBased BOOLEAN,
  UnlimitedOverdeliveryIsAllowed BOOLEAN,
  IsRelevantForAutomSrcg NVARCHAR(1),
  PRIMARY KEY(PurchasingInfoRecord, PurchasingInfoRecordCategory, PurchasingOrganization, Plant)
);

CREATE TABLE tide_s4_ExchangeRate (
  SourceCurrency NVARCHAR(5) NOT NULL,
  ExchangeRate DOUBLE,
  PRIMARY KEY(SourceCurrency)
);

CREATE TABLE tide_s4_BusinessPartner (
  BusinessPartner NVARCHAR(10) NOT NULL,
  Customer NVARCHAR(10),
  Supplier NVARCHAR(10),
  BusinessPartnerCategory NVARCHAR(1),
  BusinessPartnerGrouping NVARCHAR(4),
  BusinessPartnerFullName NVARCHAR(81),
  BusinessPartnerName NVARCHAR(81),
  OrganizationBPName1 NVARCHAR(40),
  SearchTerm1 NVARCHAR(20),
  Language NVARCHAR(2),
  CreationDate DATE_TEXT,
  BusinessPartnerIsBlocked BOOLEAN,
  IsMarkedForArchiving BOOLEAN,
  PRIMARY KEY(BusinessPartner)
);

CREATE TABLE tide_s4_BusinessPartnerAddress (
  BusinessPartner NVARCHAR(10) NOT NULL,
  AddressID NVARCHAR(10) NOT NULL,
  CityName NVARCHAR(40),
  Country NVARCHAR(3),
  Language NVARCHAR(2),
  ValidityStartDate DATE_TEXT,
  ValidityEndDate DATE_TEXT,
  PRIMARY KEY(BusinessPartner, AddressID)
);

CREATE TABLE tide_s4_CustomerSalesArea (
  Customer NVARCHAR(10) NOT NULL,
  SalesOrganization NVARCHAR(4) NOT NULL,
  DistributionChannel NVARCHAR(2) NOT NULL,
  Division NVARCHAR(2) NOT NULL,
  Currency NVARCHAR(5),
  CustomerPaymentTerms NVARCHAR(4),
  CustomerABCClassification NVARCHAR(2),
  IncotermsClassification NVARCHAR(3),
  ShippingCondition NVARCHAR(2),
  CompleteDeliveryIsDefined BOOLEAN,
  DeletionIndicator BOOLEAN,
  PRIMARY KEY(Customer, SalesOrganization, DistributionChannel, Division)
);

CREATE TABLE tide_s4_SupplierCompany (
  Supplier NVARCHAR(10) NOT NULL,
  CompanyCode NVARCHAR(4) NOT NULL,
  PaymentTerms NVARCHAR(4),
  Currency NVARCHAR(5),
  ReconciliationAccount NVARCHAR(10),
  SupplierIsBlockedForPosting BOOLEAN,
  DeletionIndicator BOOLEAN,
  PRIMARY KEY(Supplier, CompanyCode)
);

CREATE TABLE tide_s4_ProductPlantMRP (
  Product NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  MRPArea NVARCHAR(10) NOT NULL,
  MRPType NVARCHAR(2),
  MRPResponsible NVARCHAR(3),
  LotSizingProcedure NVARCHAR(2),
  SafetyStockQuantity DOUBLE,
  ReorderThresholdQuantity DOUBLE,
  SafetySupplyDurationInDays DOUBLE,
  PlannedDeliveryDurationInDays DOUBLE,
  IsPlannedDeliveryTime BOOLEAN,
  ProductSafetyTimeMRPRelevance NVARCHAR(1),
  IsMarkedForDeletion BOOLEAN,
  BaseUnit NVARCHAR(3),
  Currency NVARCHAR(5),
  PRIMARY KEY(Product, Plant, MRPArea)
);

CREATE TABLE tide_s4_ProductValuation (
  Product NVARCHAR(40) NOT NULL,
  ValuationArea NVARCHAR(4) NOT NULL,
  ValuationType NVARCHAR(10) NOT NULL,
  ValuationClass NVARCHAR(4),
  PriceDeterminationControl NVARCHAR(1),
  InventoryValuationProcedure NVARCHAR(1),
  StandardPrice DOUBLE,
  MovingAveragePrice DOUBLE,
  ProductPriceUnitQuantity DOUBLE,
  Currency NVARCHAR(5),
  BaseUnit NVARCHAR(3),
  IsProducedInhouse BOOLEAN,
  IsMarkedForDeletion BOOLEAN,
  PRIMARY KEY(Product, ValuationArea, ValuationType)
);

CREATE TABLE tide_s4_ProductGroupText (
  ProductGroup NVARCHAR(9) NOT NULL,
  Language NVARCHAR(2) NOT NULL,
  ProductGroupName NVARCHAR(20),
  ProductGroupText NVARCHAR(60),
  PRIMARY KEY(ProductGroup, Language)
);

CREATE TABLE tide_s4_PurchasingInfoRecord (
  PurchasingInfoRecord NVARCHAR(10) NOT NULL,
  Supplier NVARCHAR(10),
  Material NVARCHAR(40),
  MaterialGroup NVARCHAR(9),
  CreationDate DATE_TEXT,
  IsDeleted BOOLEAN,
  PurgDocOrderQuantityUnit NVARCHAR(3),
  BaseUnit NVARCHAR(3),
  IsRegularSupplier BOOLEAN,
  PRIMARY KEY(PurchasingInfoRecord)
);

CREATE TABLE tide_s4_InbDeliveryHeader (
  DeliveryDocument NVARCHAR(10) NOT NULL,
  DeliveryDocumentType NVARCHAR(4),
  DeliveryDocumentBySupplier NVARCHAR(35),
  Supplier NVARCHAR(10),
  ReceivingPlant NVARCHAR(4),
  DeliveryDate DATE_TEXT,
  ActualGoodsMovementDate DATE_TEXT,
  DocumentDate DATE_TEXT,
  CreationDate DATE_TEXT,
  CreationTime NVARCHAR(20),
  CreatedByUser NVARCHAR(12),
  OverallGoodsMovementStatus NVARCHAR(1),
  OverallSDProcessStatus NVARCHAR(1),
  PRIMARY KEY(DeliveryDocument)
);

CREATE TABLE tide_s4_InbDeliveryItem (
  DeliveryDocument NVARCHAR(10) NOT NULL,
  DeliveryDocumentItem NVARCHAR(6) NOT NULL,
  DeliveryDocumentItemCategory NVARCHAR(4),
  Material NVARCHAR(40),
  Plant NVARCHAR(4),
  StorageLocation NVARCHAR(4),
  ActualDeliveryQuantity DOUBLE,
  ActualDeliveredQtyInBaseUnit DOUBLE,
  OriginalDeliveryQuantity DOUBLE,
  DeliveryQuantityUnit NVARCHAR(3),
  BaseUnit NVARCHAR(3),
  ReferenceSDDocument NVARCHAR(10),
  ReferenceSDDocumentItem NVARCHAR(6),
  ReferenceSDDocumentCategory NVARCHAR(4),
  GoodsMovementStatus NVARCHAR(1),
  GoodsMovementType NVARCHAR(3),
  CreationDate DATE_TEXT,
  PRIMARY KEY(DeliveryDocument, DeliveryDocumentItem)
);

CREATE TABLE tide_s4_InbDeliveryDocFlow (
  PrecedingDocument NVARCHAR(10) NOT NULL,
  PrecedingDocumentItem NVARCHAR(6) NOT NULL,
  SubsequentDocument NVARCHAR(10) NOT NULL,
  SubsequentDocumentItem NVARCHAR(6) NOT NULL,
  PrecedingDocumentCategory NVARCHAR(4),
  SubsequentDocumentCategory NVARCHAR(4),
  QuantityInBaseUnit DOUBLE,
  PRIMARY KEY(PrecedingDocument, PrecedingDocumentItem, SubsequentDocument, SubsequentDocumentItem)
);

CREATE TABLE tide_s4_MatlStkInAcctMod (
  Material NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  StorageLocation NVARCHAR(4) NOT NULL,
  Batch NVARCHAR(10) NOT NULL,
  Supplier NVARCHAR(10) NOT NULL,
  Customer NVARCHAR(10) NOT NULL,
  WBSElementInternalID NVARCHAR(24) NOT NULL,
  SDDocument NVARCHAR(10) NOT NULL,
  SDDocumentItem NVARCHAR(6) NOT NULL,
  InventorySpecialStockType NVARCHAR(1) NOT NULL,
  InventoryStockType NVARCHAR(2) NOT NULL,
  WBSElementExternalID NVARCHAR(24),
  MaterialBaseUnit NVARCHAR(3),
  MatlWrhsStkQtyInMatlBaseUnit DOUBLE,
  PRIMARY KEY(Material, Plant, StorageLocation, Batch, Supplier, Customer, WBSElementInternalID, SDDocument, SDDocumentItem, InventorySpecialStockType, InventoryStockType)
);

CREATE TABLE tide_s4_MaterialBOM (
  BillOfMaterial NVARCHAR(8) NOT NULL,
  BillOfMaterialCategory NVARCHAR(1) NOT NULL,
  BillOfMaterialVariant NVARCHAR(2) NOT NULL,
  BillOfMaterialVersion NVARCHAR(4) NOT NULL,
  Material NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  BillOfMaterialVariantUsage NVARCHAR(1),
  BOMHeaderBaseUnit NVARCHAR(3),
  BOMHeaderQuantityInBaseUnit DOUBLE,
  ValidityStartDate DATE_TEXT,
  PRIMARY KEY(BillOfMaterial, BillOfMaterialCategory, BillOfMaterialVariant, BillOfMaterialVersion, Material, Plant)
);

CREATE TABLE tide_s4_MaterialBOMItem (
  BillOfMaterial NVARCHAR(8) NOT NULL,
  BillOfMaterialCategory NVARCHAR(1) NOT NULL,
  BillOfMaterialVariant NVARCHAR(2) NOT NULL,
  BillOfMaterialVersion NVARCHAR(4) NOT NULL,
  BillOfMaterialItemNodeNumber NVARCHAR(8) NOT NULL,
  Material NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  BillOfMaterialItemNumber NVARCHAR(4),
  BillOfMaterialItemCategory NVARCHAR(1),
  BillOfMaterialComponent NVARCHAR(40),
  BillOfMaterialItemQuantity DOUBLE,
  BillOfMaterialItemUnit NVARCHAR(3),
  ValidityStartDate DATE_TEXT,
  PRIMARY KEY(BillOfMaterial, BillOfMaterialCategory, BillOfMaterialVariant, BillOfMaterialVersion, BillOfMaterialItemNodeNumber, Material, Plant)
);

CREATE TABLE tide_s4_PurchaseReqn (
  PurchaseRequisition NVARCHAR(10) NOT NULL,
  PurchaseRequisitionType NVARCHAR(4),
  PurReqnDescription NVARCHAR(40),
  PRIMARY KEY(PurchaseRequisition)
);

CREATE TABLE tide_s4_PurchaseReqnText (
  PurchaseRequisition NVARCHAR(10) NOT NULL,
  TextType NVARCHAR(4) NOT NULL,
  Language NVARCHAR(2) NOT NULL,
  Text NCLOB,
  PRIMARY KEY(PurchaseRequisition, TextType, Language)
);

CREATE TABLE tide_s4_PurchaseReqnItem (
  PurchaseRequisition NVARCHAR(10) NOT NULL,
  PurchaseRequisitionItem NVARCHAR(5) NOT NULL,
  PurchaseRequisitionItemText NVARCHAR(40),
  PurchasingDocumentItemCategory NVARCHAR(1),
  AccountAssignmentCategory NVARCHAR(1),
  Material NVARCHAR(40),
  MaterialGroup NVARCHAR(9),
  Plant NVARCHAR(4),
  StorageLocation NVARCHAR(4),
  CompanyCode NVARCHAR(4),
  PurchasingOrganization NVARCHAR(4),
  PurchasingGroup NVARCHAR(3),
  MRPController NVARCHAR(3),
  RequestedQuantity DOUBLE,
  OrderedQuantity DOUBLE,
  BaseUnit NVARCHAR(3),
  PurchaseRequisitionPrice DOUBLE,
  PurReqnPriceQuantity DOUBLE,
  ItemNetAmount DOUBLE,
  PurReqnItemCurrency NVARCHAR(5),
  DeliveryDate DATE_TEXT,
  PurReqCreationDate DATE_TEXT,
  PurchaseRequisitionReleaseDate DATE_TEXT,
  MaterialPlannedDeliveryDurn DOUBLE,
  MaterialGoodsReceiptDuration DOUBLE,
  Supplier NVARCHAR(10),
  FixedSupplier NVARCHAR(10),
  SourceOfSupplyIsAssigned BOOLEAN,
  PurReqnOrigin NVARCHAR(1),
  PurReqnReleaseStatus NVARCHAR(2),
  ProcessingStatus NVARCHAR(2),
  IsDeleted BOOLEAN,
  IsClosed BOOLEAN,
  PurchaseRequisitionIsFixed BOOLEAN,
  PurchasingDocument NVARCHAR(10),
  PurchasingDocumentItem NVARCHAR(5),
  CreatedByUser NVARCHAR(12),
  RequisitionerName NVARCHAR(80),
  PurchasingInfoRecord NVARCHAR(10),
  OutlineAgreement NVARCHAR(10),
  OutlineAgreementItem NVARCHAR(5),
  RequirementTracking NVARCHAR(10),
  TaxCode NVARCHAR(2),
  GoodsReceiptIsExpected BOOLEAN,
  InvoiceIsGoodsReceiptBased BOOLEAN,
  IsEvaluatedRcptSettlmtAllowed BOOLEAN,
  ServicePerformer NVARCHAR(80),
  PerformancePeriodStartDate DATE_TEXT,
  PerformancePeriodEndDate DATE_TEXT,
  ExpectedOverallLimitAmount DOUBLE,
  OverallLimitAmount DOUBLE,
  PRIMARY KEY(PurchaseRequisition, PurchaseRequisitionItem)
);

CREATE TABLE tide_s4_PurchaseReqnItemText (
  PurchaseRequisition NVARCHAR(10) NOT NULL,
  PurchaseRequisitionItem NVARCHAR(5) NOT NULL,
  TextType NVARCHAR(4) NOT NULL,
  Language NVARCHAR(2) NOT NULL,
  Text NCLOB,
  PRIMARY KEY(PurchaseRequisition, PurchaseRequisitionItem, TextType, Language)
);

CREATE TABLE tide_s4_PurchaseReqnDelivAddress (
  PurchaseRequisition NVARCHAR(10) NOT NULL,
  PurchaseRequisitionItem NVARCHAR(5) NOT NULL,
  Name NVARCHAR(80),
  Street NVARCHAR(120),
  HouseNumber NVARCHAR(20),
  City NVARCHAR(40),
  PostalCode NVARCHAR(10),
  Country NVARCHAR(3),
  UnloadingPoint NVARCHAR(25),
  PRIMARY KEY(PurchaseRequisition, PurchaseRequisitionItem)
);

CREATE TABLE tide_s4_PurchaseReqnAcctAssgmt (
  PurchaseRequisition NVARCHAR(10) NOT NULL,
  PurchaseRequisitionItem NVARCHAR(5) NOT NULL,
  PurchaseReqnAcctAssgmtNumber NVARCHAR(2) NOT NULL,
  CostCenter NVARCHAR(10),
  GLAccount NVARCHAR(10),
  SalesOrder NVARCHAR(10),
  SalesOrderItem NVARCHAR(6),
  MasterFixedAsset NVARCHAR(12),
  FixedAsset NVARCHAR(4),
  OrderID NVARCHAR(12),
  WBSElement NVARCHAR(24),
  BaseUnit NVARCHAR(3),
  Quantity DOUBLE,
  DistributionPercent DOUBLE,
  PurReqnItemCurrency NVARCHAR(5),
  PurReqnNetAmount DOUBLE,
  IsDeleted BOOLEAN,
  PRIMARY KEY(PurchaseRequisition, PurchaseRequisitionItem, PurchaseReqnAcctAssgmtNumber)
);

CREATE TABLE tide_s4_SupplierConfirmation (
  SupplierConfirmation NVARCHAR(10) NOT NULL,
  SuplrConfRefPurchaseOrder NVARCHAR(10),
  SuplrConfProcessingStatus NVARCHAR(2),
  SuplrConfExternalReference NVARCHAR(70),
  CreationDate DATE_TEXT,
  PRIMARY KEY(SupplierConfirmation)
);

CREATE TABLE tide_s4_SupplierConfirmationItem (
  SupplierConfirmation NVARCHAR(10) NOT NULL,
  SupplierConfirmationItem NVARCHAR(5) NOT NULL,
  SuplrConfRefPurchaseOrder NVARCHAR(10),
  SuplrConfRefPurchaseOrderItem NVARCHAR(5),
  SupplierConfirmedNetPrice DOUBLE,
  DocumentCurrency NVARCHAR(5),
  ItemIsRejectedBySupplier BOOLEAN,
  PRIMARY KEY(SupplierConfirmation, SupplierConfirmationItem)
);

CREATE TABLE tide_s4_SupplierConfirmationLine (
  SupplierConfirmation NVARCHAR(10) NOT NULL,
  SupplierConfirmationItem NVARCHAR(5) NOT NULL,
  SupplierConfirmationLine NVARCHAR(4) NOT NULL,
  DeliveryDate DATE_TEXT,
  DelivDateCategory NVARCHAR(1),
  ConfirmedQuantity DOUBLE,
  PurchaseOrderQuantityUnit NVARCHAR(3),
  PRIMARY KEY(SupplierConfirmation, SupplierConfirmationItem, SupplierConfirmationLine)
);

CREATE TABLE tide_s4_PlannedOrder (
  PlannedOrder NVARCHAR(10) NOT NULL,
  PlannedOrderType NVARCHAR(4),
  Material NVARCHAR(40),
  MaterialName NVARCHAR(40),
  MRPPlant NVARCHAR(4),
  ProductionPlant NVARCHAR(4),
  MRPArea NVARCHAR(10),
  MaterialProcurementCategory NVARCHAR(1),
  MaterialProcurementType NVARCHAR(1),
  TotalQuantity DOUBLE,
  BaseUnit NVARCHAR(3),
  PlndOrderPlannedStartDate DATE_TEXT,
  PlndOrderPlannedEndDate DATE_TEXT,
  PlannedOrderOpeningDate DATE_TEXT,
  SalesOrder NVARCHAR(10),
  SalesOrderItem NVARCHAR(6),
  MRPController NVARCHAR(3),
  PurchasingGroup NVARCHAR(3),
  PurchasingOrganization NVARCHAR(4),
  FixedSupplier NVARCHAR(10),
  SupplierName NVARCHAR(80),
  PlannedOrderIsFirm BOOLEAN,
  PlannedOrderIsConvertible BOOLEAN,
  PRIMARY KEY(PlannedOrder)
);

CREATE TABLE tide_s4_PlannedOrderComponent (
  PlannedOrder NVARCHAR(10) NOT NULL,
  Reservation NVARCHAR(10) NOT NULL,
  ReservationItem NVARCHAR(4) NOT NULL,
  Material NVARCHAR(40),
  Plant NVARCHAR(4),
  StorageLocation NVARCHAR(4),
  MatlCompRequirementDate DATE_TEXT,
  RequiredQuantity DOUBLE,
  WithdrawnQuantity DOUBLE,
  BaseUnit NVARCHAR(3),
  BOMItemDescription NVARCHAR(40),
  PRIMARY KEY(PlannedOrder, Reservation, ReservationItem)
);

CREATE TABLE tide_s4_PlannedIndepRqmt (
  Product NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  MRPArea NVARCHAR(10) NOT NULL,
  PlngIndepRqmtType NVARCHAR(4) NOT NULL,
  PlngIndepRqmtVersion NVARCHAR(2) NOT NULL,
  RequirementPlan NVARCHAR(10) NOT NULL,
  RequirementSegment NVARCHAR(40) NOT NULL,
  PlngIndepRqmtIsActive BOOLEAN,
  PRIMARY KEY(Product, Plant, MRPArea, PlngIndepRqmtType, PlngIndepRqmtVersion, RequirementPlan, RequirementSegment)
);

CREATE TABLE tide_s4_PlannedIndepRqmtItem (
  Product NVARCHAR(40) NOT NULL,
  Plant NVARCHAR(4) NOT NULL,
  MRPArea NVARCHAR(10) NOT NULL,
  PlngIndepRqmtType NVARCHAR(4) NOT NULL,
  PlngIndepRqmtVersion NVARCHAR(2) NOT NULL,
  RequirementPlan NVARCHAR(10) NOT NULL,
  RequirementSegment NVARCHAR(40) NOT NULL,
  PlngIndepRqmtPeriod NVARCHAR(8) NOT NULL,
  PeriodType NVARCHAR(1) NOT NULL,
  WorkingDayDate DATE_TEXT,
  PlannedQuantity DOUBLE,
  WithdrawalQuantity DOUBLE,
  UnitOfMeasure NVARCHAR(3),
  PRIMARY KEY(Product, Plant, MRPArea, PlngIndepRqmtType, PlngIndepRqmtVersion, RequirementPlan, RequirementSegment, PlngIndepRqmtPeriod, PeriodType)
);

CREATE TABLE tide_s4_Plant (
  Plant NVARCHAR(4) NOT NULL,
  PlantName NVARCHAR(30),
  CompanyCode NVARCHAR(4),
  Country NVARCHAR(3),
  Language NVARCHAR(2),
  PRIMARY KEY(Plant)
);

CREATE TABLE tide_s4_CompanyCode (
  CompanyCode NVARCHAR(4) NOT NULL,
  CompanyCodeName NVARCHAR(25),
  Country NVARCHAR(3),
  Currency NVARCHAR(5),
  PRIMARY KEY(CompanyCode)
);

CREATE TABLE tide_s4_PurchasingOrganization (
  PurchasingOrganization NVARCHAR(4) NOT NULL,
  PurchasingOrganizationName NVARCHAR(20),
  CompanyCode NVARCHAR(4),
  PRIMARY KEY(PurchasingOrganization)
);

CREATE TABLE tide_s4_PurchasingGroup (
  PurchasingGroup NVARCHAR(3) NOT NULL,
  PurchasingGroupName NVARCHAR(18),
  PhoneNumber NVARCHAR(30),
  EmailAddress NVARCHAR(241),
  PRIMARY KEY(PurchasingGroup)
);

CREATE TABLE tide_s4_StorageLocation (
  Plant NVARCHAR(4) NOT NULL,
  StorageLocation NVARCHAR(4) NOT NULL,
  StorageLocationName NVARCHAR(16),
  PRIMARY KEY(Plant, StorageLocation)
);

CREATE TABLE tide_s4_MRPController (
  Plant NVARCHAR(4) NOT NULL,
  MRPController NVARCHAR(3) NOT NULL,
  MRPControllerName NVARCHAR(18),
  PurchasingGroup NVARCHAR(3),
  PRIMARY KEY(Plant, MRPController)
);

CREATE TABLE tide_s4_SalesOrganization (
  SalesOrganization NVARCHAR(4) NOT NULL,
  SalesOrganizationName NVARCHAR(20),
  CompanyCode NVARCHAR(4),
  PRIMARY KEY(SalesOrganization)
);

CREATE TABLE tide_source_SourceLoads (
  ID NVARCHAR(36) NOT NULL,
  sourceSystem NVARCHAR(80) NOT NULL,
  sourceType NVARCHAR(10) NOT NULL,
  asOf DATE_TEXT NOT NULL,
  ingestedAt TIMESTAMP_TEXT NOT NULL,
  contentIdentity NVARCHAR(128) NOT NULL,
  schemaVersion NVARCHAR(80) NOT NULL,
  normalizationVersion NVARCHAR(80) NOT NULL,
  trusted BOOLEAN NOT NULL,
  completeness NVARCHAR(20) NOT NULL,
  quality NCLOB,
  PRIMARY KEY(ID)
);

CREATE TABLE tide_source_SourcePublications (
  name NVARCHAR(80) NOT NULL,
  load_ID NVARCHAR(36) NOT NULL,
  inputRevision NVARCHAR(128) NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(name)
);

CREATE TABLE tide_source_IngestOperations (
  ID NVARCHAR(36) NOT NULL,
  batchIdentity NVARCHAR(128) NOT NULL,
  baseRevision NVARCHAR(128),
  targetRevision NVARCHAR(128) NOT NULL,
  stageResults NCLOB,
  status NVARCHAR(20) NOT NULL,
  correlation NVARCHAR(128),
  PRIMARY KEY(ID)
);

CREATE TABLE tide_codes_SupplierConfirmationCategory (
  code NVARCHAR(4) NOT NULL,
  text NVARCHAR(60),
  PRIMARY KEY(code)
);
