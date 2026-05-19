// CSS-only entry for the docs route.
//
// The docs site is fully static — every page is pre-rendered by
// `scripts/build-docs-static.mjs` and served as plain HTML. This
// file exists solely to give Vite a per-entry module so the CSS
// asset (`docs.css`) participates in the production build and gets
// content-hashed alongside the playground's other entries.
//
// The pre-rendered HTML carries an inline `<script>` shim that
// redirects any legacy `#/<slug>` hash URL to the matching clean
// URL; it does not load this module. See ADR-0021.

import './docs.css';
