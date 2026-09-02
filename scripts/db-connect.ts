/**
 * Start the dev-only DB bastion if it's stopped, SSH into it through the existing
 * EC2 Instance Connect Endpoint with a local port-forward to Postgres, and drop into
 * an interactive `psql` session -- README.md's "Connecting to the database" (bastion
 * path), as one command. Stops the bastion again once the session ends.
 *
 * `aws ec2-instance-connect open-tunnel` only supports remote port 22/3389 (AWS-
 * enforced), so it can't reach Postgres directly -- hence the bastion hop, via the
 * documented `aws ec2-instance-connect ssh --local-forwarding` helper, which handles
 * ephemeral SSH key generation/pushing itself (no key management needed here).
 *
 * Usage: `npm run db:connect [-- <database>]` (honors CDK_STAGE, default 'dev';
 * database defaults to 'postgres', the maintenance DB -- `\c agent_hr` from there,
 * or pass a database name directly). Needs AWS creds in VECTOR_DB_ALLOWED_PRINCIPALS,
 * the AWS CLI, and `psql`. Dev only -- the bastion doesn't exist in prod.
 */
import { execSync, spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';

const stage = process.env.CDK_STAGE ?? 'dev';
const database = process.argv[2] ?? 'postgres';
const LOCAL_PORT = 5432;
const BOOT_TIMEOUT_MS = 60_000;

try {
  process.loadEnvFile(path.join(__dirname, '..', `.env.${stage}`));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
const regionFlag = process.env.CDK_REGION ? `--region "${process.env.CDK_REGION}"` : '';

function ssmParam(name: string): string {
  return execSync(
    `aws ssm get-parameter ${regionFlag} --name "/cloudrag/${stage}/core/${name}" --query Parameter.Value --output text`,
    { encoding: 'utf8' },
  ).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instanceState(instanceId: string): string {
  return execSync(
    `aws ec2 describe-instances ${regionFlag} --instance-ids "${instanceId}" `
    + `--query "Reservations[0].Instances[0].State.Name" --output text`,
    { encoding: 'utf8' },
  ).trim();
}

/** Starts the bastion if it's stopped, then waits for it to report 'running'. */
async function ensureRunning(instanceId: string): Promise<void> {
  const initial = instanceState(instanceId);
  if (initial === 'running') return;

  if (initial === 'stopped') {
    console.log('Starting the DB bastion (stopped when not in use)...');
    execSync(`aws ec2 start-instances ${regionFlag} --instance-ids "${instanceId}"`, { stdio: 'ignore' });
  }

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (instanceState(instanceId) !== 'running') {
    if (Date.now() > deadline) throw new Error(`bastion never reached 'running' (started from '${initial}')`);
    await sleep(3_000);
  }
  // 'running' means the instance state, not that sshd is accepting connections yet
  console.log('Waiting for the bastion to finish booting...');
  await sleep(10_000);
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.end(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`forward never came up on 127.0.0.1:${port}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function main() {
  console.log(`Resolving the '${stage}' database bastion...`);
  const endpointId = ssmParam('instance-connect-endpoint-id');
  const bastionId = ssmParam('bastion-instance-id');
  const endpoint = ssmParam('endpoint');
  const port = ssmParam('port');
  const secretArn = ssmParam('secret-arn');

  await ensureRunning(bastionId);

  console.log('Opening SSH local forward via the EC2 Instance Connect Endpoint...');
  const ssh = spawn('aws', [
    'ec2-instance-connect', 'ssh',
    ...(process.env.CDK_REGION ? ['--region', process.env.CDK_REGION] : []),
    '--instance-id', bastionId,
    '--connection-type', 'eice',
    '--eice-options', `endpointId=${endpointId}`,
    '--local-forwarding', `${LOCAL_PORT}:${endpoint}:${port}`,
    // `aws ec2-instance-connect ssh` doesn't expose ssh's own -N ("forward only, no
    // shell") flag. With stdin ignored/closed, ssh sees EOF immediately, decides
    // there's nothing to do, and exits cleanly (code 0) -- taking the forward down
    // with it before it's even usable. Piping stdin and never writing to or closing
    // it keeps the (pty-less, shell-less) session open until we explicitly kill it.
  ], { stdio: ['pipe', 'ignore', 'inherit'] });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    ssh.kill();
    try {
      console.log('Stopping the DB bastion...');
      execSync(`aws ec2 stop-instances ${regionFlag} --instance-ids "${bastionId}"`, { stdio: 'ignore' });
    } catch (err) {
      console.error(`Warning: failed to stop the bastion (${bastionId}) -- stop it manually to avoid idle cost.`);
      console.error(err instanceof Error ? err.message : err);
    }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  ssh.on('exit', (code) => {
    if (!cleanedUp) {
      console.error(`ssh process exited early (code ${code})`);
      process.exit(1);
    }
  });

  await waitForPort(LOCAL_PORT, 20_000);

  const secretJson = execSync(
    `aws secretsmanager get-secret-value ${regionFlag} --secret-id "${secretArn}" --query SecretString --output text`,
    { encoding: 'utf8' },
  );
  const { username, password } = JSON.parse(secretJson);

  console.log(`Connecting to '${database}' as ${username}...\n`);
  const psql = spawn('psql', ['-h', '127.0.0.1', '-p', String(LOCAL_PORT), '-U', username, '-d', database], {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: password },
  });

  psql.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
