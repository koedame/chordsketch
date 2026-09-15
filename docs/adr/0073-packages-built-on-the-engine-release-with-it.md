# 0073. The npm packages built on the engine release with it, and install the in-tree wasm

- **Status**: Accepted
- **Date**: 2026-09-15
- **Amends**: [ADR-0064](0064-framework-binding-smoke-tracks-latest.md),
  [ADR-0065](0065-existence-mode-for-off-cadence-channels.md),
  [ADR-0069](0069-crates-io-and-npm-publish-from-ci-with-trusted-publishing.md)

## Context

`@chordsketch/react-ui`, `@chordsketch/react`, `@chordsketch/vue`,
`@chordsketch/svelte` and `@chordsketch/chordpro-lite` versioned on their own
cadence. ADR-0064 kept them out of the version-consistency check for that
reason, ADR-0065 gave `chordpro-lite` an `"exists"` rollup entry, and ADR-0069
gave `publish-registries.yml` a `set` input so each could be dispatched on its
own. The Rust workspace and `@chordsketch/wasm` were at 0.6.0 while npm served
`@chordsketch/react` 0.4.0 and the other four at 0.1.0.

A release did not reach the users of those packages. `@chordsketch/react`
0.4.0 on npm depends on `@chordsketch/wasm@^0.5.0`, so its users stayed on the
0.5 engine after 0.6.0 shipped. Getting 0.6 to them took three more steps after
the release: a pull request raising the `^0.5.0` pins, then a version bump,
then a publish of each package.

The pins could not be raised in the release commit. Every package that depends
on `@chordsketch/wasm` installed it from npm through its lockfile, and the
release commit's CI runs before the release publishes the new version, so
`npm ci` could not resolve `^0.6.0`. v0.4.0, v0.5.0 and v0.6.0 each left the
pins one minor behind in `ci/version-skew-allowlist.toml` and raised them in a
follow-up pull request. The release commit's tests also ran against the
previous wasm from npm rather than the one being released.

## Decision

1. **The five packages carry the workspace version** and publish with every
   release. `scripts/check-version-consistency.py` checks their `version`,
   their channels in `ci/release-channels.toml` are `expected_version = "tag"`,
   and `publish-registries.yml` has no `set` input: it publishes every package
   whose channel carries the tag's version.
2. **The release commit raises the `@chordsketch/wasm` and
   `@chordsketch/wasm-export` pins** to `^X.Y.Z` of the version it releases,
   and the pins can no longer be allowlisted.
3. **The lockfiles of the packages that install `@chordsketch/wasm` link the
   in-tree `packages/npm`** instead of resolving it from npm:
   `packages/{vscode-extension,react,vue,svelte,ui-irealb-editor}/package-lock.json`
   carry `"node_modules/@chordsketch/wasm": {"resolved": "../npm", "link": true}`.
   The published `package.json` keeps the registry range. npm keeps the link
   through `npm ci` and `npm install` while `packages/npm`'s version satisfies
   the range, and `npm ci` fails with `notarget` when it does not.
   `check-version-consistency.py` fails when a lockfile resolves the package
   from npm.
4. **`vue.yml` and `svelte.yml` build the wasm bundle before their tests**, as
   `react.yml` already did, since their tests load it.
   `ui-irealb-editor.yml` stubs the wasm and the playground typechecks against
   ambient declarations, so neither needs the build.
5. **The publish checks accept a caret range on a package released in the same
   release.** `npm_dependency_problems` treated only an exact pin as released
   together, so `^0.7.0` on the unpublished `@chordsketch/wasm` 0.7.0 would
   fail the release preflight.
6. **`release-verify.yml` reads `ci/release-channels.toml` at the tag it
   verifies.** Otherwise the daily run over the previous tag would assert
   channels, like these five, that moved onto the tag after it was cut.
7. **`publish-registries.py` builds `@chordsketch/wasm` for its lockfile-linked
   consumers even when `@chordsketch/wasm` itself is not part of the run.**
   The `npm` job's `packages` list is only the packages still pending; on a
   resumed release where `@chordsketch/wasm` already published but
   `@chordsketch/react` (or `vue` / `svelte`) has not, `@chordsketch/wasm`
   would be absent from that list, leaving its lockfile link pointed at an
   unbuilt `packages/npm` on the fresh checkout. `ensure_wasm_built` builds it
   as a prerequisite in that case, and `wasm_pack_needed` extends the `wasm`
   plan output — which gates installing Rust and wasm-pack on the runner — to
   cover it too.

## Rationale

The release commit then installs, tests and packs against the wasm it
releases, so one tag publishes every package at one version. There is no
follow-up pull request and no allowlist entry to retire.

The link lives only in the lockfile, so what npm publishes is unchanged, and
the lockfile refresh step 1 of `docs/releasing.md` runs at every release keeps
it. Verified with npm 10.9: with
`packages/npm` at 0.7.0, a pin of `^0.7.0` and nothing at 0.7.0 on npm,
`npm ci` installs; `npm install --package-lock-only` after bumping both keeps
the link; and `packages/npm` at 0.8.0 against `^0.7.0` fails `npm ci`.

## Consequences

- The next release publishes `@chordsketch/react` from 0.4.0 to the workspace
  version, and the other four from 0.1.0. A 0.x minor is allowed to break
  (ADR-0044).
- `vue.yml` and `svelte.yml` install Rust and wasm-pack and build the wasm,
  adding a few minutes to those runs.
- A lockfile regenerated from scratch resolves `@chordsketch/wasm` from npm
  again. The version-consistency check names the lockfile and the commands
  that restore the link.
- `expected_version = "exists"` has no channel left. The mode stays for a
  future channel that publishes off the tag.
- A patch-only `@chordsketch/wasm` release still satisfies the consumers'
  caret ranges, so the skew `docs/releasing.md` allows for it still works.

## Alternatives considered

- **Publish the wasm first, then raise the pins automatically.** The release
  script would publish `@chordsketch/wasm`, open and merge a pull request
  raising the pins, and publish the other packages from that commit. The
  packages would ship from a commit other than the tag, and the release would
  wait on a pull request's CI between the two publishes.
- **One npm workspace with a single lockfile.** The same linking comes for
  free, but every package's CI and install instructions would change for a
  problem that concerns one dependency.
- **`file:../npm` in `package.json`.** The publish checks reject it, and it
  would reach users.
- **`overrides` in `package.json`.** npm refuses an override that conflicts
  with a direct dependency's range unless the range is `$`-referenced, and the
  published manifest would carry a path.
- **Keep the own cadence and publish the packages after each release.** This
  is the three-step follow-up the change removes.

## References

- ADR-0064, ADR-0065, ADR-0069 — the own cadence this replaces
- `scripts/check-version-consistency.py` `lockfile_link_problems`
- `scripts/_publish_checks.py` `npm_dependency_problems`
- `scripts/publish-registries.py` `ensure_wasm_built`, `wasm_pack_needed`
