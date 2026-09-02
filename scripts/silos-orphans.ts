/**
 * Flag orphaned Agent Silo stacks — deployed to the account but no longer declared in
 * config/agent-silos.ts. Removing a config entry does NOT tear its stack down, so this
 * catches the leftover before it quietly keeps billing.
 *
 * Usage: `npm run silos:orphans` (honors CDK_STAGE, default 'dev'). Needs AWS creds.
 */
import { execSync } from 'child_process';
import { agentSilos } from '../config/agent-silos';

const stage = process.env.CDK_STAGE ?? 'dev';
const prefix = `CloudRAG-${stage}-agent-`;
const declared = new Set(agentSilos.map((a) => `${prefix}${a.id}`));

const query = `StackSummaries[?starts_with(StackName, '${prefix}')].StackName`;
const out = execSync(
  `aws cloudformation list-stacks --stack-status-filter ` +
    `CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE ` +
    `--query "${query}" --output text`,
  { encoding: 'utf8' },
);
const deployed = out.split(/\s+/).filter(Boolean);
const orphans = deployed.filter((name) => !declared.has(name));

if (orphans.length) {
  console.error('Orphaned agent stacks (deployed but not in config/agent-silos.ts):');
  for (const name of orphans) {
    console.error(`  - ${name}   (destroy: CDK_STAGE=${stage} npx cdk destroy ${name})`);
  }
  process.exit(1);
} else {
  console.log(`No orphaned agent stacks for stage '${stage}'.`);
}
