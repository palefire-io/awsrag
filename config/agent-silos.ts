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
  /** Every document is auto-tagged with *every* role the silo declares — visible to
   *  anyone holding at least one of them, not to Unauthenticated callers. */
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
// silos would make a grant in one silo silently confer access in the other, so values
// are namespaced per silo ("Veridia-User", "HR-User") and must stay globally unique.
export enum VeridiaRole {
  User = 'Veridia-User',
  ExecTeam = 'Veridia-Exec-Team',
}

export enum HrRole {
  User = 'HR-User',
  HRManager = 'HR-Manager',
  ExecTeam = 'HR-Exec-Team',
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
  /**
   * Seniority, ordered MOST JUNIOR FIRST: holding a role grants everything
   * declared before it. With `[User, Manager, Exec]`, an Exec sees Manager and
   * User documents too.
   *
   * Applied when a query runs, not when a document is ingested, so a document
   * stores only the *minimum* role that may see it. Rewriting this ladder
   * changes who sees what immediately, with no need to re-tag stored rows.
   */
  roleLadder?: string[];
  /**
   * Filename prefix -> role, for silos that classify documents on ingest.
   * The corpus names pre-classified files `<Prefix>__<slug>.<ext>`; a file whose
   * prefix is listed here is persisted straight away with that single role, and
   * anything unrecognised is staged for a human instead (see IngestWorkflow).
   */
  autoClassifyPrefixes?: Record<string, string>;
}

export const agentSilos: AgentSiloConfig[] = [
  {
    id: 'veridia',
    displayName: 'Veridia',
    promptModule: 'default',
    roles: VeridiaRole,
    ingestWorkflow: IngestWorkflow.AllUser,
    roleLadder: [VeridiaRole.User, VeridiaRole.ExecTeam],
  },
  {
    id: 'hr',
    displayName: 'HR Assistant',
    promptModule: 'hr',
    roles: HrRole,
    ingestWorkflow: IngestWorkflow.UIMediated,
    roleLadder: [HrRole.User, HrRole.HRManager, HrRole.ExecTeam],
    // The corpus prefixes predate the per-silo role namespacing, so this map is
    // what reconciles "Exec-Team__" on disk with the "HR-Exec-Team" group.
    autoClassifyPrefixes: {
      'User': HrRole.User,
      'HR-Manager': HrRole.HRManager,
      'Exec-Team': HrRole.ExecTeam,
    },
  },
];

/** A dev-only demo login. */
export interface DemoIdentity {
  username: string;
  groups: string[];
}

/**
 * Dev-only demo identities holding more than one role.
 *
 * The per-(silo, role) accounts the Auth stack derives show a single role's view.
 * These show what happens when roles combine — the only way to see that cross-silo
 * access now needs an explicit grant per silo, and that roles union within a silo
 * rather than overriding one another.
 */
export const demoIdentities: DemoIdentity[] = [
  // the same nominal role in both silos — two grants now, where one used to do
  { username: 'both-silos-user', groups: [VeridiaRole.User, HrRole.User] },
  // the case that used to be a single shared 'Exec-Team' group
  { username: 'both-silos-exec', groups: [VeridiaRole.ExecTeam, HrRole.ExecTeam] },
  // two roles inside one silo: sees HR-User *and* HR-Manager documents
  { username: 'hr-manager-plus', groups: [HrRole.User, HrRole.HRManager] },
];
