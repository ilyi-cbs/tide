using {CockpitMcpService} from './cockpit-mcp-service';

/** Agent runtime support for the chat apps; never exposed to a model. */
@protocol: 'rest'
@path    : 'assistant-runtime'
@requires: 'user'
service AssistantRuntimeService {
    type Profile {
        app         : String;
        /** true: tool results are reduced for the model and answers are checked. */
        checked     : Boolean;
        /** Tools whose success means an action was prepared. */
        actionTools : many String;
        /** End-of-turn checks (JSON: texts and patterns the agent applies). */
        checks      : LargeString;
    }

    type ContextResolution {
        valid            : Boolean;
        profile          : String(64);
        canonicalContext : LargeString;
        instructions     : LargeString;
    }

    action profile(app: String not null)                                 returns Profile;

    /** Validates and canonicalizes one browser-supplied page context under the caller's scope. */
    action resolve_context(app: String not null, context: LargeString not null) returns ContextResolution;

    /** Reads a committed tool command; payloadMatched=true certifies the exact arguments (without commandID, omitted optional fields as null). */
    action command_result(tool: String not null,
                          commandID: String(128) not null,
                          arguments: LargeString not null)                returns CockpitMcpService.WorkflowCommandResult;
}
