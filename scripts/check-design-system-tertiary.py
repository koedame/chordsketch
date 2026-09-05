#!/usr/bin/env python3
"""Tertiary-ink guard for the design-system static reference pages.

`--ink-500` / `--text-tertiary` is a non-text / large-text / disabled
tone, not a body-text tone: it is 3.53:1 on `--ink-0`, which clears the
3:1 WCAG 1.4.11 asks of non-text UI but not the 4.5:1 SC 1.4.3 asks of
text below 18.66px bold / 24px regular (ADR-0054, `DESIGN.md` §2.4).

`packages/react/tests/tertiary-ink.test.ts` and its `react-ui` twin pin
that constraint for the shipped stylesheets by allowlisting the selectors
allowed to paint with the tone. The nineteen static reference pages under
`design-system/` have no test runner of their own, so this script is
their equivalent: it walks every `<style>` block and inline `style`
attribute, collects the sites that set `color` to the tertiary tone, and
compares them against `TERTIARY_ALLOWED`.

Adding a site here means claiming it is not small text. Each one must be
one of the classes 1.4.3 / 1.4.11 exempt:

- separator glyphs — decorative punctuation between labelled items
- icon strokes — non-text UI, held to 3:1
- disabled controls — 1.4.3 exempts inactive components outright

Anything painting copy below 18.66px bold / 24px regular uses
`--text-secondary` (5.80:1 / 5.55:1 / 5.30:1 on the three light surfaces)
instead.

Usage:

    python3 scripts/check-design-system-tertiary.py

Exits 0 when the rendered set matches the allowlist exactly, 1 otherwise
(both a new unlisted site and a stale entry are failures — a stale entry
means the allowlist is claiming an exemption nothing uses any more).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESIGN_SYSTEM = REPO_ROOT / "design-system"

# Sites allowed to paint with the tertiary tone, keyed by the page they
# live on. A value is either a CSS selector or `inline <tag>` for a site
# declared in an element's `style` attribute.
TERTIARY_ALLOWED: dict[str, tuple[str, ...]] = {
    "preview/components-forms.html": (
        ".input:disabled, .textarea:disabled",  # disabled control
        ".select:disabled",  # disabled control
    ),
    "preview/components-modal.html": ("inline <svg>",),  # search icon stroke
    "preview/components-navigation.html": (".crumbs .sep",),  # separator glyph
    "preview/components-table.html": (
        "table.t thead th.sortable .arrow",  # sort icon stroke
    ),
    "ui_kits/web/editor-chord-footer.html": (".cins__chip:disabled",),  # disabled control
    "ui_kits/web/editor-irealb.html": (".topnav .crumbs .sep",),  # separator glyph
    "ui_kits/web/editor.html": (".topnav .crumbs .sep",),  # separator glyph
    "ui_kits/web/library.html": (".topnav .search svg",),  # search icon stroke
    "ui_kits/web/sidebar-floating.html": (
        ".account .chev",  # chevron icon stroke
        ".icon-btn",  # icon-only buttons (each carries an aria-label)
        ".nav a svg",  # nav icon strokes
    ),
    "ui_kits/web/viewer.html": (".topnav .crumbs .sep",),  # separator glyph
}

STYLE_BLOCK = re.compile(r"<style[^>]*>(.*?)</style>", re.S)
CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
CSS_RULE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.S)
INLINE_STYLE = re.compile(r"<([A-Za-z][\w-]*)\b[^>]*?style=\"([^\"]*)\"", re.S)
# `color: var(--text-tertiary)` / `var(--ink-500)`, but not `background-color`
# or any other `*-color` longhand — those are the non-text uses the tone is for.
TERTIARY_COLOR = re.compile(r"(?<![-\w])color:\s*var\(--(?:text-tertiary|ink-500)\b")


def normalise(selector: str) -> str:
    """Collapse a selector's whitespace so formatting is not part of the key."""
    return " ".join(CSS_COMMENT.sub("", selector).split())


def tertiary_sites(html: str) -> list[str]:
    """Return every site in one page that sets `color` to the tertiary tone."""
    sites: list[str] = []
    for block in STYLE_BLOCK.findall(html):
        for selector, body in CSS_RULE.findall(block):
            if TERTIARY_COLOR.search(body):
                sites.append(normalise(selector))
    for tag, style in INLINE_STYLE.findall(html):
        if TERTIARY_COLOR.search(style):
            sites.append(f"inline <{tag}>")
    return sorted(sites)


def main() -> int:
    failures: list[str] = []
    for path in sorted(DESIGN_SYSTEM.rglob("*.html")):
        page = path.relative_to(DESIGN_SYSTEM).as_posix()
        found = tertiary_sites(path.read_text(encoding="utf-8"))
        allowed = sorted(TERTIARY_ALLOWED.get(page, ()))
        if found == allowed:
            if allowed:
                print(f"[OK] {page}: {len(allowed)} exempt site(s)")
            continue
        for site in sorted(set(found) - set(allowed)):
            failures.append(f"{page}: {site} paints text with the tertiary tone")
        for site in sorted(set(allowed) - set(found)):
            failures.append(f"{page}: {site} is allowlisted but no longer exists")

    if failures:
        print()
        for failure in failures:
            print(f"[FAIL] {failure}")
        print()
        print(
            "`--ink-500` / `--text-tertiary` is a non-text / large-text / "
            "disabled tone (ADR-0054, DESIGN.md §2.4). Repoint small copy at "
            "`--text-secondary`, or — if the site really is a separator "
            "glyph, an icon stroke, or a disabled control — add it to "
            "TERTIARY_ALLOWED in this script with the reason. Remove entries "
            "that no longer exist in the same PR."
        )
        return 1

    print()
    print("[OK] every tertiary-tone site in design-system/ is allowlisted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
