#!/usr/bin/env node
/*
 * Chrome / layout CSS generator (ADR-0061).
 *
 * `design-system/DESIGN.md` names two canonical class families. The primitives
 * (`.btn`, `.input`, `.badge`, …) ship from `@chordsketch/react-ui`; the chrome
 * and layout vocabulary — `.topnav` and its parts, `.sidenav`, the
 * `.pane` / `.pane-head` / `.pane-body` split-pane frame, and the `.stack`
 * vertical-flow primitive — existed only inside the static reference pages
 * under `design-system/`, which are not a published artefact.
 *
 * This script projects those rules out of the reference HTML into the
 * `@generated:chrome` region of `packages/react-ui/src/styles.css`, rewriting
 * every custom property into the package's `--cs-*` namespace. The output is
 * committed and CI regenerates it and asserts a zero diff (`tokens-sync.yml`),
 * so the shipped stylesheet is a projection of `design-system/` rather than a
 * second, drift-prone copy of it — the same idiom `scripts/build-tokens.mjs`
 * uses for token values (ADR-0038).
 *
 * The reference pages are not internally uniform: `ui_kits/web/editor-chord-
 * footer.html` is a deliberately denser variant of the editor (52px nav,
 * tighter panes). `DESIGN.md` §9 resolves this by naming
 * `ui_kits/web/editor.html` the canonical chrome source; GROUPS below is that
 * resolution made mechanical — one named source file per family, and no other
 * file is read. The validations then make a rename, a deletion, or a newly
 * introduced disagreement between the two files that both define `.topnav`
 * fail loudly rather than emit a plausible but wrong stylesheet.
 *
 * Zero dependencies. Run from the repo root: `node scripts/build-chrome-css.mjs`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const TOKENS_CSS = "design-system/tokens.css";
const TARGET = "packages/react-ui/src/styles.css";

const START =
  "/* @generated:chrome:start — DO NOT EDIT. Source: design-system/ (see scripts/build-chrome-css.mjs). Run: node scripts/build-chrome-css.mjs */";
const END = "/* @generated:chrome:end */";

const EDITOR = "design-system/ui_kits/web/editor.html";
const NAVIGATION = "design-system/preview/components-navigation.html";
const STACK = "design-system/preview/layout-stack.html";

/**
 * One entry per class family: the single canonical source file it is read
 * from, and the selectors taken from that file. `.topnav` is split across two
 * entries because the editor sample defines the bar and its editor-side parts
 * while the navigation preview defines the link row — the two sets are
 * disjoint, and `assertTopnavBaseAgrees` checks the shared base rule matches.
 */
const GROUPS = [
  {
    title: "Top navigation — the app bar and its editor-side parts",
    source: EDITOR,
    match: (sel) => /^\.topnav\b/.test(sel),
  },
  {
    title: "Top navigation — the link row and trailing meta",
    source: NAVIGATION,
    match: (sel) => /^\.topnav\s+\.(?:nav-links|right)\b/.test(sel),
  },
  {
    title: "Side navigation",
    source: NAVIGATION,
    match: (sel) => /^\.sidenav\b/.test(sel),
  },
  {
    title: "Panes — the split-pane frame",
    source: EDITOR,
    match: (sel) => /^\.pane(?:-head|-body)?\b/.test(sel),
  },
  {
    title: "Stack — the vertical-flow primitive (DESIGN.md §4.1)",
    source: STACK,
    match: (sel) => /^\.stack\b/.test(sel),
  },
];

const read = (relpath) => readFileSync(join(repoRoot, relpath), "utf8");

/** The concatenated contents of every `<style>` element in an HTML file. */
function styleSheets(html, relpath) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error(`${relpath}: no <style> block found`);
  return blocks.join("\n");
}

/** Strip CSS comments. The reference pages use them as section dividers only. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Split a stylesheet into top-level `{ selector, body }` rules, plus the
 * bodies of any at-rules (`@media`, …) so the caller can assert no in-scope
 * selector is hiding inside one — a nested rule would otherwise be dropped
 * silently.
 */
function topLevelRules(css) {
  const rules = [];
  const atRuleBodies = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) throw new Error("unterminated block in stylesheet");
    const prelude = css.slice(i, open).trim().replace(/\s+/g, " ");
    const body = css.slice(open + 1, close);
    if (prelude.startsWith("@")) atRuleBodies.push(body);
    else if (prelude !== "") rules.push({ selector: prelude, body });
    i = close + 1;
  }
  return { rules, atRuleBodies };
}

/** Split a declaration body on top-level `;` (parens and quotes are opaque). */
function declarations(body, selector) {
  const out = [];
  let buf = "";
  let paren = 0;
  let dq = false;
  let sq = false;
  for (const ch of body) {
    if (ch === '"' && !sq) dq = !dq;
    else if (ch === "'" && !dq) sq = !sq;
    else if (!dq && !sq) {
      if (ch === "(") paren++;
      else if (ch === ")") paren--;
      else if (ch === ";" && paren === 0) {
        if (buf.trim() !== "") out.push(buf.trim().replace(/\s+/g, " "));
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim() !== "") out.push(buf.trim().replace(/\s+/g, " "));
  if (paren !== 0 || dq || sq) {
    throw new Error(`${selector}: unbalanced quote/parenthesis in declarations`);
  }
  for (const d of out) {
    if (!d.includes(":")) throw new Error(`${selector}: unparsable declaration ${JSON.stringify(d)}`);
  }
  return out;
}

/**
 * Rewrite every custom property — declared or referenced — into the `--cs-*`
 * namespace. The package scopes its variables to its own selectors so a host's
 * `:root` neither leaks in nor is polluted (ADR-0038 constraint 2); a bare
 * `--stack-gap` left in place would be reachable from the host and break that
 * isolation, so it becomes `--cs-stack-gap` like everything else.
 */
const prefix = (decl) =>
  decl
    .replace(/(?<![\w-])--(?!cs-)([\w-]+)/g, "--cs-$1");

/** Selectors in `rules` that any group would take from this file. */
const matchingSelectors = (rules, groups) =>
  rules.filter((r) => groups.some((g) => g.match(r.selector))).map((r) => r.selector);

/**
 * The two files that both define `.topnav` must agree on the base rule, or the
 * union this generator emits would silently prefer one page's bar over the
 * other's. Compared as an ordered declaration list after whitespace
 * normalisation.
 */
function assertTopnavBaseAgrees(byFile) {
  const base = (relpath) => {
    const rule = byFile.get(relpath).find((r) => r.selector === ".topnav");
    if (!rule) throw new Error(`${relpath}: no \`.topnav\` base rule to compare`);
    return declarations(rule.body, ".topnav");
  };
  const a = base(EDITOR);
  const b = base(NAVIGATION);
  const norm = (ds) => [...ds].sort().join("; ");
  if (norm(a) !== norm(b)) {
    throw new Error(
      "`.topnav` base rule disagrees between the two canonical sources; pick one " +
        "and reconcile the other before regenerating:\n" +
        `  ${EDITOR}\n    ${norm(a)}\n  ${NAVIGATION}\n    ${norm(b)}`,
    );
  }
}

/** Token names declared in `tokens.css` (`:root` and the reduced-motion override). */
function tokenNames(css) {
  return new Set([...css.matchAll(/(?<![\w(])--([\w-]+)\s*:/g)].map((m) => m[1]));
}

/**
 * Assert every `var(--cs-…)` in the generated block resolves: either to a
 * design token (which `build-tokens.mjs` declares on these same selectors) or
 * to a custom property the block itself declares (`--cs-stack-gap`).
 */
function assertRefsResolve(block, tokens) {
  const local = new Set([...block.matchAll(/(?<![\w(])--cs-([\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of block.matchAll(/var\(\s*--([\w-]+)/g)) {
    const ref = m[1];
    if (!ref.startsWith("cs-")) {
      throw new Error(`var() reference --${ref} is not in the --cs-* namespace (prefix rewrite missed it)`);
    }
    const bare = ref.slice(3);
    if (!tokens.has(bare) && !local.has(bare)) {
      throw new Error(
        `dangling var() reference --${ref}: neither a token in ${TOKENS_CSS} nor declared in the generated block`,
      );
    }
  }
}

function spliceRegion(file, block) {
  const sIdx = file.indexOf(START);
  if (sIdx === -1) {
    throw new Error(
      `${TARGET}: missing @generated:chrome:start marker. Add the ` +
        `@generated:chrome:start / @generated:chrome:end markers around the ` +
        `chrome region once (by hand); the generator maintains the block ` +
        `between them thereafter.`,
    );
  }
  const eIdx = file.indexOf(END, sIdx);
  if (eIdx === -1) throw new Error(`${TARGET}: @generated:chrome:start without @generated:chrome:end`);
  return file.slice(0, sIdx) + `${START}\n${block}\n${END}` + file.slice(eIdx + END.length);
}

function main() {
  const sources = [...new Set(GROUPS.map((g) => g.source))];
  const byFile = new Map();
  for (const relpath of sources) {
    const css = stripComments(styleSheets(read(relpath), relpath));
    const { rules, atRuleBodies } = topLevelRules(css);
    for (const body of atRuleBodies) {
      const nested = matchingSelectors(topLevelRules(body).rules, GROUPS);
      if (nested.length) {
        throw new Error(
          `${relpath}: in-scope selector(s) inside an at-rule are not projected: ${nested.join(", ")}. ` +
            `Move them out, or teach this generator to emit the at-rule.`,
        );
      }
    }
    byFile.set(relpath, rules);
  }

  assertTopnavBaseAgrees(byFile);

  const sections = [];
  const seen = new Map();
  for (const group of GROUPS) {
    const picked = byFile.get(group.source).filter((r) => group.match(r.selector));
    if (picked.length === 0) {
      throw new Error(
        `no rule in ${group.source} matches the "${group.title}" family. ` +
          `A class was renamed or removed upstream; update GROUPS.`,
      );
    }
    const lines = [`/* ${group.title} — ${group.source} */`];
    for (const rule of picked) {
      const previous = seen.get(rule.selector);
      if (previous !== undefined) {
        throw new Error(`selector ${rule.selector} matched twice (${previous} and ${group.title})`);
      }
      seen.set(rule.selector, group.title);
      const decls = declarations(rule.body, rule.selector).map((d) => `  ${prefix(d)};`);
      lines.push(`${prefix(rule.selector)} {`, ...decls, "}");
    }
    sections.push(lines.join("\n"));
  }

  const block = sections.join("\n\n");
  assertRefsResolve(block, tokenNames(read(TOKENS_CSS)));

  const path = join(repoRoot, TARGET);
  const before = readFileSync(path, "utf8");
  const after = spliceRegion(before, block);
  if (after === before) {
    console.log(`unchanged ${TARGET}`);
  } else {
    writeFileSync(path, after);
    console.log(`updated ${TARGET}`);
  }
}

main();
