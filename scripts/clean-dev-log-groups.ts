/**
 * Delete dev Lambda log groups before deploy so CDK's explicit `logs.LogGroup` constructs
 * (fixed-named, in core-stack.ts) never collide with a group AWS already created — e.g. one
 * left behind by a rolled-back deploy, or auto-created by an invocation that predates the
 * explicit LogGroup resource. Dev-only: retention is a week and removalPolicy is DESTROY,
 * so there's nothing worth preserving. Refuses to run for any other stage.
 *
 * Usage: `npm run logs:clean-dev` (also runs automatically before `npm run deploy:dev`).
 */
import { execSync } from 'child_process';

const stage = process.env.CDK_STAGE ?? 'dev';
if (stage !== 'dev') {
  console.error(`Refusing to run: CDK_STAGE is '${stage}', this script only ever touches dev.`);
  process.exit(1);
}

const logGroupNames = [
  `/aws/lambda/cloudrag-${stage}-vector-indexer`,
  `/aws/lambda/cloudrag-${stage}-silo-provisioner`,
];

for (const name of logGroupNames) {
  try {
    execSync(`aws logs delete-log-group --log-group-name "${name}"`, { stdio: 'pipe' });
    console.log(`Deleted ${name}`);
  } catch (err: any) {
    const message = err?.stderr?.toString() ?? '';
    if (message.includes('ResourceNotFoundException')) {
      console.log(`Already gone: ${name}`);
    } else {
      console.error(`Failed to delete ${name}:\n${message}`);
      process.exit(1);
    }
  }
}
