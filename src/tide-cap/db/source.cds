namespace tide.source;

entity SourceLoads {
  key ID                   : UUID;
      sourceSystem         : String(80) not null;
      sourceType           : String(10) enum { actual; demo; } not null;
      asOf                 : Date not null;
      ingestedAt           : Timestamp not null;
      contentIdentity      : String(128) not null;
      schemaVersion        : String(80) not null;
      normalizationVersion : String(80) not null;
      trusted              : Boolean not null;
      completeness         : String(20) not null;
      quality              : LargeString;
}

entity SourcePublications {
  key name          : String(80);
      load          : Association to SourceLoads not null;
      inputRevision : String(128) not null;
      version       : Integer not null default 0;
}

entity IngestOperations {
  key ID             : UUID;
      batchIdentity  : String(128) not null;
      baseRevision   : String(128);
      targetRevision : String(128) not null;
      stageResults   : LargeString;
      status         : String(20) not null;
      correlation    : String(128);
}
