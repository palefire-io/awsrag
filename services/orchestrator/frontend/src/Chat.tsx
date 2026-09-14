import { useEffect, useRef, useState, type FormEvent } from 'react';
import { streamChat, type Message, type SampleQuery } from './api';
import { themeFor } from './theme';

export function Chat({ token, agentId, agentName, description, sampleQueries }: {
  token: string;
  agentId: string;
  agentName: string;
  description: string;
  sampleQueries: SampleQuery[];
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const monogram = themeFor(agentId).monogram;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // shared by the composer and the one-click sample prompts, so a starter question
  // sends immediately rather than only filling the box
  const submit = async (text: string) => {
    if (!text.trim() || busy) return;

    const history = [...messages, { role: 'user' as const, content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);
    try {
      for await (const delta of streamChat(token, agentId, history)) {
        setMessages((cur) => {
          const copy = [...cur];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + delta };
          return copy;
        });
      }
    } catch {
      setMessages((cur) => [...cur.slice(0, -1), { role: 'assistant', content: '(error contacting the model)' }]);
    } finally {
      setBusy(false);
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    void submit(input);
  };

  return (
    <div className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="intro">
            <span className="intro-avatar">{monogram}</span>
            <h2 className="intro-name">{agentName}</h2>
            <p className="intro-desc">
              {description || `Ask ${agentName} anything from its knowledge base.`}
            </p>
            {sampleQueries.length > 0 && (
              <>
                <p className="intro-label">Try asking</p>
                <div className="intro-samples">
                  {sampleQueries.map((s) => (
                    <button
                      key={s.query}
                      type="button"
                      className="sample"
                      disabled={busy}
                      onClick={() => void submit(s.query)}
                    >
                      <span>{s.query}</span>
                      {/* shown only on role-gated questions: makes it visible that this
                          one is available because of who you signed in as */}
                      {s.minRole && <span className="sample-role">{s.minRole}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`message-row ${m.role}`}>
            {m.role === 'assistant' && <span className="avatar">{monogram}</span>}
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form className="composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask ${agentName}…`}
          disabled={busy}
        />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </div>
  );
}
