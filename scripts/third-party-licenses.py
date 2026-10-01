#!/usr/bin/env python3
"""Build `THIRD_PARTY_LICENSES.md`, the third-party notice shipped with every binary.

    python3 scripts/third-party-licenses.py          regenerate the file
    python3 scripts/third-party-licenses.py --check  fail when it is out of date

MIT, Apache-2.0, BSD, ISC, Unicode-3.0 and MPL-2.0 all make the same
demand of a binary distribution: carry the copyright notice and the
license text of every dependency that is linked or bundled in, and (for
MPL-2.0) say where the source of the covered files can be had. This file
is that notice. It is generated from the lock files so it cannot drift
from the dependency graph by hand-editing, and `--check` (CI) fails the
moment a lock file changes the set of shipped packages without the file
being regenerated.

What goes in:

  - every Rust crate of the workspace (cargo-about; all features, every
    target, dev-dependencies excluded), with the license text found in
    the crate itself. Crates that publish no license file get the
    standard text with the copyright holders taken from their manifest
  - the npm packages that Vite / esbuild bundle into the desktop app, the
    playground and the VS Code extension. The tooling that only builds or
    tests them (`TOOLING`) is left out; anything not listed there is
    included, so a newly added dependency is covered by default
  - the fonts and glyph outlines copied into the source (`BUNDLED`)

`--check` needs no Rust or Node toolchain. Both hashes in the header are
recomputed from the files in the checkout: the first covers everything the
notice is built from, the second the body, so the check also catches a
hand edit. Only third-party packages count, so a release that bumps the
workspace version, or a dependency update that touches only the build
tooling, does not invalidate the file.

Regenerating needs `cargo-about` (`cargo install cargo-about --locked`),
network access for `cargo fetch`, and `npm ci --ignore-scripts` in each
directory of `NPM_SURFACES` (run it in `packages/react` first: the VS Code
extension links it and npm builds a linked package even with
`--ignore-scripts`).
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "THIRD_PARTY_LICENSES.md"

HEADER_INPUTS = "inputs-sha256"
HEADER_BODY = "body-sha256"

# License texts that exist only as files in the checkout (not derivable from
# a lock file). The generator and the input hash both read them.
BUNDLED = [
    (
        "Bravura (SMuFL music font)",
        "https://github.com/steinbergmedia/bravura",
        "SVG outlines of seven Bravura glyphs are embedded in the HTML and iReal "
        "renderers and in @chordsketch/react. They are derivative works of "
        "Bravura, redistributed under the SIL Open Font License 1.1 "
        "(see also NOTICE).",
        "crates/render-html/LICENSE-OFL.txt",
    ),
    (
        "Noto Sans CJK JP (subset)",
        "https://github.com/notofonts/noto-cjk",
        "A subset of Noto Sans CJK JP is embedded in the PDF renderer and so "
        "in every binary that links it. It is redistributed under the SIL "
        "Open Font License 1.1.",
        "crates/render-pdf/assets/OFL.txt",
    ),
]

# Directories with a package-lock.json whose packages end up inside a shipped
# bundle. `dev` says whether devDependencies are bundled too: Vite apps list
# what they bundle (React, CodeMirror, ...) as devDependencies, while the
# VS Code extension lists its runtime dependencies as dependencies and keeps
# its build tooling in devDependencies.
NPM_SURFACES = [
    ("apps/desktop", True),
    ("packages/playground", True),
    ("packages/vscode-extension", False),
]

# devDependencies that only build, type-check or test a bundle and are never
# part of it. Everything else in a `dev: True` surface is treated as bundled.
TOOLING = [
    "typescript",
    "vite",
    "vitest",
    "jsdom",
    "@types/*",
    "@playwright/*",
    "@axe-core/*",
    "@vitejs/*",
    "@sveltejs/vite-plugin-svelte",
    # Imported only under `import.meta.env.DEV`, so it is not in the build.
    "react-grab",
]

# Packages that ship only an SPDX tag file; their license text is the one of
# the project they come from.
NPM_LICENSE_FROM = {
    "@tauri-apps/plugin-dialog": "@tauri-apps/api",
    "@tauri-apps/plugin-opener": "@tauri-apps/api",
    "@tauri-apps/plugin-process": "@tauri-apps/api",
    "@tauri-apps/plugin-updater": "@tauri-apps/api",
}

MIT_TEXT = """\
MIT License

Copyright (c) {holders}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

OWN_NPM_SCOPE = "@chordsketch/"

PLACEHOLDER = re.compile(r"<year>\s*<(?:copyright holders|owner)>")

APACHE_APPENDIX = "APPENDIX: How to apply the Apache License"
APACHE_TEMPLATE_LINE = re.compile(r"^([ \t]*)Copyright\b.*$", re.M)


def normalize(text: str) -> str:
    """Same bytes everywhere: LF line ends, no trailing blank lines."""
    return text.replace("\r\n", "\n").strip("\n")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# Policy: about.toml (what the notice accepts) must match deny.toml (what CI
# allows), so a license cannot be allowed without being reproduced.
# --------------------------------------------------------------------------


def policy_mismatch() -> str | None:
    about = tomllib.loads((ROOT / "about.toml").read_text(encoding="utf-8"))
    deny = tomllib.loads((ROOT / "deny.toml").read_text(encoding="utf-8"))["licenses"]
    allowed = set(deny["allow"])
    for exception in deny.get("exceptions", []):
        allowed.update(exception["allow"])
    accepted = set(about["accepted"])
    if accepted == allowed:
        return None
    return (
        "about.toml and deny.toml disagree on the accepted licenses:\n"
        f"  only in about.toml: {sorted(accepted - allowed)}\n"
        f"  only in deny.toml:  {sorted(allowed - accepted)}"
    )


# --------------------------------------------------------------------------
# Rust
# --------------------------------------------------------------------------


def cargo_lock_packages(lock_text: str) -> list[tuple[str, str, str]]:
    """Third-party packages only: path crates (the workspace) have no source."""
    packages = tomllib.loads(lock_text).get("package", [])
    return sorted(
        (p["name"], p["version"], p.get("checksum", p["source"]))
        for p in packages
        if "source" in p
    )


def holders(crate: dict) -> str:
    names = [re.sub(r"\s*<[^>]*>", "", a).strip() for a in crate.get("authors") or []]
    names = [n for n in names if n]
    if names:
        return ", ".join(names)
    return f"The {crate['name']} authors ({crate.get('repository') or 'no repository listed'})"


def fill_placeholder(text: str, crate: dict) -> str:
    """Crates that publish no license file get cargo-about's SPDX template.

    The template carries `<year> <copyright holders>`, which reproduces no
    copyright notice at all. The manifest authors are the only holder
    information the crate itself provides, so they take its place.
    """
    if not PLACEHOLDER.search(text):
        return text
    filled = PLACEHOLDER.sub(lambda _: holders(crate), text)
    if re.search(r"<(?:year|owner|copyright holders)>", filled):
        sys.exit(f"{crate['name']} {crate['version']}: unhandled license template placeholder")
    return filled


def split_apache_notice(text: str) -> tuple[str, str]:
    """Move the copyright line out of the Apache-2.0 appendix.

    Crates fill in the boilerplate line of the appendix with their own
    copyright, so otherwise identical texts differ in that one line and
    nearly fifty copies of the license would be reproduced. Returns the text
    with the standard line and the crate's own line ("" if it kept the
    standard one), which is listed next to the crate instead.
    """
    marker = text.find(APACHE_APPENDIX)
    if marker == -1:
        return text, ""
    head, tail = text[:marker], text[marker:]
    found = APACHE_TEMPLATE_LINE.search(tail)
    if not found:
        return text, ""
    own = found.group(0).strip()
    standard = f"{found.group(1)}Copyright [yyyy] [name of copyright owner]"
    if own == standard.strip():
        return text, ""
    return head + tail[: found.start()] + standard + tail[found.end():], own


def cargo_licenses() -> dict:
    """(license id, name, text) -> {(crate, version): copyright line of the Apache-2.0 appendix}"""
    subprocess.run(["cargo", "fetch", "--locked"], check=True, cwd=ROOT)
    out = subprocess.run(
        [
            "cargo", "about", "generate",
            "--workspace", "--all-features", "--locked", "--offline",
            "--format", "json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    ).stdout
    groups: dict = {}
    for lic in json.loads(out)["licenses"]:
        for used in lic["used_by"]:
            crate = used["crate"]
            if not crate.get("source"):
                continue
            text, notice = split_apache_notice(fill_placeholder(lic["text"], crate))
            key = (lic["id"], lic["name"], normalize(text.strip()))
            groups.setdefault(key, {})[(crate["name"], crate["version"])] = notice
    return groups


# --------------------------------------------------------------------------
# npm
# --------------------------------------------------------------------------


def is_tooling(name: str) -> bool:
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in TOOLING)


def resolve(packages: dict, parent: str, name: str) -> str | None:
    """Node resolution over the lock file's `packages` keys."""
    location = parent
    while True:
        key = f"{location}/node_modules/{name}" if location else f"node_modules/{name}"
        if key in packages:
            return key
        if not location:
            return None
        tail = location.rfind("/node_modules/")
        location = location[:tail] if tail != -1 else ""


def npm_selection(surface: str, dev: bool, package: dict, lock: dict) -> dict:
    """lock key -> lock entry, for the packages bundled from this surface."""
    packages = lock["packages"]
    roots = list(package.get("dependencies") or {})
    if dev:
        roots += [n for n in package.get("devDependencies") or {} if not is_tooling(n)]

    selected: dict = {}
    todo = []
    for name in roots:
        key = resolve(packages, "", name)
        if key is None:
            sys.exit(f"{surface}: {name} is in package.json but not in package-lock.json")
        todo.append(key)
    while todo:
        key = todo.pop()
        if key in selected:
            continue
        entry = packages[key]
        if entry.get("link"):
            todo.append(entry["resolved"])
            continue
        selected[key] = entry
        for field in ("dependencies", "optionalDependencies", "peerDependencies"):
            for name in entry.get(field) or {}:
                found = resolve(packages, key, name)
                if found is None:
                    continue
                if field == "optionalDependencies" and (
                    packages[found].get("os") or packages[found].get("cpu")
                ):
                    continue
                todo.append(found)
    return {
        key: entry
        for key, entry in selected.items()
        if key and not key.startswith("../") and not package_name(key).startswith(OWN_NPM_SCOPE)
    }


def package_name(key: str) -> str:
    return key.rsplit("node_modules/", 1)[-1]


def npm_surfaces() -> list[tuple[str, dict]]:
    out = []
    for surface, dev in NPM_SURFACES:
        base = ROOT / surface
        package = json.loads((base / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((base / "package-lock.json").read_text(encoding="utf-8"))
        out.append((surface, npm_selection(surface, dev, package, lock)))
    return out


def npm_author(meta: dict) -> str:
    author = meta.get("author")
    if isinstance(author, dict):
        author = author.get("name")
    return re.sub(r"\s*[<(][^>)]*[>)]", "", author or "").strip()


def npm_license_files(directory: Path) -> list[Path]:
    return [
        f
        for f in sorted(directory.iterdir())
        if f.is_file()
        and f.suffix.lower() != ".spdx"
        and f.name.upper().startswith(("LICENSE", "LICENCE", "COPYING"))
    ]


def npm_licenses(surfaces: list[tuple[str, dict]]) -> dict:
    groups: dict = {}
    missing: list = []
    for surface, selection in surfaces:
        for key, entry in selection.items():
            directory = ROOT / surface / key
            if not directory.is_dir():
                sys.exit(f"{directory} is missing; run `npm ci --ignore-scripts` in {surface}")
            meta = json.loads((directory / "package.json").read_text(encoding="utf-8"))
            files = npm_license_files(directory)
            if not files and meta["name"] in NPM_LICENSE_FROM:
                files = npm_license_files(ROOT / surface / "node_modules" / NPM_LICENSE_FROM[meta["name"]])
            license_id = entry.get("license") or meta.get("license") or "UNKNOWN"
            if not isinstance(license_id, str):
                license_id = "UNKNOWN"
            texts = [(license_id if len(files) == 1 else f.name, normalize(f.read_text(encoding="utf-8"))) for f in files]
            if not texts and license_id == "MIT" and npm_author(meta):
                # No license file in the package: the standard text, with the
                # holder the manifest names, as for the crates without one.
                texts = [(license_id, normalize(MIT_TEXT.format(holders=npm_author(meta))))]
            if not texts:
                missing.append(f"{surface}: {meta['name']} {meta['version']}")
            for name, text in texts:
                groups.setdefault((license_id, name, text), {})[(meta["name"], meta["version"])] = ""
    if missing:
        sys.exit(
            "npm packages without a license file (add them to NPM_LICENSE_FROM):\n  "
            + "\n  ".join(missing)
        )
    return groups


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------


def inputs_digest(lock_text: str, surfaces: list[tuple[str, dict]]) -> str:
    h = hashlib.sha256()

    def add(label: str, data: bytes) -> None:
        h.update(label.encode() + b"\0" + data + b"\0")

    add("cargo", json.dumps(cargo_lock_packages(lock_text)).encode())
    for surface, selection in surfaces:
        rows = sorted((package_name(k), e["version"], e.get("integrity", "")) for k, e in selection.items())
        add("npm:" + surface, json.dumps(rows).encode())
    for rel in ("about.toml", "deny.toml", "scripts/third-party-licenses.py", *(b[3] for b in BUNDLED)):
        add(rel, (ROOT / rel).read_bytes())
    return h.hexdigest()


def fence(text: str) -> str:
    return "````" if "```" in text else "```"


def sorted_groups(groups: dict) -> list:
    return sorted(groups.items(), key=lambda kv: (kv[0][0], sha256(kv[0][2].encode())))


def summary(groups: dict) -> list:
    counts: dict = {}
    for (license_id, _, _), users in groups.items():
        counts.setdefault(license_id, set()).update(users)
    return sorted((license_id, len(users)) for license_id, users in counts.items())


def source_lines(license_id: str, users: dict, base: str) -> list:
    """MPL-2.0 asks for the location of the source of the covered files."""
    if "MPL" not in license_id:
        return []
    return [f"{base}/{n}/{v}" for (n, v) in sorted(users)]


def render(cargo: dict, npm: dict) -> str:
    out: list = [
        "# Third-Party Licenses\n",
        "ChordSketch includes the third-party software listed here. Each is used under its\n"
        "own license; the copyright notices and license texts below are reproduced as\n"
        "those licenses require. ChordSketch's own license is in `LICENSE` (see also\n"
        "`NOTICE`).\n",
        "This file is generated by `scripts/third-party-licenses.py` from the lock files;\n"
        "do not edit it by hand. It covers every Rust crate of the workspace on every\n"
        "target, so a given binary contains a subset of what is listed.\n",
        "## Summary\n",
    ]
    for title, groups in (("Rust crates", cargo), ("npm packages", npm)):
        out.append(f"### {title}\n")
        out.extend(f"- {license_id}: {n}" for license_id, n in summary(groups))
        out.append("")

    for title, groups, base in (
        ("Rust crates", cargo, "https://crates.io/crates"),
        (
            "npm packages bundled into the desktop app, the playground and the VS Code extension",
            npm,
            "https://www.npmjs.com/package",
        ),
    ):
        out.append(f"## {title}\n")
        for (license_id, name, text), users in sorted_groups(groups):
            out.append(f"### {name} ({license_id})\n" if name != license_id else f"### {license_id}\n")
            out.append("Used by: " + ", ".join(f"{n} {v}" for (n, v) in sorted(users)) + "\n")
            notices = [f"- {n} {v}: {c}" for (n, v), c in sorted(users.items()) if c]
            if notices:
                out.append("Copyright lines these packages put in the appendix of the text below:\n" + "\n".join(notices) + "\n")
            src = source_lines(license_id, users, base)
            if src:
                out.append(
                    "Source code of these packages (MPL-2.0 requires saying where to get it):\n"
                    + "\n".join(f"- {s}" for s in src)
                    + "\n"
                )
            f = fence(text)
            out.append(f"{f}\n{text}\n{f}\n")

    out.append("## Fonts and glyphs copied into the source\n")
    for title, url, note, rel in BUNDLED:
        text = normalize((ROOT / rel).read_text(encoding="utf-8"))
        f = fence(text)
        out.append(f"### {title} ({url})\n")
        out.append(note + "\n")
        out.append(f"{f}\n{text}\n{f}\n")
    return "\n".join(out).rstrip("\n") + "\n"


def with_header(body: str, inputs: str) -> str:
    return (
        f"<!-- Generated by scripts/third-party-licenses.py. Do not edit. "
        f"{HEADER_INPUTS}: {inputs} {HEADER_BODY}: {sha256(body.encode())} -->\n" + body
    )


def parse_header(content: str) -> tuple[str | None, str | None, str]:
    first, _, body = content.partition("\n")
    words = first.removeprefix("<!-- ").removesuffix(" -->").split()
    try:
        return (
            words[words.index(HEADER_INPUTS + ":") + 1],
            words[words.index(HEADER_BODY + ":") + 1],
            body,
        )
    except (ValueError, IndexError):
        return None, None, body


def check() -> int:
    mismatch = policy_mismatch()
    if mismatch:
        print(mismatch, file=sys.stderr)
        return 1
    lock_text = (ROOT / "Cargo.lock").read_text(encoding="utf-8")
    want = inputs_digest(lock_text, npm_surfaces())
    have_inputs, have_body, body = parse_header(OUTPUT.read_text(encoding="utf-8"))
    if have_inputs != want:
        problem = (
            f"{OUTPUT.name} was built from a different set of packages (Cargo.lock, "
            "a package-lock.json, about.toml, deny.toml, a bundled license file or this script changed)"
        )
    elif have_body != sha256(body.encode()):
        problem = f"{OUTPUT.name} was edited by hand"
    else:
        print(f"{OUTPUT.name} is up to date")
        return 0
    print(problem, file=sys.stderr)
    print("Regenerate with: python3 scripts/third-party-licenses.py", file=sys.stderr)
    return 1


def generate() -> int:
    mismatch = policy_mismatch()
    if mismatch:
        sys.exit(mismatch)
    surfaces = npm_surfaces()
    npm = npm_licenses(surfaces)
    cargo = cargo_licenses()
    lock_text = (ROOT / "Cargo.lock").read_text(encoding="utf-8")
    content = with_header(render(cargo, npm), inputs_digest(lock_text, surfaces))
    OUTPUT.write_bytes(content.encode("utf-8"))
    print(f"wrote {OUTPUT.name} ({OUTPUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        sys.exit(check())
    if sys.argv[1:]:
        sys.exit(__doc__)
    sys.exit(generate())
