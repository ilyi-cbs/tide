from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

BATCH = 50_000


MAX_YEAR = 2100


@dataclass(frozen=True)
class Column:
    name: str
    kind: str  # text | date | num | int | bool | item
    source: str | None = None  # source column if the name differs


ITEM_NUMBERS = {
    "PurchaseOrderItem",
    "SalesOrderItem",
    "SuplrConfRefPurchaseOrderItem",
    "ReferenceSDDocumentItem",
    "PrecedingDocumentItem",
    "PurchasingDocumentItem",
    "SDDocumentItem",
}


@dataclass(frozen=True)
class Table:
    entity: str  # entity name in the namespace (tide.s4 or tide.truth)
    raw: str | None  # path in an extract; None: not in extracts
    synthetic: str  # path in the synthetic dataset (and in delta/<date>/)
    columns: tuple[Column, ...]
    keys: tuple[str, ...]
    plant: str | None = None  # column that scopes rows by plant
    # SQL (DuckDB) replacing the plain file read; {src} is the file, {path(x)} other files.
    select: dict[str, str] = field(default_factory=dict)
    # With a plant scope: keep only rows whose document is in the loaded (s4) table
    # `via`, joined on (own column, via column) pairs. Applied in TABLES order.
    scope: tuple[str, tuple[tuple[str, str], ...]] | None = None
    optional: bool = False  # planned (v4) table: skipped, and reported, when absent
    namespace: str = "s4"

    @property
    def sql_table(self) -> str:
        return f"tide_{self.namespace}_{self.entity}"

    @property
    def qualified(self) -> str:
        return f"tide.{self.namespace}.{self.entity}"


def t(name: str) -> Column:
    return Column(name, "item" if name in ITEM_NUMBERS else "text")


def d(name: str) -> Column:
    return Column(name, "date")


def n(name: str) -> Column:
    return Column(name, "num")


def b(name: str) -> Column:
    return Column(name, "bool")


def i(name: str) -> Column:
    return Column(name, "int")


def cols(spec: str) -> tuple[Column, ...]:
    """Columns from 'Name Name:d Name:n Name:i Name:b' (text, date, number, integer, boolean)."""
    out = []
    for token in spec.split():
        name, _, kind = token.partition(":")
        out.append({"": t, "d": d, "n": n, "b": b, "i": i}[kind](name))
    return tuple(out)


PO = "API_PURCHASEORDER_2"


BP = "API_BUSINESS_PARTNER"


PROD = "API_PRODUCT"


PP = ("Product", "Plant")


TABLES: tuple[Table, ...] = (
    Table(
        "AccountingCompanyCode",
        "accounting/AccountingCompanyCode",
        "accounting/AccountingCompanyCode",
        cols("CompanyCode ControllingArea"),
        ("CompanyCode",),
        optional=True,
    ),
    Table(
        "GLAccountCompany",
        "accounting/GLAccountCompany",
        "accounting/GLAccountCompany",
        cols("CompanyCode GLAccount GLAccountName IsBlockedForPosting:b"),
        ("CompanyCode", "GLAccount"),
        optional=True,
    ),
    Table(
        "AccountingCostCenter",
        "accounting/AccountingCostCenter",
        "accounting/AccountingCostCenter",
        cols(
            "ControllingArea CostCenter ValidityEndDate:d CompanyCode ValidityStartDate:d "
            "CostCenterName IsBlockedForPosting:b"
        ),
        ("ControllingArea", "CostCenter", "ValidityEndDate"),
        optional=True,
    ),
    # ---------------------------------------------------------------- purchasing
    Table(
        "PurchaseOrder",
        "purchaseorder/PurchaseOrder",
        f"{PO}/PurchaseOrder",
        cols(
            "PurchaseOrder PurchaseOrderType PurchaseOrderDate:d CompanyCode "
            "PurchasingOrganization PurchasingGroup Supplier DocumentCurrency "
            "PurchasingDocumentOrigin CreatedByUser CreationDate:d PurchasingProcessingStatus "
            "PaymentTerms IncotermsClassification"
        ),
        ("PurchaseOrder",),
        scope=("PurchaseOrderItem", (("PurchaseOrder", "PurchaseOrder"),)),
    ),
    Table(
        "PurchaseOrderItem",
        "purchaseorder/PurchaseOrderItem",
        f"{PO}/PurchaseOrderItem",
        cols(
            "PurchaseOrder PurchaseOrderItem Material MaterialGroup MaterialType "
            "PurchaseOrderItemText Plant OrderQuantity:n PurchaseOrderQuantityUnit "
            "NetPriceAmount:n NetPriceQuantity:n NetAmount:n DocumentCurrency "
            "PlannedDeliveryDurationInDays:n GoodsReceiptDurationInDays:n "
            "PurchaseOrderItemCategory AccountAssignmentCategory PurchasingInfoRecord "
            "IsCompletelyDelivered:b PurchasingDocumentDeletionCode IsReturnsItem:b Customer "
            "CompanyCode StorageLocation BaseUnit PurchaseRequisition PurchaseRequisitionItem "
            "IsOrderAcknRqd:b SupplierConfirmationControlKey GoodsReceiptIsExpected:b "
            "IsFinallyInvoiced:b ItemIsRejectedBySupplier:b PurgItemIsBlockedForDelivery:b "
            "OverdelivTolrtdLmtRatioInPct:n UnderdelivTolrtdLmtRatioInPct:n"
        ),
        ("PurchaseOrder", "PurchaseOrderItem"),
        plant="Plant",
    ),
    Table(
        "PurchaseOrderScheduleLine",
        "purchaseorder/PurchaseOrderScheduleLine",
        f"{PO}/PurchaseOrderScheduleLine",
        cols(
            "PurchaseOrder PurchaseOrderItem ScheduleLine ScheduleLineDeliveryDate:d "
            "ScheduleLineOrderQuantity:n OpenPurchaseOrderQuantity:n "
            "SchedLineStscDeliveryDate:d ScheduleLineOrderDate:d DelivDateCategory "
            "PurchaseRequisition PurchaseRequisitionItem"
        ),
        ("PurchaseOrder", "PurchaseOrderItem", "ScheduleLine"),
        scope=("PurchaseOrderItem", (("PurchaseOrder",) * 2, ("PurchaseOrderItem",) * 2)),
    ),
    Table(
        "PurchaseOrderAccountAssignment",
        "purchaseorder/PurchaseOrderAccountAssignment",
        f"{PO}/PurchaseOrderAccountAssignment",
        cols(
            "PurchaseOrder PurchaseOrderItem AccountAssignmentNumber SalesOrder SalesOrderItem "
            "CostCenter GLAccount Quantity:n IsDeleted:b"
        ),
        ("PurchaseOrder", "PurchaseOrderItem", "AccountAssignmentNumber"),
        scope=("PurchaseOrderItem", (("PurchaseOrder",) * 2, ("PurchaseOrderItem",) * 2)),
    ),
    Table(
        "PurchaseReqnItem",
        None,
        "API_PURCHASEREQUISITION_2/PurchaseReqnItem",
        cols(
            "PurchaseRequisition PurchaseRequisitionItem PurchaseRequisitionItemText "
            "PurchasingDocumentItemCategory AccountAssignmentCategory Material MaterialGroup "
            "Plant StorageLocation CompanyCode PurchasingOrganization PurchasingGroup "
            "MRPController RequestedQuantity:n OrderedQuantity:n BaseUnit "
            "PurchaseRequisitionPrice:n PurReqnPriceQuantity:n ItemNetAmount:n "
            "PurReqnItemCurrency DeliveryDate:d PurReqCreationDate:d "
            "PurchaseRequisitionReleaseDate:d MaterialPlannedDeliveryDurn:n "
            "MaterialGoodsReceiptDuration:n Supplier FixedSupplier SourceOfSupplyIsAssigned:b "
            "PurReqnOrigin PurReqnReleaseStatus ProcessingStatus IsDeleted:b IsClosed:b "
            "PurchaseRequisitionIsFixed:b PurchasingDocument PurchasingDocumentItem "
            "CreatedByUser RequisitionerName PurchasingInfoRecord OutlineAgreement "
            "OutlineAgreementItem RequirementTracking TaxCode GoodsReceiptIsExpected:b "
            "InvoiceIsGoodsReceiptBased:b IsEvaluatedRcptSettlmtAllowed:b "
            "ServicePerformer PerformancePeriodStartDate:d PerformancePeriodEndDate:d "
            "ExpectedOverallLimitAmount:n OverallLimitAmount:n"
        ),
        ("PurchaseRequisition", "PurchaseRequisitionItem"),
        plant="Plant",
    ),
    Table(
        "PurchaseReqn",
        None,
        "API_PURCHASEREQUISITION_2/PurchaseReqn",
        cols("PurchaseRequisition PurchaseRequisitionType PurReqnDescription"),
        ("PurchaseRequisition",),
        scope=("PurchaseReqnItem", (("PurchaseRequisition",) * 2,)),
    ),
    Table(
        "PurchaseReqnText",
        None,
        "API_PURCHASEREQUISITION_2/PurchaseReqnText",
        cols("PurchaseRequisition TextType Language Text"),
        ("PurchaseRequisition", "TextType", "Language"),
        scope=("PurchaseReqn", (("PurchaseRequisition",) * 2,)),
        optional=True,
    ),
    Table(
        "PurchaseReqnItemText",
        None,
        "API_PURCHASEREQUISITION_2/PurchaseReqnItemText",
        cols("PurchaseRequisition PurchaseRequisitionItem TextType Language Text"),
        ("PurchaseRequisition", "PurchaseRequisitionItem", "TextType", "Language"),
        scope=(
            "PurchaseReqnItem",
            (("PurchaseRequisition",) * 2, ("PurchaseRequisitionItem",) * 2),
        ),
        optional=True,
    ),
    Table(
        "PurchaseReqnDelivAddress",
        None,
        "API_PURCHASEREQUISITION_2/PurchaseReqnDelivAddress",
        cols(
            "PurchaseRequisition PurchaseRequisitionItem Name Street HouseNumber City "
            "PostalCode Country UnloadingPoint"
        ),
        ("PurchaseRequisition", "PurchaseRequisitionItem"),
        scope=(
            "PurchaseReqnItem",
            (("PurchaseRequisition",) * 2, ("PurchaseRequisitionItem",) * 2),
        ),
        optional=True,
    ),
    Table(
        "PurchaseReqnAcctAssgmt",
        None,
        "API_PURCHASEREQUISITION_2/PurchaseReqnAcctAssgmt",
        cols(
            "PurchaseRequisition PurchaseRequisitionItem PurchaseReqnAcctAssgmtNumber "
            "CostCenter GLAccount SalesOrder SalesOrderItem MasterFixedAsset FixedAsset "
            "OrderID WBSElement "
            "Quantity:n DistributionPercent:n IsDeleted:b"
        ),
        ("PurchaseRequisition", "PurchaseRequisitionItem", "PurchaseReqnAcctAssgmtNumber"),
        scope=(
            "PurchaseReqnItem",
            (("PurchaseRequisition",) * 2, ("PurchaseRequisitionItem",) * 2),
        ),
    ),
    # ---------------------------------------------------------------- goods movements
    Table(
        "MaterialDocumentItem",
        "materialdocument/A_MaterialDocumentItem",
        "API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem",
        cols(
            "MaterialDocumentYear MaterialDocument MaterialDocumentItem PostingDate:d "
            "GoodsMovementType GoodsMovementIsCancelled:b PurchaseOrder PurchaseOrderItem "
            "Material Plant QuantityInEntryUnit:n QuantityInBaseUnit:n DebitCreditCode "
            "SalesOrder SalesOrderItem StorageLocation InventoryStockType "
            "InventorySpecialStockType Supplier ManufacturingOrder Reservation ReservationItem "
            "ReservationIsFinallyIssued:b AccountAssignmentCategory CostCenter EntryUnit "
            "MaterialBaseUnit IsCompletelyDelivered:b DocumentDate:d ReferenceDocument "
            "CreatedByUser CreationTime"
        ),
        ("MaterialDocumentYear", "MaterialDocument", "MaterialDocumentItem"),
        plant="Plant",
        # Goods movements the cockpit reads: receipts for PO items (101-109 and
        # their reversals) and deliveries/consumption (601, 261, 201).
        select={
            "*": """
                SELECT i.*, h.* EXCLUDE (MaterialDocumentYear, MaterialDocument)
                FROM {src} i
                JOIN (SELECT COLUMNS(c -> c IN ('MaterialDocumentYear', 'MaterialDocument',
                             'PostingDate', 'DocumentDate', 'ReferenceDocument',
                             'CreatedByUser', 'CreationTime'))
                      FROM {path(header)}) h
                  USING (MaterialDocumentYear, MaterialDocument)
                WHERE i.GoodsMovementType IN
                      ('101','102','103','104','105','106','107','108','109','110',
                       '122','123','601','602','261','262','201','202')
            """
        },
    ),
    Table(
        "InbDeliveryItem",
        None,
        "API_INBOUND_DELIVERY_SRV_0002/A_InbDeliveryItem",
        cols(
            "DeliveryDocument DeliveryDocumentItem DeliveryDocumentItemCategory Material Plant "
            "StorageLocation ActualDeliveryQuantity:n ActualDeliveredQtyInBaseUnit:n "
            "OriginalDeliveryQuantity:n DeliveryQuantityUnit BaseUnit ReferenceSDDocument "
            "ReferenceSDDocumentItem ReferenceSDDocumentCategory GoodsMovementStatus "
            "GoodsMovementType CreationDate:d"
        ),
        ("DeliveryDocument", "DeliveryDocumentItem"),
        plant="Plant",
    ),
    Table(
        "InbDeliveryHeader",
        None,
        "API_INBOUND_DELIVERY_SRV_0002/A_InbDeliveryHeader",
        cols(
            "DeliveryDocument DeliveryDocumentType DeliveryDocumentBySupplier Supplier "
            "ReceivingPlant DeliveryDate:d ActualGoodsMovementDate:d DocumentDate:d "
            "CreationDate:d CreationTime CreatedByUser OverallGoodsMovementStatus "
            "OverallSDProcessStatus"
        ),
        ("DeliveryDocument",),
        plant="ReceivingPlant",
    ),
    Table(
        "InbDeliveryDocFlow",
        None,
        "API_INBOUND_DELIVERY_SRV_0002/A_InbDeliveryDocFlow",
        cols(
            "PrecedingDocument PrecedingDocumentItem SubsequentDocument SubsequentDocumentItem "
            "PrecedingDocumentCategory SubsequentDocumentCategory QuantityInBaseUnit:n"
        ),
        (
            "PrecedingDocument",
            "PrecedingDocumentItem",
            "SubsequentDocument",
            "SubsequentDocumentItem",
        ),
        scope=(
            "InbDeliveryItem",
            (
                ("SubsequentDocument", "DeliveryDocument"),
                ("SubsequentDocumentItem", "DeliveryDocumentItem"),
            ),
        ),
    ),
    Table(
        "MatlStkInAcctMod",
        None,
        "API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod",
        cols(
            "Material Plant StorageLocation Batch Supplier Customer WBSElementInternalID "
            "SDDocument SDDocumentItem InventorySpecialStockType InventoryStockType "
            "WBSElementExternalID MaterialBaseUnit MatlWrhsStkQtyInMatlBaseUnit:n"
        ),
        (
            "Material",
            "Plant",
            "StorageLocation",
            "Batch",
            "Supplier",
            "Customer",
            "WBSElementInternalID",
            "SDDocument",
            "SDDocumentItem",
            "InventorySpecialStockType",
            "InventoryStockType",
        ),
        plant="Plant",
    ),
    # ---------------------------------------------------------------- sales
    Table(
        "SalesOrderItem",
        "salesorder/SalesOrderItem",
        "API_SALESORDER/SalesOrderItem",
        cols(
            "SalesOrder SalesOrderItem Product Plant RequestedDeliveryDate:d "
            "ConfirmedDeliveryDate:d RequestedQuantity:n ConfdDelivQtyInOrderQtyUnit:n "
            "NetAmount:n TransactionCurrency DeliveryStatus SalesOrderItemCategory "
            "RequestedQuantitySAPUnit"
        ),
        ("SalesOrder", "SalesOrderItem"),
        plant="Plant",
        select={
            # The extract carries the currency on the header only.
            "raw": """
                SELECT i.*, h.TransactionCurrency
                FROM {src} i
                LEFT JOIN (SELECT SalesOrder, TransactionCurrency FROM {path(so)}) h
                  USING (SalesOrder)
            """
        },
    ),
    Table(
        "SalesOrder",
        "salesorder/SalesOrder",
        "API_SALESORDER/SalesOrder",
        cols(
            "SalesOrder SalesOrderType SoldToParty SalesOrganization SalesOrderDate:d "
            "RequestedDeliveryDate:d TransactionCurrency DistributionChannel "
            "OrganizationDivision TotalNetAmount:n"
        ),
        ("SalesOrder",),
        scope=("SalesOrderItem", (("SalesOrder", "SalesOrder"),)),
    ),
    # ---------------------------------------------------------------- production and MRP
    Table(
        "ProductionOrder",
        "productionorder/A_ProductionOrder_2",
        "API_PRODUCTION_ORDER_2_SRV/A_ProductionOrder_2",
        cols(
            "ManufacturingOrder ManufacturingOrderType Material ProductionPlant TotalQuantity:n "
            "ProductionUnit MfgOrderPlannedStartDate:d MfgOrderPlannedEndDate:d "
            "MfgOrderScheduledStartDate:d MfgOrderScheduledEndDate:d OrderIsCreated "
            "OrderIsReleased SalesOrder SalesOrderItem"
        ),
        ("ManufacturingOrder",),
        plant="ProductionPlant",
    ),
    Table(
        "ProductionOrderComponent",
        "productionorder/A_ProductionOrderComponent_2",
        "API_PRODUCTION_ORDER_2_SRV/A_ProductionOrderComponent_2",
        cols(
            "Reservation ReservationItem ManufacturingOrder Material Plant StorageLocation "
            "MatlCompRequirementDate:d RequiredQuantity:n WithdrawnQuantity:n BaseUnit "
            "InventorySpecialStockType"
        ),
        ("Reservation", "ReservationItem"),
        plant="Plant",
    ),
    Table(
        "MaterialBOM",
        None,
        "API_BILL_OF_MATERIAL_SRV/MaterialBOM",
        cols(
            "BillOfMaterial BillOfMaterialCategory BillOfMaterialVariant BillOfMaterialVersion "
            "Material Plant BillOfMaterialVariantUsage BOMHeaderBaseUnit "
            "BOMHeaderQuantityInBaseUnit:n ValidityStartDate:d"
        ),
        (
            "BillOfMaterial",
            "BillOfMaterialCategory",
            "BillOfMaterialVariant",
            "BillOfMaterialVersion",
            "Material",
            "Plant",
        ),
        plant="Plant",
    ),
    Table(
        "MaterialBOMItem",
        None,
        "API_BILL_OF_MATERIAL_SRV/MaterialBOMItem",
        cols(
            "BillOfMaterial BillOfMaterialCategory BillOfMaterialVariant BillOfMaterialVersion "
            "BillOfMaterialItemNodeNumber Material Plant BillOfMaterialItemNumber "
            "BillOfMaterialItemCategory BillOfMaterialComponent BillOfMaterialItemQuantity:n "
            "BillOfMaterialItemUnit ValidityStartDate:d"
        ),
        (
            "BillOfMaterial",
            "BillOfMaterialCategory",
            "BillOfMaterialVariant",
            "BillOfMaterialVersion",
            "BillOfMaterialItemNodeNumber",
            "Material",
            "Plant",
        ),
        plant="Plant",
    ),
    Table(
        "PlannedOrder",
        None,
        "OP_PLANNEDORDER_0001/PlannedOrderHeader",
        cols(
            "PlannedOrder PlannedOrderType Material MaterialName MRPPlant ProductionPlant "
            "MRPArea MaterialProcurementCategory MaterialProcurementType TotalQuantity:n "
            "BaseUnit PlndOrderPlannedStartDate:d PlndOrderPlannedEndDate:d "
            "PlannedOrderOpeningDate:d SalesOrder SalesOrderItem MRPController "
            "PurchasingGroup PurchasingOrganization FixedSupplier SupplierName "
            "PlannedOrderIsFirm:b PlannedOrderIsConvertible:b"
        ),
        ("PlannedOrder",),
        plant="MRPPlant",
        optional=True,
    ),
    Table(
        "PlannedOrderComponent",
        None,
        "OP_PLANNEDORDER_0001/PlannedOrderComponent",
        cols(
            "PlannedOrder Reservation ReservationItem Material Plant StorageLocation "
            "MatlCompRequirementDate:d RequiredQuantity:n WithdrawnQuantity:n BaseUnit "
            "BOMItemDescription"
        ),
        ("PlannedOrder", "Reservation", "ReservationItem"),
        plant="Plant",
        optional=True,
    ),
    Table(
        "PlannedIndepRqmt",
        None,
        "API_PLND_INDEP_RQMT_SRV/A_PlannedIndepRqmt",
        cols(
            "Product Plant MRPArea PlngIndepRqmtType PlngIndepRqmtVersion RequirementPlan "
            "RequirementSegment PlngIndepRqmtIsActive:b"
        ),
        (
            "Product",
            "Plant",
            "MRPArea",
            "PlngIndepRqmtType",
            "PlngIndepRqmtVersion",
            "RequirementPlan",
            "RequirementSegment",
        ),
        plant="Plant",
        optional=True,
    ),
    Table(
        "PlannedIndepRqmtItem",
        None,
        "API_PLND_INDEP_RQMT_SRV/A_PlannedIndepRqmtItem",
        cols(
            "Product Plant MRPArea PlngIndepRqmtType PlngIndepRqmtVersion RequirementPlan "
            "RequirementSegment PlngIndepRqmtPeriod PeriodType WorkingDayDate:d "
            "PlannedQuantity:n WithdrawalQuantity:n UnitOfMeasure"
        ),
        (
            "Product",
            "Plant",
            "MRPArea",
            "PlngIndepRqmtType",
            "PlngIndepRqmtVersion",
            "RequirementPlan",
            "RequirementSegment",
            "PlngIndepRqmtPeriod",
            "PeriodType",
        ),
        plant="Plant",
        optional=True,
    ),
    # ---------------------------------------------------------------- confirmations (v4)
    Table(
        "SupplierConfirmationItem",
        None,
        "CE_SUPPLIERCONFIRMATION_0001/ConfirmationItem",
        cols(
            "SupplierConfirmation SupplierConfirmationItem SuplrConfRefPurchaseOrder "
            "SuplrConfRefPurchaseOrderItem SupplierConfirmedNetPrice:n DocumentCurrency "
            "ItemIsRejectedBySupplier:b"
        ),
        ("SupplierConfirmation", "SupplierConfirmationItem"),
        scope=(
            "PurchaseOrderItem",
            (
                ("SuplrConfRefPurchaseOrder", "PurchaseOrder"),
                ("SuplrConfRefPurchaseOrderItem", "PurchaseOrderItem"),
            ),
        ),
        optional=True,
    ),
    Table(
        "SupplierConfirmation",
        None,
        "CE_SUPPLIERCONFIRMATION_0001/Confirmation",
        cols(
            "SupplierConfirmation SuplrConfRefPurchaseOrder SuplrConfProcessingStatus "
            "SuplrConfExternalReference CreationDate:d"
        ),
        ("SupplierConfirmation",),
        scope=("SupplierConfirmationItem", (("SupplierConfirmation",) * 2,)),
        optional=True,
    ),
    Table(
        "SupplierConfirmationLine",
        None,
        "CE_SUPPLIERCONFIRMATION_0001/ConfirmationLine",
        cols(
            "SupplierConfirmation SupplierConfirmationItem SupplierConfirmationLine "
            "DeliveryDate:d DelivDateCategory ConfirmedQuantity:n PurchaseOrderQuantityUnit"
        ),
        ("SupplierConfirmation", "SupplierConfirmationItem", "SupplierConfirmationLine"),
        scope=(
            "SupplierConfirmationItem",
            (("SupplierConfirmation",) * 2, ("SupplierConfirmationItem",) * 2),
        ),
        optional=True,
    ),
    # ---------------------------------------------------------------- business partners
    Table(
        "Customer",
        "salesorder/Customer",
        f"{BP}/A_Customer",
        cols("Customer CustomerName CustomerFullName CustomerAccountGroup DeletionIndicator:b"),
        ("Customer",),
        select={
            # Name from the business partner where the customer record has none.
            "synthetic": """
                SELECT c.* EXCLUDE (CustomerName),
                       coalesce(nullif(c.CustomerName, ''), bp.BusinessPartnerFullName,
                                bp.OrganizationBPName1) AS CustomerName
                FROM {src} c
                LEFT JOIN {path(bp)} bp ON bp.BusinessPartner = c.Customer
            """,
            # No customer master in the extract: sold-to parties without names.
            "raw": "SELECT DISTINCT SoldToParty AS Customer, NULL AS CustomerName FROM {path(so)}",
        },
    ),
    Table(
        "Supplier",
        "supplier/A_Supplier",
        f"{BP}/A_Supplier",
        cols(
            "Supplier SupplierName Country SupplierFullName SupplierAccountGroup "
            "SupplierCorporateGroup PurchasingIsBlocked:b DeletionIndicator:b"
        ),
        ("Supplier",),
        select={
            "synthetic": """
                SELECT s.* EXCLUDE (SupplierName),
                       coalesce(nullif(s.SupplierName, ''), bp.BusinessPartnerFullName,
                                bp.OrganizationBPName1) AS SupplierName,
                       a.Country
                FROM {src} s
                LEFT JOIN {path(bp)} bp ON bp.BusinessPartner = s.Supplier
                LEFT JOIN (SELECT BusinessPartner, any_value(Country) AS Country
                           FROM {path(address)} GROUP BY BusinessPartner) a
                  ON a.BusinessPartner = s.Supplier
            """,
            "raw": "SELECT *, NULL AS Country FROM {src}",
        },
    ),
    Table(
        "BusinessPartner",
        None,
        f"{BP}/A_BusinessPartner",
        cols(
            "BusinessPartner Customer Supplier BusinessPartnerCategory BusinessPartnerGrouping "
            "BusinessPartnerFullName BusinessPartnerName OrganizationBPName1 SearchTerm1 "
            "Language CreationDate:d BusinessPartnerIsBlocked:b IsMarkedForArchiving:b"
        ),
        ("BusinessPartner",),
    ),
    Table(
        "BusinessPartnerAddress",
        None,
        f"{BP}/A_BusinessPartnerAddress",
        cols(
            "BusinessPartner AddressID CityName Country Language ValidityStartDate:d "
            "ValidityEndDate:d"
        ),
        ("BusinessPartner", "AddressID"),
    ),
    Table(
        "CustomerSalesArea",
        None,
        f"{BP}/A_CustomerSalesArea",
        cols(
            "Customer SalesOrganization DistributionChannel Division Currency "
            "CustomerPaymentTerms CustomerABCClassification IncotermsClassification "
            "ShippingCondition CompleteDeliveryIsDefined:b DeletionIndicator:b"
        ),
        ("Customer", "SalesOrganization", "DistributionChannel", "Division"),
    ),
    Table(
        "SupplierCompany",
        "supplier/A_SupplierCompany",
        f"{BP}/A_SupplierCompany",
        cols(
            "Supplier CompanyCode PaymentTerms Currency ReconciliationAccount "
            "SupplierIsBlockedForPosting:b DeletionIndicator:b"
        ),
        ("Supplier", "CompanyCode"),
    ),
    Table(
        "SupplierPurchasingOrg",
        "supplier/A_SupplierPurchasingOrg",
        f"{BP}/A_SupplierPurchasingOrg",
        cols(
            "Supplier PurchasingOrganization IsOrderAcknRqd:b SupplierConfirmationControlKey "
            "MaterialPlannedDeliveryDurn:n PurchaseOrderCurrency PaymentTerms "
            "IncotermsClassification InvoiceIsGoodsReceiptBased:b "
            "PurOrdAutoGenerationIsAllowed:b PurchasingIsBlockedForSupplier:b "
            "SupplierIsReturnsSupplier:b DeletionIndicator:b"
        ),
        ("Supplier", "PurchasingOrganization"),
    ),
    # ---------------------------------------------------------------- product
    Table(
        "Product",
        "product/Product",
        f"{PROD}/Product",
        cols(
            "Product ProductType ProductGroup BaseUnit CreationDate:d CreatedByUser "
            "IsMarkedForDeletion:b ItemCategoryGroup Division IndustrySector"
        ),
        ("Product",),
    ),
    Table(
        "ProductDescription",
        "product/ProductDescription",
        f"{PROD}/ProductDescription",
        cols("Product Language ProductDescription"),
        ("Product", "Language"),
    ),
    Table(
        "ProductPlant",
        "product/ProductPlant",
        f"{PROD}/ProductPlant",
        cols(
            "Product Plant ProfitCenter IsMarkedForDeletion:b IsBatchManagementRequired:b "
            "IsNegativeStockAllowed:b ProductIsCriticalPrt:b GoodsIssueUnit BaseUnit"
        ),
        PP,
        plant="Plant",
    ),
    Table(
        "ProductPlantMRP",
        "product/ProductPlantMRP",
        f"{PROD}/ProductPlantMRP",
        cols(
            "Product Plant MRPArea MRPType MRPResponsible LotSizingProcedure "
            "SafetyStockQuantity:n ReorderThresholdQuantity:n SafetySupplyDurationInDays:n "
            "PlannedDeliveryDurationInDays:n IsPlannedDeliveryTime:b "
            "ProductSafetyTimeMRPRelevance IsMarkedForDeletion:b BaseUnit Currency"
        ),
        ("Product", "Plant", "MRPArea"),
        plant="Plant",
    ),
    Table(
        "ProductPlantSupplyPlanning",
        "product/ProductPlantSupplyPlanning",
        f"{PROD}/ProductPlantSupplyPlanning",
        cols(
            "Product Plant MRPType MRPResponsible ProcurementType ProcurementSubType "
            "LotSizingProcedure PlannedDeliveryDurationInDays:n GoodsReceiptDuration:n "
            "SafetyStockQuantity:n PlanningStrategyGroup SafetySupplyDurationInDays:n "
            "ReorderThresholdQuantity:n AvailabilityCheckType ProdInhProdnDurationInWorkDays:n "
            "BaseUnit Currency"
        ),
        PP,
        plant="Plant",
    ),
    Table(
        "ProductPlantProcurement",
        "product/ProductPlantProcurement",
        f"{PROD}/ProductPlantProcurement",
        cols("Product Plant PurchasingGroup IsAutoPurOrdCreationAllowed:b IsSourceListRequired:b"),
        PP,
        plant="Plant",
    ),
    Table(
        "ProductValuation",
        "product/ProductValuation",
        f"{PROD}/ProductValuation",
        cols(
            "Product ValuationArea ValuationType ValuationClass PriceDeterminationControl "
            "InventoryValuationProcedure StandardPrice:n MovingAveragePrice:n "
            "ProductPriceUnitQuantity:n Currency BaseUnit IsProducedInhouse:b "
            "IsMarkedForDeletion:b"
        ),
        ("Product", "ValuationArea", "ValuationType"),
        plant="ValuationArea",
    ),
    Table(
        "ProductGroupText",
        None,
        "API_PRODUCTGROUP_SRV/A_ProductGroupText",
        cols("ProductGroup Language ProductGroupName ProductGroupText"),
        ("ProductGroup", "Language"),
        optional=True,
    ),
    # ---------------------------------------------------------------- sources of supply
    Table(
        "PurgInfoRecdOrgPlantData",
        "purchasinginforecord/A_PurgInfoRecdOrgPlantData",
        "API_INFORECORD_PROCESS_SRV/A_PurgInfoRecdOrgPlantData",
        cols(
            "PurchasingInfoRecord PurchasingInfoRecordCategory PurchasingOrganization Plant "
            "Material Supplier MaterialGroup PurchasingGroup MaterialPlannedDeliveryDurn:n "
            "NetPriceAmount:n MaterialPriceUnitQty:n Currency IsMarkedForDeletion:b "
            "PurchasingDocumentDate:d CreatedByUser PurgDocOrderQuantityUnit "
            "PurchaseOrderPriceUnit PriceValidityEndDate:d IsOrderAcknRqd:b "
            "SupplierConfirmationControlKey InvoiceIsGoodsReceiptBased:b "
            "UnlimitedOverdeliveryIsAllowed:b IsRelevantForAutomSrcg"
        ),
        ("PurchasingInfoRecord", "PurchasingInfoRecordCategory", "PurchasingOrganization", "Plant"),
        plant="Plant",
    ),
    Table(
        "PurchasingInfoRecord",
        "purchasinginforecord/A_PurchasingInfoRecord",
        "API_INFORECORD_PROCESS_SRV/A_PurchasingInfoRecord",
        cols(
            "PurchasingInfoRecord Supplier Material MaterialGroup CreationDate:d IsDeleted:b "
            "PurgDocOrderQuantityUnit BaseUnit IsRegularSupplier:b"
        ),
        ("PurchasingInfoRecord",),
        scope=("PurgInfoRecdOrgPlantData", (("PurchasingInfoRecord",) * 2,)),
    ),
    Table(
        "ExchangeRate",
        "exchangerate/A_ExchangeRate",
        "API_EXCHANGE_RATE_SRV/A_ExchangeRate",
        cols("SourceCurrency ExchangeRate:n"),
        ("SourceCurrency",),
        select={
            "synthetic": """
                SELECT SourceCurrency,
                       arg_max(ExchangeRate * NumberOfTargetCurrencyUnits
                               / NumberOfSourceCurrencyUnits, ExchangeRateEffectiveDate)
                         AS ExchangeRate
                FROM {src} WHERE TargetCurrency = 'EUR' GROUP BY SourceCurrency
            """
        },
    ),
    # ---------------------------------------------------------------- organisation (v4, I_*)
    Table(
        "Plant",
        None,
        "I_Plant",
        cols("Plant PlantName CompanyCode Country Language"),
        ("Plant",),
        plant="Plant",
        optional=True,
    ),
    Table(
        "CompanyCode",
        None,
        "I_CompanyCode",
        cols("CompanyCode CompanyCodeName Country Currency"),
        ("CompanyCode",),
        optional=True,
    ),
    Table(
        "PurchasingOrganization",
        None,
        "I_PurchasingOrganization",
        cols("PurchasingOrganization PurchasingOrganizationName CompanyCode"),
        ("PurchasingOrganization",),
        optional=True,
    ),
    Table(
        "PurchasingGroup",
        None,
        "I_PurchasingGroup",
        cols("PurchasingGroup PurchasingGroupName PhoneNumber EmailAddress"),
        ("PurchasingGroup",),
        optional=True,
    ),
    Table(
        "StorageLocation",
        None,
        "I_StorageLocation",
        cols("Plant StorageLocation StorageLocationName"),
        ("Plant", "StorageLocation"),
        plant="Plant",
        optional=True,
    ),
    Table(
        "MRPController",
        None,
        "I_MRPController",
        cols("Plant MRPController MRPControllerName PurchasingGroup"),
        ("Plant", "MRPController"),
        plant="Plant",
        optional=True,
    ),
    Table(
        "SalesOrganization",
        None,
        "I_SalesOrganization",
        cols("SalesOrganization SalesOrganizationName CompanyCode"),
        ("SalesOrganization",),
        optional=True,
    ),
)

EXTRA_FILES: dict[str, dict[str, tuple[str, str | None]]] = {
    "raw": {
        "header": ("materialdocument/A_MaterialDocumentHeader", None),
        "so": ("salesorder/SalesOrder", None),
    },
    "synthetic": {
        "header": ("API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader", None),
        "so": ("API_SALESORDER/SalesOrder", None),
        "address": (
            f"{BP}/A_BusinessPartnerAddress",
            "(SELECT NULL::VARCHAR AS BusinessPartner, NULL::VARCHAR AS Country WHERE false)",
        ),
        "bp": (
            f"{BP}/A_BusinessPartner",
            "(SELECT NULL::VARCHAR AS BusinessPartner, NULL::VARCHAR AS BusinessPartnerFullName, "
            "NULL::VARCHAR AS OrganizationBPName1 WHERE false)",
        ),
    },
}


class LoadError(RuntimeError):
    pass


log = logging.getLogger("loader")


def detect_layout(source: Path) -> str:
    if (source / "API_PURCHASEORDER_2" / "PurchaseOrder.parquet").exists():
        return "synthetic"
    if (source / "purchaseorder" / "PurchaseOrder.parquet").exists():
        return "raw"
    raise LoadError(f"{source}: neither a synthetic dataset nor an S/4 extract")


def _parquet(source: Path, rel: str) -> Path:
    return source / f"{rel}.parquet"


def _sql_date(expr: str, kind: str) -> str:
    """ISO date text from DATE, timestamp or '/Date(ms)/' strings; junk years are NULL."""
    if kind == "raw":
        parsed = (
            f"CASE WHEN typeof({expr}) IN ('DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE') "
            f"THEN TRY_CAST({expr} AS DATE) "
            f"ELSE TRY_CAST(to_timestamp(TRY_CAST(regexp_extract(CAST({expr} AS VARCHAR), "
            f"'/Date\\((-?[0-9]+)', 1) AS BIGINT) / 1000) AS DATE) END"
        )
    else:
        parsed = f"TRY_CAST({expr} AS DATE)"
    return (
        f"CASE WHEN year({parsed}) BETWEEN 1900 AND {MAX_YEAR} "
        f"THEN strftime({parsed}, '%Y-%m-%d') END"
    )


def _sql_column(col: Column, available: set[str], layout: str) -> str:
    src = col.source or col.name
    if src not in available:
        return f"NULL AS {col.name}"
    q = f'"{src}"'
    if col.kind == "date":
        expr = _sql_date(q, layout)
    elif col.kind == "num":
        expr = f"TRY_CAST(TRIM(CAST({q} AS VARCHAR)) AS DECIMAL(19, 6))"
    elif col.kind == "int":
        expr = f"TRY_CAST(TRIM(CAST({q} AS VARCHAR)) AS BIGINT)"
    elif col.kind == "bool":
        expr = (
            f"CASE WHEN CAST({q} AS VARCHAR) IN ('true','True','TRUE','X','1') THEN 1 "
            f"WHEN {q} IS NULL THEN NULL ELSE 0 END"
        )
    else:
        expr = f"CAST({q} AS VARCHAR)"
    return f"{expr} AS {col.name}"


def _base_query(table: Table, source: Path, layout: str) -> str | None:
    """DuckDB SQL reading the table's file(s); None when the dataset lacks them."""
    rel = table.raw if layout == "raw" else table.synthetic
    if rel is None:
        return None
    src_file = _parquet(source, rel)
    template = table.select.get(layout, table.select.get("*"))
    if template is None:
        if not src_file.exists():
            return None
        return f"SELECT * FROM read_parquet('{src_file}')"
    if "{src}" in template and not src_file.exists():
        return None
    sql = template.replace("{src}", f"read_parquet('{src_file}')")
    for key, (extra_rel, fallback) in EXTRA_FILES[layout].items():
        token = "{path(" + key + ")}"
        if token in sql:
            path = _parquet(source, extra_rel)
            if path.exists():
                # With a fallback, columns the select needs are NULL when the file lacks them.
                read = f"read_parquet('{path}')"
                if fallback is not None:
                    read = f"(SELECT * FROM {fallback} UNION ALL BY NAME SELECT * FROM {read})"
                sql = sql.replace(token, read)
            elif fallback is not None:
                sql = sql.replace(token, fallback)
            else:
                return None
    return sql
