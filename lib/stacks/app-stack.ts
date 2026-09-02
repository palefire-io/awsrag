import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const APP_VPC_CIDR = '10.1.0.0/16';
const DEFAULT_LLM_MODEL_ID = 'google.gemma-3-4b-it';
const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';

export interface AppStackProps extends cdk.StackProps {
  stage: string;
  /** The Core (isolated) VPC, peered to for Postgres access. */
  coreVpc: ec2.IVpc;
  /** The Core database security group; the app tier is granted ingress to Postgres on it. */
  coreSecurityGroup: ec2.ISecurityGroup;
  /** The shared RDS-managed secret the orchestrator reads DB credentials from. */
  coreSecret: secretsmanager.ISecret;
  /** Cognito User Pool the orchestrator verifies caller JWTs against. */
  userPoolId: string;
  /** Cognito User Pool Client id (the token's `aud`/`client_id`). */
  userPoolClientId: string;
  /** Staging table for UIMediated-workflow documents awaiting role selection. */
  pendingDocumentsTable: dynamodb.ITable;
}

/**
 * The app tier: one multi-agent orchestrator (FastAPI + Pydantic AI) that also serves
 * the chat + admin SPA directly -- there's no separate frontend service. The SPA logs
 * in against Cognito itself and attaches the caller's own token to every request, so
 * the orchestrator authenticates every route by verifying that token (see auth.py)
 * rather than trusting a shared secret from an intermediary.
 *
 * The orchestrator discovers Agent Silos from SSM, surfaces each as a selectable model,
 * and routes each request to that agent's database + prompt module. Runs in its own VPC
 * (public + private-with-egress), peered to the isolated Core VPC; Bedrock via NAT.
 */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const {
      stage, coreVpc, coreSecurityGroup, coreSecret,
      userPoolId, userPoolClientId, pendingDocumentsTable,
    } = props;
    const isProd = stage === 'prod';

    // app VPC — non-overlapping CIDR with the Core VPC (10.0.0.0/16); 2 AZs min for the ALB
    const vpc = new ec2.Vpc(this, 'AppVpc', {
      ipAddresses: ec2.IpAddresses.cidr(APP_VPC_CIDR),
      maxAzs: isProd ? 3 : 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // peer to the isolated Core VPC and route both CIDRs across it. (A non-public RDS
    // endpoint resolves to its private IP, so no peering DNS option is needed — the
    // routes below make that private IP reachable.)
    const peering = new ec2.CfnVPCPeeringConnection(this, 'CorePeering', {
      vpcId: vpc.vpcId,
      peerVpcId: coreVpc.vpcId,
    });
    vpc.privateSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `AppToCoreRoute${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: coreVpc.vpcCidrBlock,
        vpcPeeringConnectionId: peering.ref,
      });
    });
    coreVpc.isolatedSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `CoreToAppRoute${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: APP_VPC_CIDR,
        vpcPeeringConnectionId: peering.ref,
      });
    });
    coreSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(APP_VPC_CIDR),
      ec2.Port.tcp(5432),
      'Allow the cloudrag app tier to reach the shared database',
    );

    const cluster = new ecs.Cluster(this, 'AppCluster', { vpc });

    // explicit log group so `cdk destroy` removes it instead of orphaning it
    const logRetention = isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;
    const logRemoval = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // multi-agent orchestrator + chat/admin SPA, behind a public ALB. Every route is
    // gated at the application layer (Cognito token, Superuser role for /api/admin/*)
    // rather than by network placement -- see auth.py.
    const orchestrator = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Orchestrator', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(
          path.join(__dirname, '..', '..', 'services', 'orchestrator'),
          { platform: Platform.LINUX_ARM64 },
        ),
        containerPort: 8000,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'orchestrator',
          logGroup: new logs.LogGroup(this, 'OrchestratorLogs', { retention: logRetention, removalPolicy: logRemoval }),
        }),
        environment: {
          AWS_REGION: this.region,
          STAGE: stage,
          DEFAULT_LLM_MODEL_ID,
          EMBED_MODEL_ID,
          RAG_TOP_K: '5',
          COGNITO_USER_POOL_ID: userPoolId,
          COGNITO_CLIENT_ID: userPoolClientId,
          PENDING_DOCUMENTS_TABLE: pendingDocumentsTable.tableName,
        },
      },
    });
    orchestrator.targetGroup.configureHealthCheck({ path: '/healthz' });

    // task role: Bedrock (any foundation model, for per-agent overrides + Titan), the
    // shared DB secret, the Core + agent SSM registries, and the pending-documents table
    orchestrator.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [this.formatArn({
        service: 'bedrock', region: this.region, account: '',
        resource: 'foundation-model', resourceName: '*',
      })],
    }));
    coreSecret.grantRead(orchestrator.taskDefinition.taskRole);
    orchestrator.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      resources: [
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `cloudrag/${stage}/core/*` }),
        // GetParametersByPath(Path="/cloudrag/{stage}/agents") is authorized against
        // the path itself, not just its children -- both resources are required, or
        // AWS returns AccessDeniedException even though "agents/*" looks like it should cover it.
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `cloudrag/${stage}/agents` }),
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `cloudrag/${stage}/agents/*` }),
      ],
    }));
    pendingDocumentsTable.grantReadWriteData(orchestrator.taskDefinition.taskRole);

    new cdk.CfnOutput(this, 'AppUrl', {
      value: `http://${orchestrator.loadBalancer.loadBalancerDnsName}/`,
      description: 'Open this URL in a browser to chat, or review documents on the Admin tab (Superuser role)',
    });
  }
}
