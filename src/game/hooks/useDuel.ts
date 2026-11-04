import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, Market, MatchState, ServerMessage } from '../../../shared/types';

const configuredOrigin = import.meta.env.VITE_SERVER_URL as string | undefined;
export const apiOrigin = configuredOrigin?.replace(/\/$/, '') ?? '';
export const sessionKey = `trading-duel-session:${apiOrigin || location.origin}`;
export type Feedback = Extract<ServerMessage, { type: 'feedback' }>;
export function useDuel(onFeedback: (event: Feedback) => void, onError: (message: string) => void) {
  const [connected, setConnected] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [state, setState] = useState<MatchState | null>(null);
  const [seats, setSeats] = useState<number[]>([]);
  const [source, setSource] = useState('hyperliquid');
  const [feedConnected, setFeedConnected] = useState(false);
  const [offset, setOffset] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const leaveWaiters = useRef(new Set<(ok: boolean) => void>());
  const feedbackRef = useRef(onFeedback); feedbackRef.current = onFeedback;
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>, attempts = 0;
    const connect = () => {
      const origin = configuredOrigin ?? location.origin;
      const url = `${origin.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
      const ws = new WebSocket(url); socket.current = ws;
      ws.onopen = () => {
        if (!alive) { ws.close(); return; }
        attempts = 0; setConnected(true);
        try { const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null'); if (saved?.code && saved?.token) ws.send(JSON.stringify({ type: 'resume', ...saved })); } catch { /* no saved room */ }
      };
      ws.onmessage = event => {
        if (!alive) return;
        try {
          const data: ServerMessage = JSON.parse(event.data);
          switch (data.type) {
            case 'left':
              sessionStorage.removeItem(sessionKey); setState(null); setSeats([]);
              for (const finish of leaveWaiters.current) finish(true);
              leaveWaiters.current.clear(); break;
            case 'welcome': sessionStorage.setItem(sessionKey, JSON.stringify({ code: data.code, token: data.token })); setSeats(data.seats); break;
            case 'state': setState(data.state); setOffset(data.state.serverTime - Date.now()); break;
            case 'markets': setMarkets(data.markets); setSource(data.source); setFeedConnected(data.connected); setOffset(data.serverTime - Date.now()); break;
            case 'feedback': feedbackRef.current(data); break;
            case 'error':
              if (/not found|expired|invalid.*token|unknown.*room|no.*match|resume.*fail|recovery session/i.test(data.message)) { sessionStorage.removeItem(sessionKey); setState(null); setSeats([]); }
              errorRef.current(data.message); break;
          }
        } catch { /* invalid wire message is ignored */ }
      };
      ws.onclose = () => { if (!alive) return; setConnected(false); setFeedConnected(false); timer = setTimeout(connect, Math.min(5000, 750 * 2 ** attempts++)); };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { alive = false; clearTimeout(timer); socket.current?.close(); for (const finish of leaveWaiters.current) finish(false); leaveWaiters.current.clear(); };
  }, []);
  const send = useCallback((message: ClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) { errorRef.current('Match server disconnected. Reconnecting…'); return false; }
    socket.current.send(JSON.stringify(message)); return true;
  }, []);
  const leave = useCallback(() => new Promise<boolean>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ok: boolean) => { clearTimeout(timer); leaveWaiters.current.delete(finish); resolve(ok); };
    leaveWaiters.current.add(finish);
    timer = setTimeout(() => finish(false), 8000);
    if (!send({ type: 'leave' })) finish(false);
  }), [send]);
  return { connected, markets, state, seats, source, feedConnected, offset, send, leave };
}
