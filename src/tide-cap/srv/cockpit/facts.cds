namespace tide.cockpit;

using {tide.s4 as s4} from '../../db/s4';

define view ItemReceipt as
    select from s4.MaterialDocumentItem {
        key PurchaseOrder,
        key PurchaseOrderItem,
            min(
                case
                    when GoodsMovementType in ('101', '107') and GoodsMovementIsCancelled = false
                         then PostingDate
                end
            ) as ArrivalDate      : Date,
            min(
                case
                    when GoodsMovementType in ('101', '109') and GoodsMovementIsCancelled = false
                         then PostingDate
                end
            ) as AvailableDate    : Date,
            sum(
                case
                    when GoodsMovementType in ('101', '109') and GoodsMovementIsCancelled = false
                         then QuantityInEntryUnit
                    else 0
                end
            ) as ReceivedQuantity : Double,
            max(
                case
                    when GoodsMovementType = '107' and GoodsMovementIsCancelled = false then 1
                    else 0
                end
            ) as TwoStep          : Integer
    }
    where
            PurchaseOrder is not null
        and PurchaseOrder <> ''
    group by
        PurchaseOrder,
        PurchaseOrderItem;

define view ItemFirstReceipt as
    select from s4.MaterialDocumentItem as m
    inner join ItemReceipt as r
        on  r.PurchaseOrder = m.PurchaseOrder
        and r.PurchaseOrderItem = m.PurchaseOrderItem
        and r.AvailableDate = m.PostingDate
    {
        key m.PurchaseOrder,
        key m.PurchaseOrderItem,
            sum(m.QuantityInEntryUnit) as Quantity : Double,
            min(m.EntryUnit) as MinimumUnit : String(3),
            max(m.EntryUnit) as MaximumUnit : String(3),
            min(case when m.EntryUnit is null or m.EntryUnit = '' then 0 else 1 end)
                as KnownUnit : Integer
    }
    where m.GoodsMovementType in ('101', '109')
        and m.GoodsMovementIsCancelled = false
        and m.QuantityInEntryUnit > 0
    group by m.PurchaseOrder, m.PurchaseOrderItem;

define view ItemSchedule as
    select from s4.PurchaseOrderScheduleLine {
        key PurchaseOrder,
        key PurchaseOrderItem,
            min(ScheduleLineDeliveryDate)  as RequestedDate : Date,
            sum(OpenPurchaseOrderQuantity) as OpenQuantity  : Double
    }
    group by
        PurchaseOrder,
        PurchaseOrderItem;

define view ItemFactSource as
    select from s4.PurchaseOrderItem as i
    inner join s4.PurchaseOrder as h
        on h.PurchaseOrder = i.PurchaseOrder
    left join ItemReceipt as r
        on  r.PurchaseOrder     = i.PurchaseOrder
        and r.PurchaseOrderItem = i.PurchaseOrderItem
    left join ItemFirstReceipt as firstReceipt
        on  firstReceipt.PurchaseOrder = i.PurchaseOrder
        and firstReceipt.PurchaseOrderItem = i.PurchaseOrderItem
    left join ItemSchedule as sl
        on  sl.PurchaseOrder     = i.PurchaseOrder
        and sl.PurchaseOrderItem = i.PurchaseOrderItem
    left join s4.Supplier as sup
        on sup.Supplier = h.Supplier
    left join s4.ProductPlantSupplyPlanning as pp
        on  pp.Product = i.Material
        and pp.Plant   = i.Plant
    left join s4.ExchangeRate as fx
        on fx.SourceCurrency = i.DocumentCurrency
    {
        key i.PurchaseOrder,
        key i.PurchaseOrderItem,
            i.Material,
            i.MaterialGroup,
            i.MaterialType,
            i.Plant,
            h.Supplier,
            sup.Country                                                  as SupplierCountry  : String(3),
            h.PurchasingGroup,
            pp.MRPResponsible                                            as MRPController    : String(3),
            h.PurchaseOrderType,
            case
                when i.PurchaseOrderItemCategory = '5'
                     then 'third_party'
                when i.AccountAssignmentCategory is not null
                     and i.AccountAssignmentCategory <> ''
                     then 'consumable'
                else 'stock'
            end                                                          as Category         : String(12),
            i.OrderQuantity,
            i.PurchaseOrderQuantityUnit                                  as Unit             : String(3),
            i.NetAmount,
            i.DocumentCurrency                                           as Currency         : String(5),
            case
                when i.DocumentCurrency = 'EUR'
                     then i.NetAmount
                else i.NetAmount * fx.ExchangeRate
            end                                                          as NetAmountEUR     : Double,
            i.PlannedDeliveryDurationInDays                              as PlannedDays      : Double,
            i.GoodsReceiptDurationInDays                                 as GRDays           : Double,
            i.PurchasingInfoRecord,
            h.PurchaseOrderDate,
            month(h.PurchaseOrderDate)                                   as PurchaseOrderMonth : Integer,
            sl.RequestedDate,
            days_between(h.PurchaseOrderDate, sl.RequestedDate)          as RequestedGapDays : Integer,
            r.ArrivalDate,
            r.AvailableDate,
            days_between(h.PurchaseOrderDate, r.AvailableDate)           as LeadTimeDays     : Integer,
            days_between(h.PurchaseOrderDate, r.ArrivalDate)             as ArrivalDays      : Integer,
            coalesce(r.ReceivedQuantity, 0)                              as ReceivedQuantity : Double,
            coalesce(r.TwoStep, 0)                                       as TwoStep          : Integer,
            coalesce(sl.OpenQuantity, 0)                                 as OpenQuantity     : Double,
            case
                when coalesce(i.PurchasingDocumentDeletionCode, '') = ''
                     and coalesce(i.IsCompletelyDelivered, false) = false
                     and coalesce(sl.OpenQuantity, 0) > 0
                     and coalesce(i.IsReturnsItem, false) = false
                     then true
                else false
            end                                                          as IsOpen           : Boolean,
            case
                 when firstReceipt.KnownUnit = 1 and i.OrderQuantity > 0
                     and firstReceipt.MinimumUnit = i.PurchaseOrderQuantityUnit
                     and firstReceipt.MaximumUnit = i.PurchaseOrderQuantityUnit
                     and firstReceipt.Quantity < i.OrderQuantity
                     then true
                 when firstReceipt.KnownUnit = 1 and i.OrderQuantity > 0
                     and firstReceipt.MinimumUnit = i.PurchaseOrderQuantityUnit
                     and firstReceipt.MaximumUnit = i.PurchaseOrderQuantityUnit
                     then false
                 else null
            end                                                          as PartialFirstReceipt : Boolean
    };
