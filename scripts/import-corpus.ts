/**
 * Upload a corpus directory into its Agent Silo's ingest bucket, triggering the
 * normal S3 -> SQS -> vector indexer pipeline for every file (see "Ingesting
 * documents" in README.md).
 *
 * Usage: `npm run corpus:import -- <agentId>` (honors CDK_STAGE, default 'dev').
 * Reads from `corpora/<agentId>_corpus/`. Skips `manifest.json` (corpus metadata,
 * not a document) and dotfiles (e.g. `.DS_Store`). Needs AWS creds.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { agentSilos } from '../config/agent-silos';

const stage = process.env.CDK_STAGE ?? 'dev';
const agentId = process.argv[2];

try {
  process.loadEnvFile(path.join(__dirname, '..', `.env.${stage}`));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
const region = process.env.CDK_REGION;

if (!agentId) {
  console.error('Usage: npm run corpus:import -- <agentId>');
  console.error(`Known silos: ${agentSilos.map((a) => a.id).join(', ')}`);
  process.exit(1);
}
if (!agentSilos.some((a) => a.id === agentId)) {
  console.error(`'${agentId}' is not declared in config/agent-silos.ts (known: ${agentSilos.map((a) => a.id).join(', ')})`);
  process.exit(1);
}

const corpusDir = path.join(__dirname, '..', 'corpora', `${agentId}_corpus`);
if (!fs.existsSync(corpusDir)) {
  console.error(`No corpus directory at ${corpusDir}`);
  process.exit(1);
}

const regionFlag = region ? `--region "${region}"` : '';
const bucketParam = `/cloudrag/${stage}/agents/${agentId}/bucket`;

let bucket: string;
try {
  bucket = execSync(
    `aws ssm get-parameter ${regionFlag} --name "${bucketParam}" --query Parameter.Value --output text`,
    { encoding: 'utf8' },
  ).trim();
} catch {
  console.error(`No bucket registered at ${bucketParam} -- is the '${agentId}' silo deployed?`);
  process.exit(1);
}

console.log(`Uploading ${corpusDir} -> s3://${bucket}/`);
execSync(
  `aws s3 sync ${regionFlag} "${corpusDir}" "s3://${bucket}/" --exclude "manifest.json" --exclude ".*"`,
  { stdio: 'inherit' },
);
console.log("Done. Each upload enqueues an ingest message -- check the vector indexer's CloudWatch logs, "
  + `or the '${agentId}' agent's Postgres database (or the DynamoDB staging table, for UIMediated silos), for progress.`);
