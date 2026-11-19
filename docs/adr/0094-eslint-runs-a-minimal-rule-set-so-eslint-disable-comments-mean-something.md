# 0094. ESLint runs a minimal rule set, so that `eslint-disable` comments mean something

- **Status**: Accepted
- **Date**: 2026-11-20

## Context

The TypeScript packages carried 53 `eslint-disable` comments and no ESLint:
no configuration, no dependency, no CI step. Every one of those comments
suppressed nothing. A trial run of ESLint over the code showed that a dozen of
them would still suppress nothing (the rule reports no problem there), that
one named a rule `typescript-eslint` has since removed, and that 9 of the 16
`react-hooks/exhaustive-deps` directives were deliberate exceptions worth
keeping next to 7 that were dead. Without a
linter, a new directive cannot be told from noise, and a directive added to
make a real finding go away looks the same as one that documents a reasoned
exception.

## Decision

1. ESLint 9 with `typescript-eslint`, `eslint-plugin-react` and
   `eslint-plugin-react-hooks` lives in `tools/lint/` with its own
   `package-lock.json`. It parses without type information and needs nothing
   from the packages' own `node_modules`.
2. Only these rules run: `react-hooks/rules-of-hooks`,
   `react-hooks/exhaustive-deps`, `no-console`, `react/jsx-key` and
   `react/no-danger`. `reportUnusedDisableDirectives` is `"error"`, so a
   directive that suppresses nothing, or names a rule that is not defined,
   fails the run.
3. It covers the `.ts` and `.tsx` files of `packages/react`, `react-ui`,
   `ui-irealb-editor`, `playground`, `vscode-extension`, `svelte`, `vue`
   and `apps/desktop`. `packages/vue` has the two `react-hooks` rules off: a
   Vue composable is named `useXxx` and is called from `setup()`, which
   `rules-of-hooks` reads as a React hook in the wrong place. `.js` / `.mjs`
   files are parsed with no rule enabled, only to check their directives.
4. It runs as the `ESLint` job of `ci.yml`, on every pull request. The
   lockfile is covered by `dependency-audit.yml` like the other npm
   lockfiles; `git ls-files` finds it without a list to extend.
5. A directive that stays carries its reason on the same line
   (`// eslint-disable-next-line <rule> -- <reason>`).

## Rationale

- The point is that a directive be checkable, not that the code satisfy a
  broad style: the five rules are the ones that catch what `tsc` cannot see
  and that an AI-written change is most likely to get wrong (a hook
  dependency array, a stray `console.log`, a missing key,
  `dangerouslySetInnerHTML`).
- `eslint:recommended` or `typescript-eslint`'s recommended set would add 36
  `no-unused-vars` findings in the first run (`tsc` has no
  `noUnusedLocals`), which is a separate clean-up with its own decisions.

## Consequences

- A directive for a rule outside the five (for example
  `@typescript-eslint/no-explicit-any`) fails with "Definition for rule not
  found". Adding the rule to `tools/lint/eslint.config.mjs` is the fix when
  the rule is wanted; otherwise the directive is dead and goes.
- `.svelte` files are not parsed (no Svelte parser is installed), so the
  one `eslint-disable` in a `.svelte` file is not checked.
- `eslint-disable` stays allowed. Preventing the net growth of suppression
  comments is a separate check.
