// Direct Cognito login -- there's no Hosted UI (no owned domain), so this calls
// Cognito's InitiateAuth API straight from the browser. It's a public,
// unauthenticated API keyed only by the User Pool Client ID, the same mechanism
// already used to mint demo tokens via the CLI.

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

export async function fetchCognitoConfig(): Promise<CognitoConfig> {
  const res = await fetch('/api/admin/config');
  if (!res.ok) throw new Error('failed to load auth config');
  return res.json();
}

export async function login(config: CognitoConfig, username: string, password: string): Promise<string> {
  const res = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message ?? data.__type ?? 'login failed');
  }
  return data.AuthenticationResult.IdToken as string;
}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

/** Decode the `cognito:groups` claim client-side. UI convenience only -- every
 *  server-side route independently re-verifies the token and its groups. */
export function decodeGroups(token: string): string[] {
  const groups = decodeClaims(token)['cognito:groups'];
  return Array.isArray(groups) ? groups : [];
}

/** Decode the Cognito username claim -- shown in the UI so it's obvious which
 *  demo identity (and therefore which permissions) a session is testing as. */
export function decodeUsername(token: string): string {
  const claims = decodeClaims(token);
  return (claims['cognito:username'] as string) ?? (claims['username'] as string) ?? '(unknown user)';
}
