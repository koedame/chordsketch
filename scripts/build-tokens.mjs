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
 * Parse a `:root` body into an ordered list of `{ group, name, value }`.
 *
 * A comment marks a group boundary when it is either rail-fenced
 * (`/* ---- Name ---- *\/`, the top-level section dividers) or its text matches
 * a known group in GROUP_COMMENTS (the rail-less `Surface / border aliases` /
 * `Text aliases` sub-comments). Any rail-fenced divider whose name is not in
 * the map still surfaces as a group and makes buildBlock fail loudly, so a new
 * tokens.css section cannot be silently absorbed into the previous group.
 * Every other comment (explanatory blocks, trailing `/* 4 *\/` notes) is dropped.
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
  const re = /@@GROUP:(.+?)@@|--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(withSentinels)) !== null) {
    if (m[1] !== undefined) group = m[1];
    else items.push({ group, name: m[2], value: m[3].trim() });
  }
  return items;
}

/** Build the full generated token region (selector block + @media override). */
function buildBlock(target, mainItems, overrideItems) {
  const name = (n) => (target.prefix ? `cs-${n}` : n);
  const value = (v) => (target.prefix ? v.replace(/var\(--/g, "var(--cs-") : v);
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
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:/g)) {
    names.add(prefix ? m[1].replace(/^cs-/, "") : m[1]);
  }
  return names;
}

/** Replace the token region of `file`, inserting the markers on first run. */
function spliceRegion(file, target, block) {
  const region = `${START}\n${block}\n${END}`;
  const sIdx = file.indexOf(START);
  if (sIdx !== -1) {
    const eIdx = file.indexOf(END, sIdx);
    if (eIdx === -1) throw new Error(`${target.path}: start marker without end marker`);
    return file.slice(0, sIdx) + region + file.slice(eIdx + END.length);
  }
  // First run: no markers yet. Replace the existing token region, located from
  // the selector block opener through the close of the reduced-motion override.
  const opener = `${target.selectors.join(",\n")} {`;
  const startIdx = file.indexOf(opener);
  if (startIdx === -1) throw new Error(`${target.path}: token block opener not found`);
  const mediaIdx = file.indexOf("@media (prefers-reduced-motion: reduce) {", startIdx);
  if (mediaIdx === -1) throw new Error(`${target.path}: reduced-motion override not found`);
  const open = file.indexOf("{", mediaIdx);
  let depth = 0;
  let endIdx = -1;
  for (let i = open; i < file.length; i++) {
    if (file[i] === "{") depth++;
    else if (file[i] === "}" && --depth === 0) { endIdx = i + 1; break; }
  }
  if (endIdx === -1) throw new Error(`${target.path}: unterminated reduced-motion override`);
  return file.slice(0, startIdx) + region + file.slice(endIdx);
}

function main() {
  const tokens = readFileSync(TOKENS_CSS, "utf8");
  const mainItems = parseTokens(sliceBlock(tokens, /:root\s*\{/));
  const overrideItems = parseTokens(
    sliceBlock(sliceBlock(tokens, /@media \(prefers-reduced-motion: reduce\)\s*\{/), /:root\s*\{/),
  );

  const sourceNames = new Set([
    ...mainItems.map((i) => i.name),
    ...overrideItems.map((i) => i.name),
  ]);

  for (const target of TARGETS) {
    const block = buildBlock(target, mainItems, overrideItems);

    // Completeness self-check: every source token reaches the target, and no
    // token is invented. Fail loudly with the diff if the sets diverge.
    const emitted = emittedNames(block, target.prefix);
    const dropped = [...sourceNames].filter((n) => !emitted.has(n));
    const invented = [...emitted].filter((n) => !sourceNames.has(n));
    if (dropped.length || invented.length) {
      throw new Error(
        `${target.path}: token set mismatch vs tokens.css` +
          (dropped.length ? `\n  dropped: ${dropped.join(", ")}` : "") +
          (invented.length ? `\n  invented: ${invented.join(", ")}` : ""),
      );
    }

    const path = join(repoRoot, target.path);
    const before = readFileSync(path, "utf8");
    const after = spliceRegion(before, target, block);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`updated ${target.path}`);
    } else {
      console.log(`unchanged ${target.path}`);
    }
  }
}

main();
