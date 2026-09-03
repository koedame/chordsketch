// Ambient shims for the single-file component formats the two
// framework demo entries import.
//
// `tsc` parses neither `.vue` nor `.svelte`; typechecking those files
// needs `vue-tsc` / `svelte-check`, i.e. a second and third
// typechecker in the playground's build for two demo components. The
// components each package publishes ARE typechecked — by their own
// package's `npm run typecheck` (`tsc` for Vue, `svelte-check` for
// Svelte) — and the demos' *usage* of them is covered end to end by
// `tests-e2e/framework-demos.spec.ts`, which drives the production
// bundle in a real browser. What these declarations give up is
// type-checking inside the two demo SFCs themselves.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component<Record<string, unknown>>;
  export default component;
}
