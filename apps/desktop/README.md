# ChordSketch Desktop (scaffold)

Tauri v2 scaffold for the ChordSketch desktop editor. The window is
a placeholder; UI content lands in follow-up issues (see `#2068`
tracking).

## Prerequisites

- **Rust** (stable, 1.85+)
- **Tauri CLI**: `cargo install tauri-cli --version "^2.0" --locked`
- **OS dev libs**
  - **Linux (Debian/Ubuntu)**
    ```sh
    sudo apt install -y \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      build-essential \
      pkg-config \
      file
    ```
  - **macOS** — Xcode Command Line Tools (`xcode-select --install`)
  - **Windows** — [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (pre-installed on Windows 11)

## Dev loop

```sh
cargo tauri dev --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Or from `apps/desktop/src-tauri/`:

```sh
cargo tauri dev
```

This opens a native window that loads `apps/desktop/dist/index.html`.
Edits to the HTML file are picked up on window reload.

## Production build

```sh
cargo tauri build --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Produces the host-OS bundle under
`apps/desktop/src-tauri/target/release/bundle/`. The cross-platform
release matrix (signing, notarization, upload to GitHub Releases) is
tracked under `#2075`, `#2077`, and `#2078`.

## Workspace integration

`apps/desktop/src-tauri` is a workspace member but is **excluded from
default workspace operations** via `default-members` in the root
`Cargo.toml`. Running `cargo build` from the repo root does not touch
it, so contributors without the Tauri system libs are unaffected.
`cargo check -p chordsketch-desktop` (or commands run from the crate
directory) opt in.
