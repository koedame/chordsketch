// Vite's `?raw` import suffix returns the file contents as a string
// at build time. The docs SPA uses it to bundle the canonical
// Markdown sources under `docs/sdk/` (#2506 / ADR-0021) without
// shipping an HTTP fetch + runtime parse. The ambient declaration
// is scoped to `.md` paths so unrelated `?raw` imports keep their
// existing typing from Vite's own client types.

declare module '*.md?raw' {
  const content: string;
  export default content;
}
