import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <main>
      <h1>Email Tracker</h1>
      <p>Dashboard scaffolding. Wired up in Unit 9.</p>
    </main>
  </StrictMode>,
);
