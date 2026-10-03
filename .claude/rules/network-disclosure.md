# Network Disclosure

ChordSketch tells its users it collects nothing. That statement is only true
while every connection the software makes is listed where users will read it:
the `## Privacy` section of `README.md` and the update-check paragraph under
`## Desktop application`.

## The rule

A change that makes any ChordSketch surface contact a host that is not the
one serving it MUST, in the same pull request:

1. Add a row to the table in `README.md` `## Privacy` — when it happens,
   which host, what is sent — and update `## Desktop application` if the
   desktop app is involved.
2. Prefer not adding the connection. A web font, script, image, or analytics
   snippet loaded from a third-party host hands the visitor's IP address to
   that host. Bundle the file instead (`packages/playground/src/fonts.css` is
   the pattern for fonts).
3. Keep `packages/playground/tests-e2e/no-external-requests.spec.ts` green.
   It fails on any request from the deployed pages (the playground and the
   docs site) to another origin, with no per-origin exception — do not add
   one just to make it pass. A connection from those pages has exactly one
   compliant path: remove it by bundling, per rule 2. A connection from a
   surface this spec does not exercise (the desktop app, the CLI, an editor
   integration, the MCP server) is not constrained by it; rule 1 still
   applies.

"Surface" means the playground and docs site, the desktop app, the CLI, the
libraries and bindings, the editor integrations, and the MCP server.

## Not covered

- Package managers, `cargo`, `npm` and similar contacting their own
  registries when a user installs ChordSketch.
- A request that only the user's own document can cause, such as a remote
  `{image}` URL they typed. It stays listed in the Privacy table, and no
  bundled sample may do it.

## Why

The playground, the docs site and the design-system pages loaded fonts from
Google Fonts and the iReal Pro route loaded Bravura Text from jsDelivr, and
the desktop app checks GitHub for updates on every launch and every 24
hours while it runs, while nothing the user could read said so, and the
README promised more than the software did. Writing the connections down,
and testing that the web pages make none beyond their own host, removes
the gap.
