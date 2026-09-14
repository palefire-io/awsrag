import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { AgentSiloConfig, DemoIdentity } from '../../config/agent-silos';

export interface AuthStackProps extends cdk.StackProps {
  stage: string;
  agentSilos: AgentSiloConfig[];
  /** Dev-only demo logins holding more than one role. */
  demoIdentities: DemoIdentity[];
}

/**
 * Cognito User Pool that mints the role claims the orchestrator filters RAG results
 * by. One Cognito Group per role name declared across every Agent Silo, plus
 * "Superuser". Role names are namespaced per silo (see config/agent-silos.ts), so
 * each group grants access to exactly one silo -- an identity needing two silos
 * holds two groups. No Hosted UI/custom domain: this is a POC with no owned domain,
 * so the orchestrator verifies tokens itself (PyJWT + this pool's JWKS) instead of
 * using ALB-native Cognito auth, which requires an HTTPS listener with an ACM cert
 * (ACM can't certify AWS-owned hostnames like *.elb.amazonaws.com).
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { stage, agentSilos, demoIdentities } = props;
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

    // one Cognito Group per role name across every silo, plus Superuser. Names are
    // silo-namespaced, so the Set only guards against a duplicate declaration.
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

    // dev-only demo users: one per (silo, role) pair, one superuser, plus the
    // multi-role identities from config/agent-silos.ts -- all sharing the one fixed
    // password above. Never created for prod.
    if (!isProd) {
      const users = [
        { username: 'superuser', groups: ['Superuser'] },
        // role values are globally unique now, so they need no silo prefix
        ...agentSilos.flatMap((silo) => Object.values(silo.roles).map((role) => ({
          username: slug(role),
          groups: [role],
        }))),
        ...demoIdentities,
      ];

      // One generated password shared by every demo user. Generated at deploy time
      // and passed to the provisioner BY ARN, so the value never lands in the
      // CloudFormation template (readable via cloudformation:GetTemplate) or in a
      // stack output. Retrieve it with `npm run demo:creds`.
      const demoPassword = new secretsmanager.Secret(this, 'DemoPassword', {
        description: `Shared password for the ${stage} demo Cognito users`,
        generateSecretString: {
          passwordLength: 20,
          // Cognito's default policy wants upper, lower, digit and symbol; without
          // this the generated value can miss one and AdminSetUserPassword fails.
          requireEachIncludedType: true,
          // quotes and backslashes survive copy-paste badly
          excludeCharacters: '"\'\\`',
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

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
      demoPassword.grantRead(provisionerFn);

      const provider = new Provider(this, 'DemoUsersProvider', { onEventHandler: provisionerFn });
      const demoUsers = new cdk.CustomResource(this, 'DemoUsers', {
        serviceToken: provider.serviceToken,
        properties: {
          Users: JSON.stringify(users),
          PasswordSecretArn: demoPassword.secretArn,
        },
      });
      // groups must exist before users are added to them
      for (const group of groups) demoUsers.node.addDependency(group);
      demoUsers.node.addDependency(demoPassword);

      new cdk.CfnOutput(this, 'DemoUsernames', {
        value: users.map((u) => u.username).join(', '),
        description: 'Run `npm run demo:creds` for the shared password and the app URL',
      });
      new cdk.CfnOutput(this, 'DemoPasswordSecretArn', {
        value: demoPassword.secretArn,
        description: 'Secret holding the shared demo password (see `npm run demo:creds`)',
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
