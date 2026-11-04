import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './dark.css';
import './matchup.css';

const Arena = lazy(() => import('./game/App.tsx'));
const root = createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <Suspense fallback={<div>Opening the arena…</div>}>
      {location.pathname.startsWith('/arena') ? <Arena /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
