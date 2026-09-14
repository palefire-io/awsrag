export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  sampleQueries: string[];
}

export interface AgentSummary {
  id: string;
  displayName: string;
  roles: string[];
}

export interface PendingDoc {
  sourceId: string;
  content: string;
  createdAt: number;
  status: string;
}

const authHeaders = (token: string) => ({ 'X-Cognito-Token': token });

/** FastAPI's HTTPException body is `{"detail": "..."}`; fall back to the status line
 *  if the response isn't JSON, so a failure always says *why*, not just *that*. */
async function apiError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    if (typeof body?.detail === 'string') return new Error(body.detail);
  } catch {
    // not JSON -- fall through
  }
  return new Error(`${fallback} (${res.status} ${res.statusText})`);
}

export async function listModels(token: string): Promise<ModelInfo[]> {
  const res = await fetch('/v1/models', { headers: authHeaders(token) });
  if (!res.ok) throw await apiError(res, 'failed to list specialists');
  const data = await res.json();
  return data.data.map((m: {
    id: string; name: string; description?: string; sample_queries?: string[];
  }) => ({
    id: m.id,
    name: m.name,
    description: m.description ?? '',
    sampleQueries: m.sample_queries ?? [],
  }));
}

/** Streams assistant text deltas from the SSE chat-completions response. */
export async function* streamChat(token: string, model: string, messages: Message[]): AsyncGenerator<string> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw await apiError(res, 'chat request failed');
  if (!res.body) throw new Error('chat request failed: empty response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice('data: '.length);
      if (payload === '[DONE]') return;
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

export async function listAgents(token: string): Promise<AgentSummary[]> {
  const res = await fetch('/api/admin/agents', { headers: authHeaders(token) });
  if (!res.ok) throw await apiError(res, 'failed to list agents');
  return res.json();
}

export async function listPending(token: string, agentId: string): Promise<PendingDoc[]> {
  const res = await fetch(`/api/admin/pending/${agentId}`, { headers: authHeaders(token) });
  if (!res.ok) throw await apiError(res, 'failed to list pending documents');
  return res.json();
}

export async function publishDoc(token: string, agentId: string, sourceId: string, roles: string[]): Promise<void> {
  const res = await fetch(`/api/admin/pending/${agentId}/${encodeURIComponent(sourceId)}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ roles }),
  });
  if (!res.ok) throw await apiError(res, 'failed to publish document');
}

export async function discardDoc(token: string, agentId: string, sourceId: string): Promise<void> {
  const res = await fetch(`/api/admin/pending/${agentId}/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw await apiError(res, 'failed to discard document');
}
