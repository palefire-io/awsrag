import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
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

    // Proves a request arrived via our CloudFront distribution. The value is
    // generated at deploy time and referenced indirectly, so it never appears
    // in this repo or in the synthesized template.
    const originVerify = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: `Shared secret proving a request reached the ${stage} ALB via CloudFront`,
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });
    const originVerifyValue = originVerify.secretValue.unsafeUnwrap();

    // TLS terminates here. ACM can't issue a certificate for an AWS-owned ALB
    // hostname, but CloudFront serves every distribution under its own
    // *.cloudfront.net certificate -- so a POC with no domain still gets HTTPS
    // without buying anything. The ALB stays HTTP, reachable only as an origin.
    const distribution = new cloudfront.Distribution(this, 'OrchestratorCdn', {
      comment: `CloudRAG ${stage} orchestrator`,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(orchestrator.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: { 'X-Origin-Verify': originVerifyValue },
          // SSE chat deltas must keep flowing; this bounds the gap between
          // bytes, not the total length of a streamed completion.
          readTimeout: cdk.Duration.seconds(60),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // the SPA POSTs to /v1/chat/completions and DELETEs from /api/admin/*
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Every response is per-caller -- retrieval is filtered by the caller's
        // own Cognito roles. Caching any of it at the edge would hand one
        // user's answers to the next one.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // forwards the caller's X-Cognito-Token; drops Host so the ALB still
        // sees its own hostname
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        // adds HSTS, X-Content-Type-Options, frame and referrer policy
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: isProd
        ? cloudfront.PriceClass.PRICE_CLASS_ALL
        : cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Deny by default: the ALB's own public hostname stops being a way around
    // TLS. Only requests carrying the secret header -- i.e. those relayed by
    // the distribution above -- reach the orchestrator.
    new elbv2.ApplicationListenerRule(this, 'AllowCloudFrontOnly', {
      listener: orchestrator.listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [originVerifyValue])],
      action: elbv2.ListenerAction.forward([orchestrator.targetGroup]),
    });
    // The ECS pattern already set a forward default; addAction() would try to
    // set a second one, so override the L1 property directly.
    (orchestrator.listener.node.defaultChild as elbv2.CfnListener).defaultActions = [{
      type: 'fixed-response',
      fixedResponseConfig: {
        statusCode: '403',
        contentType: 'text/plain',
        messageBody: 'Direct load balancer access is not permitted. Use the CloudFront endpoint.',
      },
    }];

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
      value: `https://${distribution.distributionDomainName}/`,
      description: 'Open this URL in a browser to chat, or review documents on the Admin tab (Superuser role)',
    });
  }
}
