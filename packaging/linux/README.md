<!-- markdownlint-disable MD041 -->
# Linux file-manager integration

Standalone thumbnailer for ChordPro source files. Once installed, GNOME
Files (Nautilus), Nemo, Caja, Thunar, and any other XDG-compliant file
manager will render `.cho` / `.chopro` / `.crd` / `.chordpro` thumbnails
in place of the generic text-document icon. KDE Dolphin uses a separate
KIO-previewer mechanism not covered here.

## What this directory contains

| File | Purpose |
|---|---|
| `chordsketch-mime.xml` | XDG MIME-type definition for `text/x-chordpro` so the four supported extensions resolve to the right type. |
| `chordsketch.thumbnailer` | XDG thumbnailer entry pointing at the script below; bound to `MimeType=text/x-chordpro;`. |
| `chordsketch-thumbnailer` | POSIX `sh` script that takes `(input, output, size)` and writes a PNG. Renders the source via `chordsketch -f pdf`, then rasterises with `pdftoppm`. |

## Dependencies

- `chordsketch` — the CLI (any install path: cargo, snap, AUR, Homebrew Cask, etc.)
- `pdftoppm` — `poppler-utils` package on Debian / Ubuntu / Arch / Fedora

PDF → PNG via `pdftoppm` is preferred over an HTML → PNG path because the
in-process Rust PDF renderer keeps the chord-over-lyrics typography
identical to the editor preview, without pulling in a headless browser
or rendering toolkit.

## System-wide install

```bash
# 1. MIME type
sudo install -Dm644 chordsketch-mime.xml \
  /usr/share/mime/packages/chordsketch-chordpro.xml
sudo update-mime-database /usr/share/mime

# 2. Thumbnailer entry + script
sudo install -Dm644 chordsketch.thumbnailer \
  /usr/share/thumbnailers/chordsketch.thumbnailer
sudo install -Dm755 chordsketch-thumbnailer \
  /usr/local/bin/chordsketch-thumbnailer

# 3. Drop existing thumbnail cache so file managers rebuild
rm -rf "$HOME/.cache/thumbnails"
```

## Per-user install (no sudo)

```bash
install -Dm644 chordsketch-mime.xml \
  "$HOME/.local/share/mime/packages/chordsketch-chordpro.xml"
update-mime-database "$HOME/.local/share/mime"

install -Dm644 chordsketch.thumbnailer \
  "$HOME/.local/share/thumbnailers/chordsketch.thumbnailer"
install -Dm755 chordsketch-thumbnailer \
  "$HOME/.local/bin/chordsketch-thumbnailer"

# Make sure ~/.local/bin is in PATH so the file manager can find the
# script via the `TryExec=chordsketch-thumbnailer` line.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

rm -rf "$HOME/.cache/thumbnails"
```

## Verifying the install

```bash
# Render a sample to make sure the chain works end to end.
chordsketch-thumbnailer /path/to/song.cho /tmp/sample-thumb.png 256
file /tmp/sample-thumb.png   # → PNG image data, ~180 x 256
```

If the file manager still shows the generic text icon after install:

1. Confirm the MIME type resolved: `xdg-mime query filetype song.cho`
   should print `text/x-chordpro` (not `text/plain`).
2. Confirm the thumbnailer is registered: `ls
   ~/.local/share/thumbnailers/ /usr/share/thumbnailers/` should list
   `chordsketch.thumbnailer`.
3. Force the file manager to rebuild thumbnails: log out, drop
   `~/.cache/thumbnails/`, log back in.

## Why these are not bundled in the Tauri desktop app

The macOS Quick Look Extension and the Windows Preview Handler in #861
are bundled inside the Tauri desktop app's signed installer because
both platforms require them to live inside (or alongside) a
code-signed parent bundle to load. Linux has no equivalent constraint
— a `.thumbnailer` file pointing at any binary on the user's `$PATH`
is enough — so shipping these as a small standalone bundle reaches
the larger Linux audience that installs ChordSketch only as a CLI
(via `cargo install`, snap, AUR, or Nix) without pulling in the full
Tauri desktop bundle.

The snap / flatpak / AUR / .deb packages can include these three files
in their post-install hooks. Tracking issues for those package-side
integrations live under #1603 (distribution channel coverage).
