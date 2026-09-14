import { execSync } from 'child_process';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/** Titan Text Embeddings v2 — 1024-dimension output vectors. */
const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBED_DIMENSIONS = '1024';

export interface CoreStackProps extends cdk.StackProps {
  stage: string;
  /** IAM user/role ARNs allowed to open a tunnel to the database. */
  allowedPrincipalArns?: string[];
}

/**
 * Core — the shared data plane for every Agent Silo.
 *
 * One isolated VPC + one RDS Postgres instance (which hosts one database per agent),
 * one ingest queue + DLQ, one vector indexer (routes each message to the right agent
 * database), one Comprehend redactor, and a provisioner Lambda that creates each
 * agent's database on demand. Agent-specific buckets and databases live in the
 * per-agent AgentSiloStack.
 */
export class CoreStack extends cdk.Stack {

  public readonly vpc: ec2.Vpc;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly instance: rds.DatabaseInstance;
  public readonly ingestQueue: sqs.Queue;
  /** Staging table for UIMediated-workflow documents awaiting role selection. */
  public readonly pendingDocumentsTable: dynamodb.Table;
  /** Service token for the silo DB provisioner (AgentSiloStack triggers it per agent). */
  public readonly siloProviderServiceToken: string;

  constructor(scope: Construct, id: string, props: CoreStackProps) {

    super(scope, id, props);
    const { stage, allowedPrincipalArns = [] } = props;
    const isProd = stage === 'prod';
    const corePrefix = `/cloudrag/${stage}/core`;

    // isolated VPC to contain the database instance
    this.vpc = new ec2.Vpc(this, 'CoreVpc', {
      // RDS requires its DB subnet group to span >= 2 AZs even for a single-AZ instance,
      // so dev uses 2 (the minimum); production spreads wider.
      maxAzs: isProd ? 3 : 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'CoreDbSecurityGroup', {
      vpc: this.vpc,
      description: 'Access to the shared vector database instance',
      allowAllOutbound: false,
    });

    // one shared instance; each agent gets its own database on it (see the provisioner)
    this.instance = new rds.DatabaseInstance(this, 'CoreDbInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_13,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('cloudrag_admin'),
      databaseName: 'postgres',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      // CDK defaults this to false when no KMS key is given. Encrypts the volume,
      // its snapshots and its automated backups under the account's aws/rds key.
      // Cannot be turned on in place later -- it forces instance replacement.
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: false,
      backupRetention: cdk.Duration.days(1),
      deletionProtection: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // --- keyless tunnel access for admins (EC2 Instance Connect Endpoint) ---
    const instanceConnectSecurityGroup = new ec2.SecurityGroup(this, 'InstanceConnectEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'ENI for the EC2 Instance Connect Endpoint used to tunnel to the database',
    });

    this.securityGroup.addIngressRule(
      instanceConnectSecurityGroup,
      ec2.Port.tcp(this.instance.instanceEndpoint.port),
      'Allow tunneled access from the EC2 Instance Connect Endpoint',
    );

    const instanceConnectEndpoint = new ec2.CfnInstanceConnectEndpoint(this, 'CoreDbInstanceConnectEndpoint', {
      subnetId: this.vpc.isolatedSubnets[0].subnetId,
      securityGroupIds: [instanceConnectSecurityGroup.securityGroupId],
      preserveClientIp: false,
    });

    // --- alternative DB access: a CloudShell VPC environment ---
    // `aws ec2-instance-connect open-tunnel` only supports remote port 22 or 3389
    // (an AWS-enforced restriction, not ours), so it can't reach Postgres on 5432.
    // A CloudShell session with its ENI attached to this security group sits
    // directly on the VPC instead -- no tunnel needed -- with zero standing
    // infrastructure. See scripts/db-cloudshell.ts.
    const cloudShellSecurityGroup = new ec2.SecurityGroup(this, 'CloudShellSecurityGroup', {
      vpc: this.vpc,
      description: 'Attach to a CloudShell VPC environment to reach the shared database',
    });
    this.securityGroup.addIngressRule(
      cloudShellSecurityGroup,
      ec2.Port.tcp(this.instance.instanceEndpoint.port),
      'Allow a VPC-connected CloudShell session to reach the shared database',
    );

    const tunnelAccessPolicy = new iam.ManagedPolicy(this, 'CoreDbTunnelAccessPolicy', {
      // no explicit managedPolicyName: both it and `description` below are createOnly
      // properties in IAM's CloudFormation resource type, so changing description
      // forces a replacement -- with a fixed name, that replacement collides on IAM's
      // name-uniqueness constraint (CFN tries to create the replacement before
      // deleting the original). Letting CDK generate the name avoids that permanently;
      // find the current one via the TunnelAccessPolicyArn output below, not by name.
      description: 'Grants permission to reach the shared database: via a CloudShell VPC environment, or by '
        + 'starting/SSHing into the dev-only DB bastion through its EC2 Instance Connect Endpoint',
      statements: [
        new iam.PolicyStatement({
          actions: ['ec2-instance-connect:OpenTunnel'],
          resources: [
            this.formatArn({
              service: 'ec2',
              resource: 'instance-connect-endpoint',
              resourceName: instanceConnectEndpoint.attrId,
            }),
          ],
        }),
        new iam.PolicyStatement({
          actions: ['ec2:DescribeInstanceConnectEndpoints'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          // needed for the one-liner scripts/db-cloudshell.ts prints -- fetching the
          // DB password from within the CloudShell session, not from this machine.
          actions: ['secretsmanager:GetSecretValue'],
          resources: [this.instance.secret!.secretArn],
        }),
      ],
    });

    // --- alternative DB access: a tiny SSH bastion via the existing EICE endpoint ---
    // `open-tunnel` only supports remote port 22/3389, so it can't reach RDS directly
    // (see above) -- but it CAN reach a bastion's SSH port, which then locally
    // forwards to RDS. No new VPC endpoints needed (unlike an SSM-based bastion,
    // which would need ssmmessages + ec2messages interface endpoints at ~$29/month
    // in this 2-AZ VPC, dwarfing the instance itself). Dev-only: a debug bastion for
    // interactive DB access has no place in prod. See scripts/db-connect.ts.
    if (!isProd) {
      const bastionSecurityGroup = new ec2.SecurityGroup(this, 'DbBastionSecurityGroup', {
        vpc: this.vpc,
        description: 'SSH bastion (via the EC2 Instance Connect Endpoint) for ad hoc DB access',
      });
      this.securityGroup.addIngressRule(
        bastionSecurityGroup,
        ec2.Port.tcp(this.instance.instanceEndpoint.port),
        'Allow the DB bastion to reach the shared database',
      );
      bastionSecurityGroup.addIngressRule(
        instanceConnectSecurityGroup,
        ec2.Port.tcp(22),
        'Allow SSH from the EC2 Instance Connect Endpoint',
      );

      const bastion = new ec2.Instance(this, 'DbBastion', {
        vpc: this.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.NANO),
        machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
        securityGroup: bastionSecurityGroup,
        // no key pair, no IAM instance profile -- EC2 Instance Connect pushes an
        // ephemeral key per-session; Amazon Linux 2023 ships ec2-instance-connect by default
      });

      new ssm.StringParameter(this, 'BastionInstanceIdParam', {
        parameterName: `${corePrefix}/bastion-instance-id`,
        stringValue: bastion.instanceId,
      });

      const bastionArn = this.formatArn({ service: 'ec2', resource: 'instance', resourceName: bastion.instanceId });
      tunnelAccessPolicy.addStatements(
        new iam.PolicyStatement({
          actions: ['ec2-instance-connect:SendSSHPublicKey'],
          resources: [bastionArn],
        }),
        new iam.PolicyStatement({
          // scripts/db-connect.ts starts the bastion before connecting and stops it
          // again once the session ends, so it's only ever running while in use.
          actions: ['ec2:StartInstances', 'ec2:StopInstances'],
          resources: [bastionArn],
        }),
        new iam.PolicyStatement({
          actions: ['ec2:DescribeInstances'], // no resource-level support; must be '*'
          resources: ['*'],
        }),
      );
    }

    allowedPrincipalArns.forEach((arn, i) => {
      if (/:role\//.test(arn)) {
        tunnelAccessPolicy.attachToRole(iam.Role.fromRoleArn(this, `AllowedPrincipalRole${i}`, arn));
      } else if (/:user\//.test(arn)) {
        tunnelAccessPolicy.attachToUser(iam.User.fromUserArn(this, `AllowedPrincipalUser${i}`, arn));
      } else {
        cdk.Annotations.of(this).addWarningV2(
          'core:unsupported-principal-arn',
          `VECTOR_DB_ALLOWED_PRINCIPALS entry "${arn}" is not an IAM user or role ARN and was skipped.`,
        );
      }
    });

    new cdk.CfnOutput(this, 'TunnelAccessPolicyArn', {
      value: tunnelAccessPolicy.managedPolicyArn,
      description: 'Attach this managed policy to any IAM user/role that needs to tunnel to the database',
    });

    // --- private paths out of the isolated subnet (no NAT) ---
    const secretsManagerEndpointSecurityGroup = new ec2.SecurityGroup(this, 'SecretsManagerEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Interface VPC endpoint for Secrets Manager',
    });
    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [secretsManagerEndpointSecurityGroup],
    });

    // the vector indexer's agent-routing lookup (_routes_now) reads SSM, but nothing
    // in this isolated (no-NAT) VPC could previously reach it -- this was a latent gap.
    const ssmEndpointSecurityGroup = new ec2.SecurityGroup(this, 'SsmEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Interface VPC endpoint for SSM',
    });
    new ec2.InterfaceVpcEndpoint(this, 'SsmEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [ssmEndpointSecurityGroup],
    });

    const awsServiceEndpointSecurityGroup = new ec2.SecurityGroup(this, 'AwsServiceEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Interface VPC endpoints for Bedrock and Comprehend',
    });
    new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [awsServiceEndpointSecurityGroup],
    });
    new ec2.InterfaceVpcEndpoint(this, 'ComprehendEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.COMPREHEND,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [awsServiceEndpointSecurityGroup],
    });
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // --- shared ingest queue: every agent bucket notifies it ---
    const ingestDlq = new sqs.Queue(this, 'IngestDlq', {
      queueName: `cloudrag-${stage}-ingest-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      queueName: `cloudrag-${stage}-ingest`,
      visibilityTimeout: cdk.Duration.seconds(720),
      deadLetterQueue: { queue: ingestDlq, maxReceiveCount: 5 },
    });
    // account-scoped grant so any agent bucket (created in a separate AgentSiloStack)
    // can publish notifications without a cross-stack queue-policy edit (which would
    // create a dependency cycle). Buckets attach via PreauthorizedSqsDestination.
    this.ingestQueue.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAccountS3BucketsToNotify',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [this.ingestQueue.queueArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));

    // --- staging table for UIMediated-workflow documents awaiting role selection ---
    this.pendingDocumentsTable = new dynamodb.Table(this, 'PendingDocumentsTable', {
      tableName: `cloudrag-${stage}-pending-documents`,
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // --- vector indexer: one Lambda, routes each message to the right agent database ---
    const vectorIndexerSecurityGroup = new ec2.SecurityGroup(this, 'VectorIndexerSecurityGroup', {
      vpc: this.vpc,
      description: 'Vector indexer Lambda function',
    });
    this.securityGroup.addIngressRule(vectorIndexerSecurityGroup,
      ec2.Port.tcp(this.instance.instanceEndpoint.port), 'Allow the vector indexer to reach the database');
    secretsManagerEndpointSecurityGroup.addIngressRule(vectorIndexerSecurityGroup,
      ec2.Port.tcp(443), 'Allow the vector indexer to read database credentials');
    awsServiceEndpointSecurityGroup.addIngressRule(vectorIndexerSecurityGroup,
      ec2.Port.tcp(443), 'Allow the vector indexer to reach Bedrock and Comprehend');
    ssmEndpointSecurityGroup.addIngressRule(vectorIndexerSecurityGroup,
      ec2.Port.tcp(443), 'Allow the vector indexer to reach SSM');

    const vectorIndexer = new lambda.Function(this, 'VectorIndexerFunction', {
      functionName: `cloudrag-${stage}-vector-indexer`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: pythonLambdaCode(path.join(__dirname, '..', 'lambdas', 'vectorIndexer')),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [vectorIndexerSecurityGroup],
      environment: {
        DB_SECRET_ARN: this.instance.secret!.secretArn,
        EMBED_MODEL_ID,
        EMBED_DIMENSIONS,
        COMPREHEND_LANGUAGE: 'en',
        STAGE: stage,
        PENDING_DOCUMENTS_TABLE: this.pendingDocumentsTable.tableName,
      },
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'VectorIndexerLogGroup', {
        logGroupName: `/aws/lambda/cloudrag-${stage}-vector-indexer`,
        retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      }),
    });

    this.instance.secret!.grantRead(vectorIndexer);
    vectorIndexer.addEventSource(new SqsEventSource(this.ingestQueue, {
      batchSize: 5,
      maxConcurrency: 5,
      reportBatchItemFailures: true,
    }));
    // read documents from any agent bucket (deterministic name prefix), route via SSM,
    // embed on Bedrock, and redact with Comprehend
    vectorIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::cloudrag-${stage}-agent-*/*`],
    }));
    vectorIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      // GetParametersByPath(Path="/cloudrag/{stage}/agents") is authorized against
      // the path itself, not just its children -- both resources are required, or AWS
      // returns AccessDeniedException even though "agents/*" looks like it should cover it.
      resources: [
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `cloudrag/${stage}/agents` }),
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `cloudrag/${stage}/agents/*` }),
      ],
    }));
    vectorIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [this.formatArn({
        service: 'bedrock', region: this.region, account: '',
        resource: 'foundation-model', resourceName: EMBED_MODEL_ID,
      })],
    }));
    vectorIndexer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['comprehend:DetectPiiEntities'],
      resources: ['*'],
    }));
    this.pendingDocumentsTable.grantWriteData(vectorIndexer);

    // --- silo DB provisioner: creates/drops each agent's database on stack events ---
    const provisionerSecurityGroup = new ec2.SecurityGroup(this, 'SiloProvisionerSecurityGroup', {
      vpc: this.vpc,
      description: 'Silo database provisioner Lambda',
    });
    this.securityGroup.addIngressRule(provisionerSecurityGroup,
      ec2.Port.tcp(this.instance.instanceEndpoint.port), 'Allow the provisioner to reach the database');
    secretsManagerEndpointSecurityGroup.addIngressRule(provisionerSecurityGroup,
      ec2.Port.tcp(443), 'Allow the provisioner to read database credentials');

    const provisioner = new lambda.Function(this, 'SiloProvisionerFunction', {
      functionName: `cloudrag-${stage}-silo-provisioner`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: pythonLambdaCode(path.join(__dirname, '..', 'lambdas', 'siloProvisioner')),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [provisionerSecurityGroup],
      environment: {
        DB_SECRET_ARN: this.instance.secret!.secretArn,
        EMBED_DIMENSIONS,
      },
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'SiloProvisionerLogGroup', {
        logGroupName: `/aws/lambda/cloudrag-${stage}-silo-provisioner`,
        retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      }),
    });
    this.instance.secret!.grantRead(provisioner);

    const siloProvider = new Provider(this, 'SiloProvider', { onEventHandler: provisioner });
    this.siloProviderServiceToken = siloProvider.serviceToken;

    // --- shared connection details under /core (agents supply their own database) ---
    new ssm.StringParameter(this, 'InstanceConnectEndpointIdParam', {
      parameterName: `${corePrefix}/instance-connect-endpoint-id`,
      stringValue: instanceConnectEndpoint.attrId,
    });
    new ssm.StringParameter(this, 'EndpointParam', {
      parameterName: `${corePrefix}/endpoint`,
      stringValue: this.instance.dbInstanceEndpointAddress,
    });
    new ssm.StringParameter(this, 'PortParam', {
      parameterName: `${corePrefix}/port`,
      stringValue: this.instance.dbInstanceEndpointPort,
    });
    new ssm.StringParameter(this, 'SecretArnParam', {
      parameterName: `${corePrefix}/secret-arn`,
      stringValue: this.instance.secret!.secretArn,
    });
    new ssm.StringParameter(this, 'IngestQueueUrlParam', {
      parameterName: `${corePrefix}/ingest-queue-url`,
      stringValue: this.ingestQueue.queueUrl,
    });
    new ssm.StringParameter(this, 'CloudShellSecurityGroupIdParam', {
      parameterName: `${corePrefix}/cloudshell-security-group-id`,
      stringValue: cloudShellSecurityGroup.securityGroupId,
    });
    new ssm.StringParameter(this, 'IsolatedSubnetIdsParam', {
      parameterName: `${corePrefix}/isolated-subnet-ids`,
      stringValue: this.vpc.isolatedSubnets.map((s) => s.subnetId).join(','),
    });

    new cdk.CfnOutput(this, 'IngestQueueUrl', {
      value: this.ingestQueue.queueUrl,
      description: 'Direct-ingest queue: send {"agent","id","text"} messages here',
    });
  }
}

/**
 * Package a Python Lambda whose only dependency is the pure-Python pg8000 driver:
 * bundle locally with host pip (fast, native) and fall back to Docker only if pip
 * is absent. pg8000's py3-none-any wheel makes the two builds identical.
 */
function pythonLambdaCode(src: string): lambda.AssetCode {
  return lambda.Code.fromAsset(src, {
    exclude: ['package.json', 'build', '*.zip', '__pycache__', 'node_modules'],
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      command: [
        'bash', '-c',
        'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
      ],
      local: {
        tryBundle(outputDir: string): boolean {
          try {
            execSync('python3 -m pip --version', { stdio: 'ignore' });
          } catch {
            return false;
          }
          execSync([
            `python3 -m pip install -r "${path.join(src, 'requirements.txt')}" -t "${outputDir}"`,
            `cp "${path.join(src, 'handler.py')}" "${outputDir}"`,
          ].join(' && '), { stdio: 'inherit' });
          return true;
        },
      },
    },
  });
}
