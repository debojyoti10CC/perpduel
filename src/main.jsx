import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './dark.css';
import './rooms.css';
import './matchup.css';

const Arena = lazy(() => import('./game/App.tsx'));
let sessionRequest;
const loadSession = () => sessionRequest ||= fetch('/api/session', { credentials: 'same-origin' }).then(async response => { if (!response.ok) throw new Error('Server unavailable'); return response.json(); }).catch(error => { sessionRequest = null; throw error; });
function ConnectedApp() {
  const [session, setSession] = useState(null);
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailure(false);
    loadSession().then(value => { if (active) setSession(value); }).catch(() => { if (active) setFailure(true); });
    return () => { active = false; };
  }, [attempt]);
  if (!session) return <div className="room-loading"><strong>PERPDUEL</strong><span>{failure ? 'Could not reach the room server.' : 'Connecting to the arena…'}</span>{failure && <button onClick={() => setAttempt(n => n + 1)}>Reconnect</button>}</div>;
  return <Suspense fallback={<div className="room-loading">Opening the arena…</div>}>{location.pathname.startsWith('/arena') ? <Arena /> : <App initialSession={session} />}</Suspense>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><ConnectedApp /></React.StrictMode>);
