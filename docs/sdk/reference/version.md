# `version()`

```ts
function version(): string;
```

Returns the running version of `@chordsketch/react` (matches the
`package.json` value at build time). Useful for diagnostics —
when a host has multiple bundled copies of the library (e.g. a
monorepo with hoisting issues), `version()` lets the host log
the version it actually loaded.

```tsx
import { version } from '@chordsketch/react';

console.log(`@chordsketch/react ${version()}`);
```

The value is captured from `package.json` at build time via a
JSON import. No wasm runtime is touched; the call is safe to
execute synchronously during render.
