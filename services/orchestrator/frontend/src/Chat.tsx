import { useEffect, useRef, useState, type FormEvent } from 'react';
import { streamChat, type Message } from './api';
import { themeFor } from './theme';

export function Chat({ token, agentId, agentName }: { token: string; agentId: string; agentName: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const monogram = themeFor(agentId).monogram;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;

    const history = [...messages, { role: 'user' as const, content: input }];
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

  return (
    <div className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <p className="messages-empty">Ask {agentName} anything from its knowledge base.</p>
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
