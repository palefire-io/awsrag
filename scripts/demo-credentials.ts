/**
 * Print the demo login details for a stage: the app URL, every demo username, and
 * the shared password.
 *
 * The password is generated at deploy time and held in Secrets Manager -- it is
 * deliberately absent from the CloudFormation template and from every stack output
 * (see lib/stacks/auth-stack.ts), so this script is the way to read it back.
 *
 * Usage: `npm run demo:creds` (honors CDK_STAGE, default 'dev'). Dev only -- demo
 * users are never created for prod. Needs AWS creds and the AWS CLI.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

const stage = process.env.CDK_STAGE ?? 'dev';

try {
  process.loadEnvFile(path.join(__dirname, '..', `.env.${stage}`));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

if (stage === 'prod') {
  console.error('No demo users exist in prod -- they are only created for non-prod stages.');
  process.exit(1);
}

// execFileSync with an argument array: no shell, so nothing here can be re-parsed
// as a command however the .env or the stack outputs are populated.
const regionArgs = process.env.CDK_REGION ? ['--region', process.env.CDK_REGION] : [];

function aws(args: string[]): string {
  return execFileSync('aws', [...args, ...regionArgs], { encoding: 'utf8' }).trim();
}

function stackOutput(stackName: string, key: string): string {
  return aws([
    'cloudformation', 'describe-stacks',
    '--stack-name', stackName,
    '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`,
    '--output', 'text',
  ]);
}

let appUrl: string;
let usernames: string;
let secretArn: string;
try {
  appUrl = stackOutput(`CloudRAG-${stage}`, 'AppUrl');
  usernames = stackOutput(`CloudRAGAuth-${stage}`, 'DemoUsernames');
  secretArn = stackOutput(`CloudRAGAuth-${stage}`, 'DemoPasswordSecretArn');
} catch {
  console.error(`Couldn't read the stack outputs -- is the '${stage}' stage deployed?`);
  process.exit(1);
}

if (!secretArn) {
  console.error(`No demo password secret in CloudRAGAuth-${stage}. Redeploy the Auth stack.`);
  process.exit(1);
}

const password = aws([
  'secretsmanager', 'get-secret-value',
  '--secret-id', secretArn,
  '--query', 'SecretString',
  '--output', 'text',
]);

const names = usernames.split(',').map((u) => u.trim()).filter(Boolean);

console.log(`\n  Sign in at   ${appUrl}`);
console.log(`  Password     ${password}`);
console.log(`               (shared by all ${names.length} accounts below)\n`);
console.log('  Usernames');
for (const name of names) console.log(`    ${name}`);
console.log('\n  These are shared, long-lived demo accounts on a public endpoint.');
console.log('  Do not put anything real behind them.\n');
