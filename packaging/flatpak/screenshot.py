#!/usr/bin/env python3
"""Re-take the Flathub listing's screenshot from the built Flatpak.

    packaging/flatpak/screenshot.py

Builds the Flatpak the way `scripts/check-publishable.py flathub` does
(offline, in the image Flathub's GitHub actions use), starts it on a private
X server and writes what the window shows to `screenshots/editor.png`. Needs
docker, and the checkout to have no `node_modules` — `prepare.py` refuses
otherwise, since the npm source list has to come from the lockfiles alone.

Nothing about the listing is decided here: the window is the app's own
default size, and the shot is taken once the app has finished starting up,
so the file is only ever a picture of what a user sees on first launch.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
APP_ID = "io.github.koedame.chordsketch"
IMAGE = "ghcr.io/flathub-infra/flatpak-github-actions:gnome-50"
# `apps/desktop/src-tauri/tauri.conf.json`'s window, and a screen with room
# around it so the window is never resized to fit.
WINDOW = (1200, 800)
SCREEN = (1280, 1024)
# The title the app sets once its startup has finished; waiting for it is
# what keeps the shot from catching a half-painted window.
STARTED_TITLE = "Untitled — ChordSketch"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=HERE / "screenshots/editor.png", help="where to write the PNG")
    args = parser.parse_args()

    work = Path(tempfile.mkdtemp(prefix="chordsketch-screenshot-"))
    try:
        prepared = subprocess.run([sys.executable, str(HERE / "prepare.py"), "--out", str(work / "flatpak")], cwd=REPO, check=False)
        if prepared.returncode != 0:
            return prepared.returncode

        width, height = WINDOW
        script = (
            "set -euo pipefail; mkdir -p /var/tmp/flatpak && cd /var/tmp/flatpak; "
            f"flatpak-builder --install-deps-from=flathub --disable-rofiles-fuse --repo=repo build /work/flatpak/{APP_ID}.yml > /work/build.txt 2>&1; "
            f"flatpak remote-add --no-gpg-verify built /var/tmp/flatpak/repo && flatpak install -y --noninteractive built {APP_ID} > /work/install.txt 2>&1; "
            # Xvfb directly: `xvfb-run` waits for a SIGUSR1 that can get lost when it runs under the container's init.
            f"Xvfb :99 -screen 0 {SCREEN[0]}x{SCREEN[1]}x24 -nolisten tcp > /work/xvfb.txt 2>&1 & "
            "for i in $(seq 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done; "
            "DISPLAY=:99 dbus-run-session -- sh -c '"
            f"flatpak run {APP_ID} > /work/app.txt 2>&1 & app=$!; "
            f'for i in $(seq 90); do sleep 1; python3 {HERE}/window-titles.py > /work/titles.txt; '
            f'grep -qx "{STARTED_TITLE}" /work/titles.txt && break; done; '
            # A beat after the title so the first paint of both panes has landed.
            "sleep 3; "
            # No screenshot tool in this image, but ffmpeg reads X11. There is no window
            # manager, so the app's window is the one at the origin. `-draw_mouse 0`
            # keeps the pointer, parked wherever X left it, out of the listing.
            f"ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -video_size {width}x{height} -i :99.0+0,0 -frames:v 1 /work/editor.png; "
            "kill $app 2>/dev/null; true'"
        )
        container = subprocess.run(
            ["docker", "run", "--rm", "--privileged", "-v", f"{REPO}:{REPO}:ro", "-v", f"{work}:/work", IMAGE, "bash", "-c", script],
            check=False,
        )
        titles = (work / "titles.txt").read_text().splitlines() if (work / "titles.txt").exists() else []
        if STARTED_TITLE not in titles:
            print(f"the app did not finish starting up; its windows: {titles}", file=sys.stderr)
            for name in ("build", "install", "app"):
                if (work / f"{name}.txt").exists():
                    print(f"--- {name}.txt ---\n{(work / f'{name}.txt').read_text()[-4000:]}", file=sys.stderr)
            return container.returncode or 1
        shot = work / "editor.png"
        if not shot.exists():
            print("ffmpeg wrote no screenshot", file=sys.stderr)
            return container.returncode or 1
        args.out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(shot, args.out)
        print(f"Wrote {args.out} ({shot.stat().st_size} bytes)")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
