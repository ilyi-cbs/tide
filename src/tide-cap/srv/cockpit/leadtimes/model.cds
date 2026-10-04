namespace tide.cockpit;

using {tide.cockpit as c} from '../db';
using {PurchasingDeskService} from '../../purchasing-desk-service';
using from '../kernel/kernel';

define view PlannedTimeCases as
    select from c.Cases as header
    left join c.SupplierPlannedTimes as info
        on info.header.ID = header.ID
    left join c.MaterialPlannedTimes as master
        on master.header.ID = header.ID
    {
        key header.ID        as header_ID,
            header.ID        as caseID,
            header.kind      as caseKind,
            header.title     as caseTitle,
            header.priority  as casePriority,
            header.status    as caseStatus,
            header.listing   as caseListing,
            header.attention as caseAttention,
            coalesce(
                info.Material, master.material
            )                as Material     : String(40),
            header.Plant,
            header.PurchasingGroup,
            info.supplier    as Supplier,
            case
                when header.kind = 'supplier_planned_time'
                     then 'Info Record'
                else 'Material Master'
            end              as recordType   : String(30),
            coalesce(
                info.currentDays, master.currentDays
            )                as currentDays  : Double,
            coalesce(
                info.proposedDays, master.proposedDays
            )                as proposedDays : Integer
    }
    where
        header.kind in (
            'supplier_planned_time', 'material_planned_time'
        );

entity SettingRange {
    key Material : String(40);
    key Supplier : String(10);
    key Plant    : String(4);
        asOf     : Date;
        result   : LargeString;
}

entity PdtDetail {
    key finding              : Association to one c.Finding;
        proposalDays         : Integer;
        proposalQuantile     : Double;
        proposalRule         : String(300);
        currentDays          : Double;
        currentFrom          : String(30);
        masterDays           : Double;
        purchasingInfoRecord : String(20);
        ownDeliveries        : Integer;
        p10                  : Double;
        p50                  : Double;
        p80                  : Double;
        p90                  : Double;
        orders12m            : Integer;
        value12mEUR          : Double;
        rangeSource          : c.Source;
        rangeCount           : Integer;
        rangeP10             : Double;
        rangeP50             : Double;
        rangeP80             : Double;
        rangeP90             : Double;
        rangeSentence        : String(300);
}

entity MmPdtDetail {
    key finding      : Association to one c.Finding;
        proposalDays : Integer;
        proposalRule : String(300);
        masterDays   : Double;
        masterFlag   : String(20);
        difference   : Double;
        tolerance    : Double;
        orders12m    : Integer;
        note         : String(300);
}

entity MmPdtSource {
    key finding        : Association to one MmPdtDetail;
    key supplier       : String(10);
        supplierName   : String(120);
        orders12m      : Integer;
        orderShare     : Double;
        ownDeliveries  : Integer;
        typicalDays    : Double;
        infoRecordDays : Double;
        source         : c.Source;
        pdtFindingID   : String(120);
}

extend MmPdtDetail with {
    sources : Composition of many MmPdtSource
                  on sources.finding = $self;
}

extend service PurchasingDeskService with {
    @readonly
    entity PlannedTimes as projection on PlannedTimeCases;

    @readonly
    entity PdtDetails   as projection on PdtDetail;

    @readonly
    entity MmPdtDetails as projection on MmPdtDetail;

    @readonly
    entity MmPdtSources as projection on MmPdtSource;
}

extend PurchasingDeskService.Findings with columns {
    pdtDetail   : Association to one PurchasingDeskService.PdtDetails
                      on pdtDetail.finding = $self,
    mmPdtDetail : Association to one PurchasingDeskService.MmPdtDetails
                      on mmPdtDetail.finding = $self
};

extend PurchasingDeskService.Findings with actions {
    /**
     * Adds the proposal of a planned delivery time finding (lists pdt and
     * mm_pdt) to the change list; an already pending line is returned.
     */
    action addToChangeList() returns PurchasingDeskService.Actions;
};

extend PurchasingDeskService.SupplierPlannedTimeFindings with actions {
    action addToChangeList() returns PurchasingDeskService.Actions;
};

extend PurchasingDeskService.MaterialMasterPlannedTimeFindings with actions {
    action addToChangeList() returns PurchasingDeskService.Actions;
};
