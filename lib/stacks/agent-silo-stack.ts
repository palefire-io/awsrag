import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AgentSiloConfig } from '../../config/agent-silos';

export interface AgentSiloStackProps extends cdk.StackProps {
  stage: string;
  config: AgentSiloConfig;
  /** The shared Core ingest queue this agent's bucket notifies. */
  ingestQueue: sqs.IQueue;
  /** Service token for the Core silo DB provisioner. */
  siloProviderServiceToken: string;
}

/**
 * One specialist Agent Silo: an ingest bucket, a provisioned `agent_<id>` database on
 * the shared instance, and an SSM registry entry. No compute or VPC of its own — the
 * shared indexer routes its bucket to its database, and the shared orchestrator
 * surfaces it as a selectable model.
 */
export class AgentSiloStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentSiloStackProps) {
    super(scope, id, props);
    const { stage, config, ingestQueue, siloProviderServiceToken } = props;
    const isProd = stage === 'prod';
    const database = `agent_${config.id}`;

    // deterministic name so the Core indexer can be granted GetObject by prefix
    const bucket = new s3.Bucket(this, 'IngestBucket', {
      bucketName: `cloudrag-${stage}-agent-${config.id}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // notify the shared queue on upload. A custom destination (rather than s3n.SqsDestination)
    // returns just the queue ARN and does NOT edit the queue policy — the Core queue is
    // already account-scoped to allow S3, so this avoids a cross-stack dependency cycle.
    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new PreauthorizedSqsDestination(ingestQueue));

    // create the agent's database (+ pgvector schema) on the shared instance
    new cdk.CustomResource(this, 'Database', {
      serviceToken: siloProviderServiceToken,
      properties: {
        Database: database,
        AllowDrop: String(!isProd), // dev drops on teardown; prod retains
      },
    });

    // register the agent so the indexer routes to it and the orchestrator lists it
    const prefix = `/cloudrag/${stage}/agents/${config.id}`;
    new ssm.StringParameter(this, 'DisplayNameParam', { parameterName: `${prefix}/display-name`, stringValue: config.displayName });
    new ssm.StringParameter(this, 'DatabaseParam', { parameterName: `${prefix}/database`, stringValue: database });
    new ssm.StringParameter(this, 'BucketParam', { parameterName: `${prefix}/bucket`, stringValue: bucket.bucketName });
    new ssm.StringParameter(this, 'PromptModuleParam', { parameterName: `${prefix}/prompt-module`, stringValue: config.promptModule });
    new ssm.StringParameter(this, 'RedactParam', { parameterName: `${prefix}/redact`, stringValue: String(config.redactPii ?? true) });
    // which ingest workflow applies -- the vector indexer branches on this to decide
    // whether a newly-ingested document is auto-tagged and persisted, or staged in
    // DynamoDB pending a future admin UI's role selection.
    new ssm.StringParameter(this, 'IngestWorkflowParam', {
      parameterName: `${prefix}/ingest-workflow`,
      stringValue: config.ingestWorkflow,
    });
    // this silo's role names, for the admin UI to render one checkbox per role --
    // roles themselves are just Cognito Group names now, no id translation needed.
    new ssm.StringParameter(this, 'RolesParam', {
      parameterName: `${prefix}/roles`,
      stringValue: JSON.stringify(Object.values(config.roles)),
    });
    // seniority ladder + ingest-time classification, both consumed downstream:
    // the orchestrator expands a caller's roles by the ladder at query time, and
    // the indexer resolves a filename prefix to a role at ingest time.
    if (config.roleLadder?.length) {
      new ssm.StringParameter(this, 'RoleLadderParam', {
        parameterName: `${prefix}/role-ladder`,
        stringValue: JSON.stringify(config.roleLadder),
      });
    }
    if (config.autoClassifyPrefixes && Object.keys(config.autoClassifyPrefixes).length) {
      new ssm.StringParameter(this, 'AutoClassifyParam', {
        parameterName: `${prefix}/auto-classify`,
        stringValue: JSON.stringify(config.autoClassifyPrefixes),
      });
    }

    if (config.llmModelId) {
      new ssm.StringParameter(this, 'LlmModelIdParam', { parameterName: `${prefix}/llm-model-id`, stringValue: config.llmModelId });
    }

    new cdk.CfnOutput(this, 'IngestBucketName', {
      value: bucket.bucketName,
      description: `Upload documents for ${config.displayName} here`,
    });
  }
}

/** S3 notification destination that targets a pre-authorized SQS queue by ARN only. */
class PreauthorizedSqsDestination implements s3.IBucketNotificationDestination {
  constructor(private readonly queue: sqs.IQueue) {}
  bind(_scope: Construct, _bucket: s3.IBucket): s3.BucketNotificationDestinationConfig {
    return { type: s3.BucketNotificationDestinationType.QUEUE, arn: this.queue.queueArn };
  }
}
