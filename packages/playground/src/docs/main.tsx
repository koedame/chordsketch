/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './docs.css';

// React Grab — point at any UI element and press ⌘C / Ctrl-C to
// copy the source-file location + React component name + HTML
// snippet to the clipboard, ready to paste into a coding agent.
// Local dev only; dropped from the production bundle.
if (import.meta.env.DEV) {
  void import('react-grab');
}

const container = document.getElementById('app');
if (container === null) {
  throw new Error(
    '#app container is missing from the docs entry HTML — check docs/index.html',
  );
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
