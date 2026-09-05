# 0063. The MCP server is a `chordsketch mcp` subcommand, not a package

- **Status**: Accepted
- **Date**: 2026-09-06

## Context

ChordSketch already meets AI-assisted workflows through a Claude Code skill
that teaches an assistant to drive the CLI ([ADR-0059](0059-claude-code-skill-ships-as-a-marketplace-plugin.md)).
What it does not have is a **callable** surface: a
[Model Context Protocol](https://modelcontextprotocol.io/) server, whose
tools an assistant invokes directly instead of composing a shell command and
parsing what comes back. ADR-0059 anticipated this — "an MCP server exposes
callable tools; a skill teaches an agent to use what is already installed.
They compose" — and deferred the server to its own decision. This is it.

An MCP client launches a server as a **subprocess**: a `command` and its
`args`, speaking JSON-RPC over stdio. So the question "where does the server
live" is really "which executable does the user already have", and four
constraints bound the answer.

**npm publishing is manual.** Per [ADR-0008](0008-npm-publishing-is-local.md)
every npm publish is a maintainer-local operation; CI never publishes. A Node
MCP server that is not on npm cannot be launched with `npx`, which is the only
thing that makes the Node shape attractive.

**The packaging channels install exactly one binary.** The Homebrew formula
template ends in `bin.install "chordsketch"`; the Scoop manifest declares
`"bin": "chordsketch.exe"`. `chordsketch-lsp` is built by `release.yml` and
copied into every release archive, and *no* packaging channel installs it —
it reaches users only through the VS Code extension, which downloads it from
the release by name. It is not published to crates.io either. A second binary
is therefore not a distribution channel; it is an artefact in a tarball.

**The CLI is dependency-light on purpose.** `crates/cli` has three external
dependencies, and its `--warnings-json` path hand-escapes two string fields
specifically to stay out of a serde dependency tree.

**The workspace is organised one crate per concern**, and a protocol server
speaking a line protocol over stdio already has a precedent here:
`chordsketch-lsp` is its own crate built on `tower-lsp` rather than a
hand-rolled implementation of LSP.

## Decision

1. The tools live in a new **library** crate, `chordsketch-mcp`
   (`crates/mcp`), which calls the workspace crates directly. `src/ops.rs`
   holds the ChordPro operations as plain functions with no MCP types in
   their signatures; `src/server.rs` is the protocol adapter over it.
2. The **executable entry point is `chordsketch mcp`**, a subcommand of the
   existing CLI. No second binary ships.
3. The protocol is spoken by [`rmcp`](https://crates.io/crates/rmcp), the
   official Rust MCP SDK, over its stdio transport.
4. **Six tools** ship: `render_chordpro` (text / HTML, with `transpose`),
   `parse_chordpro`, `validate_chordpro`, `format_chordpro`,
   `chord_diagram_svg` and `list_directives`. PDF rendering, iReal Pro, and
   configuration files are deliberately not exposed.
5. The server has **no filesystem and no network access**. Every tool takes
   ChordPro source as a string, capped at the parser's own 10 MiB limit, and
   renders against the built-in configuration.
6. `crates/mcp` is **not** a fourth member of the FFI / WASM / NAPI
   sister-site group in `.claude/rules/fix-propagation.md`.

## Rationale

**Riding the CLI is what makes the server reachable.** `chordsketch mcp` is
served by every channel that installs the binary — Homebrew, MacPorts, Scoop,
winget, Chocolatey, Snap, AUR, Flatpak, Nix, `cargo install`, and the
`ghcr.io/koedame/chordsketch` image, whose entrypoint is the binary itself, so
`docker run -i --rm ghcr.io/koedame/chordsketch mcp` is a valid client
configuration on day one. A `chordsketch-mcp` binary would have reached the
release tarball and nothing else, exactly as `chordsketch-lsp` does today,
unless ten packaging manifests were also changed — errors in which surface
only at release time. The client configuration is one line either way
(`"command": "chordsketch", "args": ["mcp"]`), so the second binary buys
nothing the subcommand does not already give.

**A Node package cannot be launched.** `npx @chordsketch/mcp` requires the
package to be on npm, and ADR-0008 makes that a manual step outside CI. Even
published, the Node shape assumes a Node toolchain and a reachable registry on
top of the shell the assistant already has — the same argument ADR-0059 used
to make the skill CLI-first, and the same conclusion.

**The SDK rather than a hand-rolled JSON-RPC loop.** Protocol correctness is
the whole value of an MCP server; version negotiation and the response shapes
are the SDK's job, and owning a wire protocol by hand is what
`chordsketch-lsp` already declined to do with `tower-lsp`. The measured cost
is small because the async and serialisation halves of the tree are already
paid for by that crate: `rmcp` 3.2.0 adds **9 third-party packages** to
`Cargo.lock` (`rmcp`, `rmcp-macros`, `pastey`, `darling` ×3, `schemars_derive`,
`tokio-stream`, `base64` 0.23) — `tokio`, `serde`, `serde_json`, `schemars`,
`futures` and `uuid` are all already there. Its `rust-version` is 1.88, the
workspace MSRV exactly, and `cargo audit` reports no advisory against any of
the added crates.

**The binary-size cost is real but small.** A release build of the CLI grows
from 8,633,528 to 10,248,712 bytes — **+1.54 MiB, +19%** — for every user
including those who never run `mcp`. Against a feature that would otherwise
reach no packaged user at all, this is the cheaper side of the trade.

**Six tools, not a projection of the API surface.** The cut is by what an
assistant does with a chart: show it (`render_chordpro`, which also covers
transposition — the SDK models it as a render option, not an operation),
understand it (`parse_chordpro` — the one thing the command line has no path
for at all, called out as a gap in ADR-0059), check it
(`validate_chordpro`), tidy it (`format_chordpro`), illustrate a chord
(`chord_diagram_svg`), and know the vocabulary before writing one
(`list_directives`). The exclusions are as deliberate: a **PDF** returned over
MCP is base64 in the model's context, unreadable and expensive, and the CLI
writes one to a path in one command; **iReal Pro** and **config presets** are
CLI operations no assistant has asked for through this surface yet. Both are
additive later; a tool that ships and then has to be withdrawn is not.

**No filesystem access is a feature, not a limitation.** The assistant
already has file tools, so the server taking source text costs a caller
nothing — and it means there is no path to traverse, no config file to
resolve, and no sandbox agreement to negotiate between the client and the
server. `Config::defaults()` is the built-in configuration, read from a
compiled-in string.

**Not a binding.** The FFI / WASM / NAPI group exists because those three
re-export one API surface into three host languages, so a fix to one is a fix
owed to the others. `crates/mcp` consumes the workspace crates the way
`crates/cli` does, and its tool set is a cut for AI callers rather than a
projection of that surface — `parse_chordpro` returns the parser's own AST,
without the `{key}` canonicalisation `@chordsketch/wasm`'s `parseChordpro`
applies for the React preview. Treating it as a fourth sister site would
oblige every future binding change to grow a tool, which is the opposite of
the cut this ADR makes.

## Consequences

- Every install channel and the Docker image serve the MCP server from the
  next release, with no packaging change.
- `chordsketch-mcp` must be published to crates.io **before** `chordsketch`,
  because the CLI depends on it. `docs/releasing.md` step 6 and the
  publishing-order list gain an entry, the crates.io channel row moves from 8
  lib crates to 9, and `ci/release-channels.toml` gains a `crates-io-mcp`
  channel so the post-release rollup fails if that publish is skipped.
- The MacPorts Portfile's `cargo.crates` block grows by the nine added
  packages at the next release. It is regenerated from the tagged lockfile by
  `scripts/macports-regen-cargo-crates.py`, which the release process already
  runs, so this needs no new step.
- The CLI binary carries an async runtime it does not use outside `mcp`.
  Should the size ever matter more than the reach, the reversal is a Cargo
  feature on the `chordsketch-mcp` dependency, not a redesign.
- The tool set will be asked to grow. Additions go through the cut in
  Decision 4 — "what does an assistant do with this" — not through parity
  with the bindings.
- The Claude Code skill (ADR-0059) is **not** updated in the same change.
  That skill documents the *published* surface, and `chordsketch mcp` does
  not exist in a released binary until the next release. Cross-referencing
  the two belongs to the release that ships the subcommand.

## Alternatives considered

**A Node package over `@chordsketch/node` or `@chordsketch/wasm`.** Rejected:
its one advantage is `npx`, which ADR-0008 removes by making npm publishing a
manual step, and it adds a Node runtime requirement plus a second layer
between the tools and the renderers.

**A separate `chordsketch-mcp` binary, mirroring `chordsketch-lsp`.**
Rejected: it reaches the release tarball and nothing else. The precedent it
mirrors is the evidence against it — `chordsketch-lsp` is installed by none of
the ten packaging channels and is not on crates.io. Serving the same
one-line client configuration through a binary that ten manifests would have
to be taught about is cost without benefit.

**An MCP module inside `crates/cli`.** Rejected: it avoids one crates.io
publish step, at the price of putting a protocol server and its dependency
footprint inside the front-end crate. The workspace's shape is one crate per
concern, and the library form also lets a Rust host embed the same tools.

**Hand-rolling the JSON-RPC loop to avoid `rmcp`.** Rejected: the measured
dependency cost is 9 packages against a lockfile that already carries the
async and serialisation halves, and the alternative is owning protocol-version
negotiation and the evolving response shapes by hand — which `chordsketch-lsp`
already declined for LSP.

**Exposing every binding export as a tool.** Rejected: mechanical exposure
produces a tool list the model has to read past on every call, and puts PDF
bytes in its context. Six tools cut by task is the surface; growth goes
through the same cut.

## References

- [ADR-0008](0008-npm-publishing-is-local.md) — npm publishing is a
  maintainer-local manual step, which is what rules out the `npx` shape
- [ADR-0059](0059-claude-code-skill-ships-as-a-marketplace-plugin.md) — the
  skill this server composes with, and its CLI-first rationale
- `crates/mcp/README.md` — the tool table and client configuration
- `docs/sdk/tasks/mcp.md` — the user-facing setup guide
- `.claude/rules/fix-propagation.md` — the sister-site group Decision 6
  deliberately does not join
- Watch signal: if the CLI ever grows a machine-readable AST output, the
  `parse_chordpro` tool and the skill's Node-based `parse` recipe both
  collapse onto it, and this ADR's Decision 4 should be revisited.
