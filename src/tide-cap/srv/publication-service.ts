import cds from "@sap/cds";

export default class PublicationService extends cds.ApplicationService {
  async init() {
    for (const operation of ["prepareDay", "overview", "publicationHistory"]) {
      this.on(operation, async (req: cds.Request) => {
        const cockpit = await cds.connect.to("PurchasingDeskService");
        return cockpit.tx(req).send(operation, req.data);
      });
    }
    return super.init();
  }
}
