#!/usr/bin/env python3
"""List the system libraries inside the desktop AppImage and write their notices.

  scripts/appimage-bundled-libraries.py <AppImage | extracted directory> <output.txt>

The AppImage carries shared libraries copied from the machine that built it
(GTK, WebKitGTK, GLib and what they need), most of them LGPL.
Which ones depends on the build, so the notice is made from the AppImage
itself, on the build machine, by asking dpkg which package each library came
from. For every package the output has the version, the Debian source package
(where the source is), the package's copyright file and the license texts that
file refers to.

Exits 1 when a library cannot be matched to a package: the notice would be
missing it. The output is still written, with the unmatched files listed.

DPKG_QUERY and SHARE_DIR stand in for `dpkg-query` and `/usr/share` (the tests
use them).
"""

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

DPKG_QUERY = os.environ.get("DPKG_QUERY", "dpkg-query")
SHARE_DIR = Path(os.environ.get("SHARE_DIR", "/usr/share"))
SOURCE_URL = "https://launchpad.net/ubuntu/+source"
COMMON_LICENSE = re.compile(r"/usr/share/common-licenses/([A-Za-z0-9.+-]*[A-Za-z0-9+-])")


def is_elf(path: Path) -> bool:
    with path.open("rb") as f:
        return f.read(4) == b"\x7fELF"


def bundled_libraries(root: Path) -> list:
    """Shared libraries and helper programs the build copied into the AppImage.

    `usr/lib` holds libraries and, under `usr/lib/<triplet>/webkit2gtk-4.1`, the
    WebKit helper processes (no `.so` in their names). `usr/bin/chordsketch-desktop`
    and the AppRun launcher are not from the build system, so they are left out.
    """
    found = set()
    for p in (root / "usr" / "lib").rglob("*"):
        if p.is_file() and not p.is_symlink() and is_elf(p):
            found.add(p.name)
    return sorted(found)


def owners(name: str) -> list:
    """Packages owning a file called `name` under /usr/lib or /lib."""
    r = subprocess.run([DPKG_QUERY, "-S", f"*/{name}"], capture_output=True, text=True)
    pkgs = []
    for line in r.stdout.splitlines():
        owner, _, path = line.rpartition(": ")
        if not (path.startswith("/usr/lib/") or path.startswith("/lib/")):
            continue
        pkgs += [p.split(":")[0] for p in owner.split(", ")]
    return sorted(set(pkgs))


def package_info(pkg: str) -> dict:
    out = subprocess.run(
        [DPKG_QUERY, "-W", "-f", "${Version}\t${source:Package}\t${source:Version}", pkg],
        check=True, capture_output=True, text=True,
    ).stdout
    version, source, source_version = out.split("\t")
    return {"version": version, "source": source or pkg, "source_version": source_version or version}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").strip("\n")


def main(argv: list) -> int:
    if len(argv) != 2:
        sys.exit(__doc__)
    target, out_path = Path(argv[0]), Path(argv[1])

    with tempfile.TemporaryDirectory() as tmp:
        root = target
        if target.is_file():
            subprocess.run(
                [str(target.resolve()), "--appimage-extract"],
                check=True, cwd=tmp, capture_output=True,
                env={**os.environ, "APPIMAGE_EXTRACT_AND_RUN": "1"},
            )
            root = Path(tmp) / "squashfs-root"

        libs = bundled_libraries(root)
        by_package: dict = {}
        unmatched = []
        for lib in libs:
            pkgs = owners(lib)
            if not pkgs:
                unmatched.append(lib)
            for pkg in pkgs:
                by_package.setdefault(pkg, []).append(lib)

    infos = {pkg: package_info(pkg) for pkg in by_package}
    copyrights: dict = {}
    for pkg in by_package:
        path = SHARE_DIR / "doc" / pkg / "copyright"
        copyrights[pkg] = read_text(path) if path.exists() else None
    # `GPL` and `GPL-3` are the same file on the system: print each text once.
    texts: dict = {}
    for name in sorted({m for t in copyrights.values() if t for m in COMMON_LICENSE.findall(t)}):
        path = SHARE_DIR / "common-licenses" / name
        text = read_text(path) if path.exists() else "(not available on the build system)"
        texts.setdefault(text, []).append(name)

    out: list = []
    out.append(
        "ChordSketch desktop for Linux (AppImage): libraries bundled from the build system\n"
        + "=" * 70 + "\n\n"
        "The AppImage contains shared libraries copied from the Ubuntu system it was\n"
        "built on. They are free software under their own licenses, many of them the\n"
        "GNU Lesser General Public License; ChordSketch does not change them. This file\n"
        "lists them, reproduces each package's copyright file and the license texts\n"
        "those files refer to, and says where the source code is.\n\n"
        "Source code: the \"Source\" line of each package below links to the Ubuntu\n"
        "source package of exactly that version. For the three years from the release\n"
        "of the AppImage, the same source is also available on request through\n"
        "https://github.com/koedame/chordsketch/issues.\n\n"
        "Replacing a library: an AppImage can be unpacked with `--appimage-extract`;\n"
        "the libraries are ordinary files in squashfs-root/usr/lib.\n"
    )
    out.append("Packages\n" + "-" * 70)
    for pkg in sorted(by_package):
        i = infos[pkg]
        out.append(
            f"\n{pkg} {i['version']}\n"
            f"  Source: {SOURCE_URL}/{i['source']}/{i['source_version']}\n"
            f"  Files:  {', '.join(sorted(set(by_package[pkg])))}"
        )
    if unmatched:
        out.append(
            "\nNot matched to any package (this notice is incomplete):\n  "
            + "\n  ".join(unmatched)
        )

    out.append("\n\nCopyright files\n" + "=" * 70)
    for pkg in sorted(by_package):
        out.append(f"\n--- {pkg} ---\n")
        out.append(copyrights[pkg] if copyrights[pkg] else "(the package has no copyright file on the build system)")

    out.append("\n\nLicense texts referred to above\n" + "=" * 70)
    for text, names in sorted(texts.items(), key=lambda kv: kv[1]):
        out.append(f"\n--- {', '.join(names)} ---\n")
        out.append(text)

    out_path.write_bytes(("\n".join(out).rstrip("\n") + "\n").encode("utf-8"))
    print(f"{len(libs)} libraries, {len(by_package)} packages -> {out_path}")
    if unmatched:
        print("not matched to a package:", ", ".join(unmatched), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
