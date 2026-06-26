#!/usr/bin/env node
/*
 * Design-token generator (ADR-0038).
 *
 * `design-system/tokens.css` is the single authored source of truth for the
 * design tokens. This script projects that file's `:root` block and its
 * `@media (prefers-reduced-motion: reduce)` override into the token region of
 * three derived stylesheets so they can never drift from the source:
 *
 *   - packages/react-ui/src/styles.css        (--cs-* prefix, primitive selectors)
 *   - packages/react/src/styles.css           (--cs-* prefix, chordsketch-* selectors)
 *   - packages/ui-irealb-editor/src/style.css (bare names, :root)
 *
 * Only the token region is generated; each file's header comment and its
 * hand-authored component rules are left untouched. The region is delimited by
 * the @generated markers below so it can be located and replaced on every run.
 *
 * The generator is deterministic, so the CI gate (regenerate + `git diff
 * --exit-code`) catches drift but not correctness. The validations below close
 * that gap: a token the parser cannot recognise, a value the parser would
 * truncate, or a reference that would not resolve all fail loudly (throw,
 * non-zero exit, no file written) rather than emitting wrong-but-stable CSS.
 *
 * Zero dependencies. Run from the repo root: `node scripts/build-tokens.mjs`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_CSS = join(repoRoot, "design-system/tokens.css");

const START =
  "/* @generated:start — DO NOT EDIT. Source: design-system/tokens.css. Run: node scripts/build-tokens.mjs */";
const END = "/* @generated:end */";

// tokens.css group-divider text -> friendly group comment used in the derived
// stylesheets. The wording matches the existing hand-written files so the
// regenerated diff stays minimal. Two source groups (Surface / Text aliases)
// intentionally fold into one friendly group, as the existing files do.
const GROUP_COMMENTS = new Map([
  ["Color: Crimson (the only accent)", "Crimson — the only accent."],
  ["Color: Ink (warm neutrals)", "Ink — warm neutrals."],
  ["Surface / border aliases", "Surface / border / text aliases."],
  ["Text aliases", "Surface / border / text aliases."],
  ["Color: Semantic", "Semantic."],
  ["Focus", "Focus."],
  ["Typography: families", "Typography families."],
  ["Typography: sizes (rem at 16px root)", "Type scale."],
  ["Space: 4pt baseline", "4pt spacing scale."],
  ["Radius", "Radius."],
  ["Elevation", "Elevation."],
  ["Motion", "Motion."],
  ["Container max-widths", "Container max-widths."],
]);

const TARGETS = [
  {
    path: "packages/react-ui/src/styles.css",
    prefix: true,
    selectors: [
      ".btn", ".song-card", ".setlist", ".featured-card", ".badge", ".pill",
      ".field", ".input", ".textarea", ".select", ".segmented", ".check",
      ".radio", ".switch",
    ],
  },
  {
    path: "packages/react/src/styles.css",
    prefix: true,
    selectors: [
      ".chordsketch-chord-pro-editor", ".chordsketch-chord-pro-preview",
      ".chordsketch-source-area", ".chordsketch-split-layout",
      ".chordsketch-preview",
    ],
  },
  {
    path: "packages/ui-irealb-editor/src/style.css",
    prefix: false,
    selectors: [":root"],
  },
];

/** Return the content between a header's opening `{` and its matching `}`. */
function sliceBlock(text, headerRegex) {
  const m = headerRegex.exec(text);
  if (!m) throw new Error(`block not found for ${headerRegex}`);
  const open = text.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unterminated block for ${headerRegex}`);
}

/**
 * Every `--name` *declared* (left of `:`) in a block, found independently of
 * the strict parser. A custom-property declaration sits after `;`, `{` or
 * whitespace; a `var(--x)` reference sits after `(`, so the negative lookbehind
 * excludes references. Compared against the parser's output in `main` so any
 * token the parser fails to recognise (underscore name, missing `;`, an
 * unsupported value shape) surfaces as a mismatch instead of a silent drop.
 */
function rawDeclNames(text) {
  return [...text.matchAll(/(?<![\w(])--([\w-]+)\s*:/g)].map((m) => m[1]);
}

/** Throw if a token value has unbalanced quotes or parentheses — which is how a
 *  `;` inside a value (e.g. a `data:`/`url(...)` value) shows up after the
 *  `[^;]+` capture truncates it at the first `;`. */
function assertBalanced(value, name) {
  let paren = 0, dq = false, sq = false;
  for (const ch of value) {
    if (ch === '"' && !sq) dq = !dq;
    else if (ch === "'" && !dq) sq = !sq;
    else if (!dq && !sq) {
      if (ch === "(") paren++;
      else if (ch === ")") paren--;
    }
    if (paren < 0) break;
  }
  if (paren !== 0 || dq || sq) {
    throw new Error(
      `token --${name}: unbalanced quote/parenthesis in value ` +
        `(a ';' inside the value would truncate it): ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Parse a `:root` body into an ordered list of `{ group, name, value }`.
 *
 * A comment marks a group boundary when it is either rail-fenced
 * (`/* ---- Name ---- *\/`, the top-level section dividers) or its text matches
 * a known group in GROUP_COMMENTS (the rail-less `Surface / border aliases` /
 * `Text aliases` sub-comments). Any rail-fenced divider whose name is not in
 * the map still surfaces as a group and makes buildBlock fail loudly, so a new
 * tokens.css section cannot be silently absorbed into the previous group.
 * Every other comment (explanatory blocks, trailing `/* 4 *\/` notes) is dropped.
 *
 * Any non-blank text between recognised declarations (e.g. a declaration the
 * value/name patterns could not match) throws, so an unparseable token cannot
 * pass unnoticed.
 */
function parseTokens(inner) {
  const withSentinels = inner.replace(/\/\*[\s\S]*?\*\//g, (c) => {
    const railed = /-{3,}/.test(c);
    const name = c.replace(/^\/\*/, "").replace(/\*\/$/, "").replace(/-{3,}/g, "").trim();
    if (railed || GROUP_COMMENTS.has(name)) return `\n@@GROUP:${name}@@\n`;
    return "";
  });
  const items = [];
  let group = null;
  const re = /@@GROUP:(.+?)@@|--([\w-]+)\s*:\s*([^;]+);/g;
  let m, lastEnd = 0;
  while ((m = re.exec(withSentinels)) !== null) {
    const between = withSentinels.slice(lastEnd, m.index);
    if (between.trim() !== "") {
      throw new Error(`unrecognised text in token block near: ${JSON.stringify(between.trim().slice(0, 80))}`);
    }
    lastEnd = re.lastIndex;
    if (m[1] !== undefined) {
      group = m[1];
    } else {
      const value = m[3].trim();
      assertBalanced(value, m[2]);
      items.push({ group, name: m[2], value });
    }
  }
  const tail = withSentinels.slice(lastEnd).trim();
  if (tail !== "") {
    throw new Error(`unrecognised trailing text in token block: ${JSON.stringify(tail.slice(0, 80))}`);
  }
  return items;
}

/** Build the full generated token region (selector block + @media override). */
function buildBlock(target, mainItems, overrideItems) {
  const name = (n) => (target.prefix ? `cs-${n}` : n);
  // Rewrite token references to the prefixed namespace, tolerating whitespace
  // after the paren (`var( --x )`) so a spaced reference is not left dangling.
  const value = (v) =>
    target.prefix ? v.replace(/var\(\s*--/g, (mm) => mm.replace(/--$/, "--cs-")) : v;
  const decl = (it, indent) => `${indent}--${name(it.name)}: ${value(it.value)};`;

  const lines = [`${target.selectors.join(",\n")} {`];
  let lastFriendly;
  mainItems.forEach((it, i) => {
    const friendly = GROUP_COMMENTS.get(it.group);
    if (friendly === undefined) throw new Error(`unmapped token group: ${it.group}`);
    if (friendly !== lastFriendly) {
      if (i > 0) lines.push("");
      lines.push(`  /* ${friendly} */`);
      lastFriendly = friendly;
    }
    lines.push(decl(it, "  "));
  });
  lines.push("}");

  const mediaSelector = target.selectors.map((s) => `  ${s}`).join(",\n");
  const media = [
    "@media (prefers-reduced-motion: reduce) {",
    `${mediaSelector} {`,
    ...overrideItems.map((it) => decl(it, "    ")),
    "  }",
    "}",
  ];

  return `${lines.join("\n")}\n\n${media.join("\n")}`;
}

/** Base token names (cs- prefix stripped) declared anywhere in a block. */
function emittedNames(block, prefix) {
  const names = new Set();
  for (const m of block.matchAll(/(?<![\w(])--([\w-]+)\s*:/g)) {
    names.add(prefix ? m[1].replace(/^cs-/, "") : m[1]);
  }
  return names;
}

/** For a prefixed block, assert every `var(--…)` reference was rewritten into
 *  the `--cs-*` namespace and resolves to a token declared in the same block —
 *  catching an unprefixed (and therefore dangling) reference. */
function assertRefsResolve(block, path) {
  const declared = new Set(
    [...block.matchAll(/(?<![\w(])--([\w-]+)\s*:/g)].map((m) => m[1]),
  );
  for (const m of block.matchAll(/var\(\s*--([\w-]+)/g)) {
    const ref = m[1];
    if (!ref.startsWith("cs-")) {
      throw new Error(`${path}: var() reference --${ref} is not in the --cs-* namespace (prefix rewrite missed it)`);
    }
    if (!declared.has(ref)) {
      throw new Error(`${path}: dangling var() reference --${ref} (not declared in the generated block)`);
    }
  }
}

/** Replace the token region of `file` between the @generated markers. A target
 *  must carry the markers already; a new target file gets them added by hand
 *  once, then the generator maintains the block between them. */
function spliceRegion(file, target, block) {
  const sIdx = file.indexOf(START);
  if (sIdx === -1) {
    throw new Error(
      `${target.path}: missing @generated:start marker. Add the ` +
        `@generated:start / @generated:end markers around the token region ` +
        `of a new target file once (by hand); the generator maintains the ` +
        `block between them thereafter.`,
    );
  }
  const eIdx = file.indexOf(END, sIdx);
  if (eIdx === -1) throw new Error(`${target.path}: @generated:start without @generated:end`);
  return file.slice(0, sIdx) + `${START}\n${block}\n${END}` + file.slice(eIdx + END.length);
}

function main() {
  const tokens = readFileSync(TOKENS_CSS, "utf8");
  const mainInner = sliceBlock(tokens, /:root\s*\{/);
  const overrideInner = sliceBlock(
    sliceBlock(tokens, /@media \(prefers-reduced-motion: reduce\)\s*\{/),
    /:root\s*\{/,
  );

  // Parser-independent ground truth: every declaration name in the source.
  // Parser blind spots are detected by comparing against it. Duplicates are
  // checked within each block — a token legitimately appears in both `:root`
  // and the reduced-motion override (that is what the override is), so the two
  // blocks are not pooled for the duplicate test.
  const rawMain = rawDeclNames(mainInner);
  const rawOverride = rawDeclNames(overrideInner);
  for (const [label, names] of [[":root", rawMain], ["reduced-motion override", rawOverride]]) {
    const d = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (d.length) throw new Error(`tokens.css declares duplicate token(s) in the ${label} block: ${d.join(", ")}`);
  }
  const rawSet = new Set([...rawMain, ...rawOverride]);

  const mainItems = parseTokens(mainInner);
  const overrideItems = parseTokens(overrideInner);
  const sourceNames = new Set([...mainItems, ...overrideItems].map((i) => i.name));

  const notParsed = [...rawSet].filter((n) => !sourceNames.has(n));
  const invented = [...sourceNames].filter((n) => !rawSet.has(n));
  if (notParsed.length || invented.length) {
    throw new Error(
      "tokens.css declarations the parser did not faithfully reproduce" +
        (notParsed.length ? `\n  not parsed (check for a missing ';' or an unsupported value): ${notParsed.join(", ")}` : "") +
        (invented.length ? `\n  parser produced a name absent from the source: ${invented.join(", ")}` : ""),
    );
  }

  // Build + validate every target before writing any, so a failure on a later
  // target never leaves an earlier one written.
  const outputs = [];
  for (const target of TARGETS) {
    const block = buildBlock(target, mainItems, overrideItems);

    // Self-check: the emitted declaration set equals the source token set.
    const emitted = emittedNames(block, target.prefix);
    const dropped = [...sourceNames].filter((n) => !emitted.has(n));
    const extra = [...emitted].filter((n) => !sourceNames.has(n));
    if (dropped.length || extra.length) {
      throw new Error(
        `${target.path}: token set mismatch vs tokens.css` +
          (dropped.length ? `\n  dropped: ${dropped.join(", ")}` : "") +
          (extra.length ? `\n  invented: ${extra.join(", ")}` : ""),
      );
    }
    if (target.prefix) assertRefsResolve(block, target.path);

    const path = join(repoRoot, target.path);
    const before = readFileSync(path, "utf8");
    outputs.push({ relpath: target.path, path, before, after: spliceRegion(before, target, block) });
  }

  for (const o of outputs) {
    if (o.after !== o.before) {
      writeFileSync(o.path, o.after);
      console.log(`updated ${o.relpath}`);
    } else {
      console.log(`unchanged ${o.relpath}`);
    }
  }
}

main();
