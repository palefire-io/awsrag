/**
 * Agent Silos — the specialist RAG agents this deployment hosts.
 *
 * This array is the single source of truth. `bin/cloudrag.ts` loops it to
 * synthesize one `AgentSiloStack` per entry (an ingest bucket + a provisioned
 * `agent_<id>` database + an SSM registry entry). The shared orchestrator reads
 * the registry and surfaces each agent as a selectable model in the chat UI.
 *
 * Add an agent: add an entry,
 * then `npm run deploy:dev`. If the entry reuses an
 * existing `promptModule` no orchestrator redeploy is needed. Remove an agent:
 * `cdk destroy` its stack FIRST, then delete the entry (see README).
 */

/**
 * Global, fixed role sentinels — never redefined per silo. `Unauthenticated` is the
 * implicit state when no/invalid Cognito token is presented (never an actual Cognito
 * group); `Superuser` always bypasses every silo's document-level role filter.
 */
export enum Role {
  Unauthenticated = 'Unauthenticated',
  Superuser = 'Superuser',
}

/** How a silo's ingested documents get their `allowed_roles`. */
export enum IngestWorkflow {
  /** Every document is auto-tagged with that silo's `User` role — visible to anyone
   *  holding at least `User`, not to Unauthenticated callers. Requires the silo's
   *  role enum to include a role named exactly `User`. */
  AllUser = 'AllUser',
  /** Documents are staged in DynamoDB (not written to the vector database) until an
   *  admin UI (not built yet) picks which roles can see them. */
  UIMediated = 'UIMediated',
}

// Each silo's role enum's string VALUES are the literal Cognito Group names — there is
// no separate id/translation layer, so `cognito:groups` claims can be used directly as
// the `allowed_roles` filter. Keys are just TS identifiers (no spaces allowed); values
// carry the real display/group name. Cognito group names may not contain spaces (must
// match `[\p{L}\p{M}\p{S}\p{N}\p{P}]+`), so use hyphens instead. A name reused across
// silos (e.g. "Exec-Team") is still just one shared Cognito Group.
export enum VeridiaRole {
  User = 'User',
  ExecTeam = 'Exec-Team',
}

export enum HrRole {
  User = 'User',
  HRManager = 'HR-Manager',
  ExecTeam = 'Exec-Team',
}

export interface AgentSiloConfig {
  /** Stable slug — becomes the model id, database name (`agent_<id>`), SSM key, and stack id. */
  id: string;
  /** Shown in the chat UI's model list. */
  displayName: string;
  /** Key into the orchestrator's prompt registry (services/orchestrator/app/prompts). */
  promptModule: string;
  /** This silo's role enum (e.g. `VeridiaRole`, `HrRole`) — pass the enum object itself. */
  roles: Record<string, string>;
  /** How ingested documents get their `allowed_roles` — see IngestWorkflow. */
  ingestWorkflow: IngestWorkflow;
  /** Optional per-agent model override (defaults to the orchestrator's DEFAULT_LLM_MODEL_ID). */
  llmModelId?: string;
  /** Optional per-agent PII redaction toggle (defaults to true). */
  redactPii?: boolean;
}

export const agentSilos: AgentSiloConfig[] = [
  {
    id: 'veridia',
    displayName: 'Veridia',
    promptModule: 'default',
    roles: VeridiaRole,
    ingestWorkflow: IngestWorkflow.AllUser,
  },
  {
    id: 'hr',
    displayName: 'HR Assistant',
    promptModule: 'hr',
    roles: HrRole,
    ingestWorkflow: IngestWorkflow.UIMediated,
  },
];
