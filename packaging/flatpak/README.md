<!-- markdownlint-disable MD041 -->
# Flatpak (Flathub)

The desktop app as a Flatpak, for Flathub
([ADR-0074](../../docs/adr/0074-the-desktop-app-is-built-for-flathub-from-source.md)).
The CLI is not published there
([ADR-0072](../../docs/adr/0072-the-cli-is-not-published-to-flathub.md)).

| File | Purpose |
|---|---|
| `io.github.koedame.chordsketch.yml` | The manifest. It names generated files, so it is built from a copy `prepare.py` writes. |
| `prepare.py` | Writes the manifest and the source lists it needs (Rust toolchain, wasm-bindgen CLI, crates, npm packages, this repository) into a directory. |
| `io.github.koedame.chordsketch.metainfo.xml` | AppStream metadata: the Flathub listing. |
| `io.github.koedame.chordsketch.desktop` | The launcher entry. |
| `screenshots/` | The listing's screenshots. The metainfo links them from a commit on `main`, as Flathub asks. |
| `screenshot.py` | Re-takes `screenshots/editor.png` from the built Flatpak, so the listing shows what the app actually looks like. |
| `requirements.txt` | The Python packages `prepare.py`'s generators need. |
| `window-titles.py` | Lists the X windows' titles; the launch check waits for the one the app sets when its startup has finished. |

The application ID is `io.github.koedame.chordsketch`, the GitHub code-hosting
ID for this repository, not the Tauri identifier
`me.koeda.chordsketch.desktop`: Flathub refuses IDs that end in `.desktop`
([ADR-0074](../../docs/adr/0074-the-desktop-app-is-built-for-flathub-from-source.md)).

## Build and run locally

Needs `flatpak`, `flatpak-builder`, Python 3.11+ and the Flathub remote.

```bash
python3 -m pip install -r packaging/flatpak/requirements.txt
flatpak install -y flathub org.gnome.Sdk//50 org.gnome.Platform//50 \
  org.freedesktop.Sdk.Extension.node24//25.08 org.freedesktop.Sdk.Extension.llvm22//25.08 \
  org.flatpak.Builder
packaging/flatpak/prepare.py --out build/flatpak
flatpak-builder --user --install --force-clean build/flatpak/app build/flatpak/io.github.koedame.chordsketch.yml
flatpak run io.github.koedame.chordsketch
```

`prepare.py` refuses to run while `apps/desktop/node_modules` or
`packages/react/node_modules` exists: the npm source list must come from the
lockfiles alone.

After a change to how the app looks, re-take the listing's screenshot and
point the metainfo at the commit that carries the new file:

```bash
packaging/flatpak/screenshot.py
```

`python3 scripts/check-publishable.py flathub` runs what the `Publishable`
check runs (docker is enough): it generates the files with the release job's
step, lints them, builds offline in the image Flathub's GitHub actions use and
launches the result. To lint by hand:

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest build/flatpak/io.github.koedame.chordsketch.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder appstream packaging/flatpak/io.github.koedame.chordsketch.metainfo.xml
```

## Releasing

Each desktop release adds a `<release>` to the metainfo, newest first.
`scripts/check-version-consistency.py` fails until the newest one is the
desktop version; its `--set`, which the release bump runs, adds it.

Once the app is on Flathub, `desktop-release.yml`'s `update-flathub` job
opens a pull request on `flathub/io.github.koedame.chordsketch` with the files
`prepare.py` writes for the release tag. Flathub builds the pull request; a
maintainer installs the test build it links, checks it starts, and merges.
Until that repository exists the job does nothing.
