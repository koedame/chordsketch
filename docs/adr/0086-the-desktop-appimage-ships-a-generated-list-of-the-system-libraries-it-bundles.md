# 0086. The desktop AppImage ships a generated list of the system libraries it bundles

- **Status**: Accepted
- **Date**: 2026-10-01

## Context

The Linux desktop AppImage is not built from the project's own code alone.
linuxdeploy copies about 170 shared libraries and helper programs out of the
build runner into the image: webkit2gtk and its helper processes, GTK, GLib,
Pango, Cairo, GnuTLS, ICU and what they need. Opening the v0.7.0 image gave 168
files from 111 Ubuntu packages (the glibc and compiler runtime are excluded by
linuxdeploy). Almost all of them are LGPL, with BSD, MIT, MPL, Apache-2.0 and a
few dual-licensed GPL/LGPL libraries among them. The LGPL asks that every copy
carry the license text and say where the source is, and that the recipient can
replace the library. The image carried copyright files for about 20 of the
packages and nothing else.

Which libraries end up inside depends on the runner image, so a hand-written
list would go stale with the next runner update.

## Decision

1. `scripts/appimage-bundled-libraries.py` makes the list from the AppImage
   itself: every ELF file under `usr/lib`, mapped to its Debian package with
   `dpkg-query -S`. Per package it prints the version, the Ubuntu source package
   (a link to exactly that source), the package's copyright file and the license
   texts that file refers to. It exits 1 when a file matches no package.
2. The Linux build in `desktop-build-steps` builds an AppImage once, makes the
   list from it, and passes the file to the real build through
   `bundle.linux.appimage.files`, so it sits at
   `usr/share/doc/chordsketch-desktop/bundled-libraries.txt` inside the image.
   A final step lists the finished image again and requires the same text.
3. `desktop-release.yml` publishes the same file as
   `chordsketch-desktop-linux-bundled-libraries.txt`, next to the AppImage and
   inside `SHA256SUMS`.

## Rationale

- **Two passes rather than repacking the image.** The bundler has no hook
  between collecting the libraries and squashing the image. Unpacking the
  finished AppImage, adding the file and squashing it again would change the
  bytes after the updater signature was made, so the signature would have to be
  redone as well, and the repacking tool is a downloaded binary of its own.
  The first pass compiles everything, so the second one only repeats the
  bundling.
- **Checked against the final image.** The two passes use the same runner, but
  the check makes "the list is the list of this image" something CI proves
  rather than assumes.
- **Made on the build host.** `dpkg-query` knows the package, version and
  copyright file of the libraries that were actually copied; nothing is looked
  up from a different distribution release.

## Consequences

- The Linux cell of both desktop workflows builds the AppImage twice. The cost
  is the bundling step only.
- A library that `dpkg-query` cannot place (for example one copied from
  `/opt`) fails the build until the script learns where it comes from.
- Copyright files in Debian are written per source package, so a package that
  also contains GPL-licensed tests or tools lists GPL in its copyright file
  although the library is under a more permissive license. The list reproduces
  the files as they are and does not decide which license applies to which
  file.
- The only bundled library under a GPL without an LGPL or permissive option
  found in v0.7.0 is `libjbig0` (jbigkit, GPL-2.0-or-later, reached through
  libtiff). GPL-2.0-or-later can be used under GPL-3.0, which GNU AGPL-3.0
  section 13 allows to be combined with the AGPL-3.0-only desktop app.
  Replacing a bundled library stays possible because the image is an ordinary
  squashfs that `--appimage-extract` unpacks.
