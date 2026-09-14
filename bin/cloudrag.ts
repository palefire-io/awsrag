#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreStack } from '../lib/stacks/core-stack';
import { AppStack } from '../lib/stacks/app-stack';
import { AgentSiloStack } from '../lib/stacks/agent-silo-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { agentSilos, demoIdentities } from '../config/agent-silos';

const stage = process.env.CDK_STAGE ?? 'dev';

try {
  process.loadEnvFile(`.env.${stage}`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const app = new cdk.App();
const env = { account: process.env.CDK_ACCOUNT, region: process.env.CDK_REGION };
const tags = { Stage: stage };

const allowedPrincipalArns = (process.env.VECTOR_DB_ALLOWED_PRINCIPALS ?? '')
  .split(',')
  .map((arn) => arn.trim())
  .filter((arn) => arn.length > 0);

// shared data plane
const core = new CoreStack(app, `CloudRAGCore-${stage}`, {
  env,
  tags,
  stage,
  allowedPrincipalArns,
});

// Cognito user pool minting the role claims the orchestrator filters RAG results by
const auth = new AuthStack(app, `CloudRAGAuth-${stage}`, {
  env,
  tags,
  stage,
  agentSilos,
  demoIdentities,
});

// multi-agent orchestrator + chat/admin SPA
const appStack = new AppStack(app, `CloudRAG-${stage}`, {
  env,
  tags,
  stage,
  coreVpc: core.vpc,
  coreSecurityGroup: core.securityGroup,
  coreSecret: core.instance.secret!,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  pendingDocumentsTable: core.pendingDocumentsTable,
});
appStack.addStackDependency(core);
appStack.addStackDependency(auth);

// one stack per specialist agent (see config/agent-silos.ts)
for (const config of agentSilos) {
  const silo = new AgentSiloStack(app, `CloudRAG-${stage}-agent-${config.id}`, {
    env,
    tags: { ...tags, Agent: config.id },
    stage,
    config,
    ingestQueue: core.ingestQueue,
    siloProviderServiceToken: core.siloProviderServiceToken,
  });
  silo.addStackDependency(core);
}
