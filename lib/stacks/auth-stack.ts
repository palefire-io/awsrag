import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { AgentSiloConfig } from '../../config/agent-silos';

// dev-only demo accounts: fixed, deliberately simple/shared password. No real data
// sits behind these, so this is a demo convenience, not a security boundary.
const DEMO_PASSWORD = 'Demo1234!';

export interface AuthStackProps extends cdk.StackProps {
  stage: string;
  agentSilos: AgentSiloConfig[];
}

/**
 * Cognito User Pool that mints the role claims the orchestrator filters RAG results
 * by. One Cognito Group per unique role name declared across every Agent Silo
 * (deduped — e.g. "Exec-Team" is one group even though multiple silos declare it),
 * plus "Superuser". No Hosted UI/custom domain: this is a POC with no owned domain,
 * so the orchestrator verifies tokens itself (PyJWT + this pool's JWKS) instead of
 * using ALB-native Cognito auth, which requires an HTTPS listener with an ACM cert
 * (ACM can't certify AWS-owned hostnames like *.elb.amazonaws.com).
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { stage, agentSilos } = props;
    const isProd = stage === 'prod';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `cloudrag-${stage}`,
      selfSignUpEnabled: false,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // USER_PASSWORD_AUTH so tokens can be minted via `aws cognito-idp initiate-auth`
    // for testing/demo purposes, without a Hosted UI domain.
    this.userPoolClient = this.userPool.addClient('Client', {
      authFlows: { userPassword: true },
      generateSecret: false,
    });

    // one Cognito Group per unique role name across every silo, plus Superuser --
    // "User"/"Exec-Team" etc. are shared groups even though >1 silo declares them.
    const roleNames = new Set<string>(['Superuser']);
    for (const silo of agentSilos) {
      for (const role of Object.values(silo.roles)) roleNames.add(role);
    }
    const groups = [...roleNames].map((name) => new cognito.CfnUserPoolGroup(this, `Group${sanitize(name)}`, {
      userPoolId: this.userPool.userPoolId,
      groupName: name,
    }));

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });

    // dev-only demo users: one per (silo, role) pair, plus one superuser, all
    // sharing the one fixed password above. Never created for prod.
    if (!isProd) {
      const users = [
        { username: 'superuser', groups: ['Superuser'] },
        ...agentSilos.flatMap((silo) => Object.values(silo.roles).map((role) => ({
          username: `${silo.id}-${slug(role)}`,
          groups: [role],
        }))),
      ];

      const provisionerFn = new lambda.Function(this, 'DemoUsersProvisionerFunction', {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambdas', 'demoUsersProvisioner')),
        timeout: cdk.Duration.seconds(60),
        environment: { USER_POOL_ID: this.userPool.userPoolId },
      });
      provisionerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [this.userPool.userPoolArn],
      }));

      const provider = new Provider(this, 'DemoUsersProvider', { onEventHandler: provisionerFn });
      const demoUsers = new cdk.CustomResource(this, 'DemoUsers', {
        serviceToken: provider.serviceToken,
        properties: {
          Users: JSON.stringify(users),
          Password: DEMO_PASSWORD,
        },
      });
      // groups must exist before users are added to them
      for (const group of groups) demoUsers.node.addDependency(group);

      new cdk.CfnOutput(this, 'DemoUsernames', {
        value: users.map((u) => u.username).join(', '),
        description: `Shared password for every demo user: ${DEMO_PASSWORD}`,
      });
    }
  }
}

/** Cognito Group names can be free text; CDK construct ids can't. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '');
}

/** username-safe form of a role name, e.g. "HR-Manager" -> "hr-manager". */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
