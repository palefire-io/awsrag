import { useEffect, useState, type CSSProperties } from 'react';
import { discardDoc, listAgents, listPending, publishDoc, type AgentSummary, type PendingDoc } from './api';
import { themeFor } from './theme';

export function Admin({ token }: { token: string }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState('');
  const [pending, setPending] = useState<PendingDoc[]>([]);
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAgents(token)
      .then((list) => {
        setAgents(list);
        if (list.length) setAgentId(list[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'failed to list agents'));
  }, [token]);

  const refresh = async (id: string) => {
    if (!id) return;
    try {
      setPending(await listPending(token, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to list pending documents');
    }
  };

  useEffect(() => {
    refresh(agentId);
  }, [agentId, token]);

  const agent = agents.find((a) => a.id === agentId);
  const theme = agentId ? themeFor(agentId) : undefined;
  const style = theme ? ({ '--agent-accent': theme.accent, '--agent-tint': theme.tint } as CSSProperties) : undefined;

  const toggleRole = (sourceId: string, role: string) => {
    setSelected((cur) => {
      const roles = new Set(cur[sourceId] ?? []);
      if (roles.has(role)) roles.delete(role); else roles.add(role);
      return { ...cur, [sourceId]: roles };
    });
  };

  const publish = async (sourceId: string) => {
    setBusy(sourceId);
    setError(null);
    try {
      await publishDoc(token, agentId, sourceId, [...(selected[sourceId] ?? [])]);
      await refresh(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to publish document');
    } finally {
      setBusy(null);
    }
  };

  const discard = async (sourceId: string) => {
    setBusy(sourceId);
    setError(null);
    try {
      await discardDoc(token, agentId, sourceId);
      await refresh(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to discard document');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin" style={style}>
      {error && <p className="admin-error">{error}</p>}

      <div className="admin-picker">
        {agents.map((a) => {
          const t = themeFor(a.id);
          return (
            <button
              key={a.id}
              className={a.id === agentId ? 'active' : ''}
              style={{ '--agent-accent': t.accent, '--agent-tint': t.tint } as CSSProperties}
              onClick={() => setAgentId(a.id)}
            >
              <span className="dot" style={{ background: t.accent }} />
              {a.displayName}
            </button>
          );
        })}
      </div>

      {agents.length === 0 && !error && <p className="admin-empty">No silos deployed yet.</p>}
      {agents.length > 0 && pending.length === 0 && <p className="admin-empty">No pending documents for this silo.</p>}

      {pending.map((doc) => (
        <div key={doc.sourceId} className="pending-doc">
          <p className="meta">{doc.sourceId}</p>
          <p className="content">
            {doc.content.slice(0, 400)}{doc.content.length > 400 ? '…' : ''}
          </p>
          <div className="role-chips">
            {agent?.roles.map((role) => {
              const checked = selected[doc.sourceId]?.has(role) ?? false;
              return (
                <label key={role} className={`role-chip ${checked ? 'checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleRole(doc.sourceId, role)}
                  />
                  {role}
                </label>
              );
            })}
          </div>
          <div className="actions">
            <button
              className="publish"
              disabled={busy === doc.sourceId || !selected[doc.sourceId]?.size}
              title={!selected[doc.sourceId]?.size
                ? 'Choose at least one role that can see this document'
                : undefined}
              onClick={() => publish(doc.sourceId)}
            >
              Publish
            </button>
            <button className="discard" disabled={busy === doc.sourceId} onClick={() => discard(doc.sourceId)}>
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
