using {tide.core as core} from '../db/core';

@protocol: 'none'
@requires: 'user'
service CoreService {
    function listFeeds()                                               returns many core.Feed;
    function describeFeed(feed: String not null)                       returns core.FeedDescription;
    function getRun(runId: UUID not null, top: Integer, skip: Integer) returns core.Run;
    action   predict(spec: core.DatasetSpec not null, force: Boolean)  returns core.Run;

    /** Queued worker step: executes one run against tabular (internal). */
    action   executeRun(runId: UUID not null);

    event runSucceeded : core.RunSucceeded;
}
