import { useEffect, useState, type CSSProperties } from 'react';
import { Admin } from './Admin';
import { listModels, type ModelInfo } from './api';
import { Chat } from './Chat';
import { decodeGroups, decodeUsername } from './cognito';
import { Login } from './Login';
import { ADMIN_THEME, themeFor, type AgentTheme } from './theme';

type View = 'chat' | 'admin';

const themeVars = (theme: AgentTheme): CSSProperties => ({
  '--agent-accent': theme.accent,
  '--agent-tint': theme.tint,
} as CSSProperties);

export function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('token'));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsState, setModelsState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('');
  const [view, setView] = useState<View>('chat');

  useEffect(() => {
    if (!token) return;
    setModelsState('loading');
    listModels(token)
      .then((list) => {
        setModels(list);
        if (list.length) setAgentId(list[0].id);
        setModelsState('loaded');
      })
      .catch((err) => {
        setModelsError(err instanceof Error ? err.message : 'failed to load specialists');
        setModelsState('error');
      });
  }, [token]);

  const onLogin = (t: string) => {
    sessionStorage.setItem('token', t);
    setToken(t);
  };

  const logout = () => {
    sessionStorage.removeItem('token');
    setToken(null);
  };

  if (!token) return <Login onLogin={onLogin} />;

  // UI convenience only -- every /api/admin/* route independently re-verifies the
  // token and its Superuser membership server-side; this just decides whether to
  // show the tab at all.
  const username = decodeUsername(token);
  const groups = decodeGroups(token);
  const isSuperuser = groups.includes('Superuser');
  const activeAgent = models.find((m) => m.id === agentId);
  const shellTheme = view === 'admin' || !activeAgent ? ADMIN_THEME : themeFor(activeAgent.id);

  return (
    <div className="shell" style={themeVars(shellTheme)}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <p className="sidebar-mark">CloudRAG</p>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-label">Specialists</p>
          {modelsState === 'loading' && <p className="sidebar-note">Loading…</p>}
          {modelsState === 'error' && <p className="sidebar-note error">{modelsError}</p>}
          {modelsState === 'loaded' && models.length === 0 && (
            <p className="sidebar-note">None deployed yet.</p>
          )}
          {models.map((m) => {
            const theme = themeFor(m.id);
            return (
              <button
                key={m.id}
                className={`sidebar-item ${view === 'chat' && agentId === m.id ? 'active' : ''}`}
                style={themeVars(theme)}
                onClick={() => { setAgentId(m.id); setView('chat'); }}
              >
                <span className="dot" />
                {m.name}
              </button>
            );
          })}
        </div>

        {isSuperuser && (
          <>
            <hr className="sidebar-divider" />
            <div className="sidebar-section">
              <p className="sidebar-label">Admin</p>
              <button
                className={`sidebar-item ${view === 'admin' ? 'active' : ''}`}
                style={themeVars(ADMIN_THEME)}
                onClick={() => setView('admin')}
              >
                <span className="dot diamond" />
                Review documents
              </button>
            </div>
          </>
        )}

        <div className="sidebar-footer">
          <div className="identity">
            <p className="identity-username">{username}</p>
            <p className="identity-roles">{groups.length ? groups.join(', ') : 'no roles'}</p>
          </div>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>

      <div className="main">
        <div className="main-bar">
          {view === 'chat' ? (
            <>
              <span className="eyebrow">Consulting</span>
              <h1>{activeAgent?.name ?? '—'}</h1>
            </>
          ) : (
            <>
              <span className="eyebrow">Admin</span>
              <h1>Review documents</h1>
            </>
          )}
        </div>

        {view === 'chat' && activeAgent ? (
          <Chat key={activeAgent.id} token={token} agentId={activeAgent.id} agentName={activeAgent.name} />
        ) : view === 'admin' ? (
          <Admin token={token} />
        ) : (
          <div className="main-empty">
            {modelsState === 'loading' && <p>Loading specialists…</p>}
            {modelsState === 'error' && <p className="error">Couldn't load specialists: {modelsError}</p>}
            {modelsState === 'loaded' && (
              <p>No specialists are deployed yet. Ask an admin to add one to config/agent-silos.ts.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
