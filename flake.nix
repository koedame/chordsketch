{
  description = "ChordSketch — a Rust implementation of the ChordPro file format";

  # Only nixpkgs is needed as an input.  The Rust toolchain bundled with
  # nixpkgs unstable supports Rust 1.85+ and the 2024 edition used by this
  # workspace, so no rust-overlay or similar overlay is required.
  #
  # The input is pinned to a specific nixpkgs commit and the resolved
  # metadata is recorded in flake.lock for fully reproducible builds.
  # When bumping nixpkgs, update this SHA and run `nix flake update`.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/64c08a7ca051951c8eae34e3e3cb1e202fe36786"; # nixos-unstable 2026-05-23

  outputs = { self, nixpkgs }:
    let
      # Platforms for which packages and dev shells are produced.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forEachSystem = f:
        nixpkgs.lib.genAttrs systems
          (system: f (import nixpkgs {
            inherit system;
            overlays = [ identifiedFetchurlOverlay ];
          }));

      # Read version from the CLI crate so it stays in sync automatically.
      cliCargoToml = builtins.fromTOML (builtins.readFile ./crates/cli/Cargo.toml);
      cliVersion = cliCargoToml.package.version;

      # crates.io's data-access policy
      # (https://crates.io/data-access) rejects requests whose
      # `User-Agent` does not uniquely identify the requester and
      # provide a means of contact, returning HTTP 403 with a
      # "violation of our API data access policy" message. By the
      # 2026-05-23 nixpkgs pin, the default `curl/<version>` UA
      # that `fetchurl`'s builder emits is rejected, so every
      # `nix build` fails at the first crate download
      # (`adobe-cmap-parser`) until we send an identifying UA.
      #
      # `fetchurl` in modern nixpkgs is a functor-attrset built
      # via `lib.extendMkDerivation` — callable via `__functor`
      # but ALSO inspected as a set elsewhere in nixpkgs (`override`,
      # `extendDrvArgs`, `resolveUrl`, ...). A plain `args:
      # prev.fetchurl args` replacement strips those attributes
      # and breaks downstream consumers that do attribute access
      # on `pkgs.fetchurl`; the overlay below uses the same
      # constructor to preserve the original shape.
      #
      # The UA carpet-bombs every `fetchurl` invocation, not only
      # crates.io URLs. That's intentional: sending an
      # identifying UA everywhere is more polite than the default
      # `curl/<v>` and matches the posture of other build tools
      # (Homebrew, Nix itself). Forks that build under their own
      # name will send the chordsketch UA — acceptable for an OSS
      # build artefact, no per-user identity leaks.
      #
      # The UA embeds `cliVersion` so it moves with the project.
      # Side-effect: every CLI version bump changes the embedded
      # `curlOptsList`, which changes every crate-fetch
      # derivation's hash, which invalidates the nix binary
      # cache for crate fetches on the version-bump build. This
      # is acceptable at this project's release cadence; if it
      # becomes painful, decouple the UA's identifier from the
      # CLI version (e.g. read it from a separate `flake.nix`
      # constant).
      cratesIoUserAgent =
        "chordsketch/${cliVersion} "
        + "(+https://github.com/koedame/chordsketch)";

      # Assert the shape we depend on at evaluation time so a
      # future nixpkgs refactor that renames `extendDrvArgs` etc.
      # fails loudly instead of silently no-opping the overlay
      # (silent failure → `nix build` would 403 again with no
      # obvious cause). The asserts only evaluate when the
      # overlay is applied, which happens for every output the
      # flake produces.
      assertFetchurlShape = fu:
        assert (fu ? extendDrvArgs)
          || throw "identifiedFetchurlOverlay: prev.fetchurl is missing `extendDrvArgs` — nixpkgs API may have changed";
        assert (fu ? constructDrv)
          || throw "identifiedFetchurlOverlay: prev.fetchurl is missing `constructDrv` — nixpkgs API may have changed";
        assert (fu ? excludeDrvArgNames)
          || throw "identifiedFetchurlOverlay: prev.fetchurl is missing `excludeDrvArgNames` — nixpkgs API may have changed";
        assert (fu ? resolveUrl)
          || throw "identifiedFetchurlOverlay: prev.fetchurl is missing `resolveUrl` — nixpkgs API may have changed";
        fu;

      identifiedFetchurlOverlay = final: prev:
        let
          fu = assertFetchurlShape prev.fetchurl;
        in
        {
          # Rebuild `fetchurl` via `lib.extendMkDerivation` (the
          # constructor nixpkgs itself uses) so the resulting
          # functor-attrset has the same shape as the original;
          # only `extendDrvArgs` is wrapped, to append our UA to
          # `curlOptsList`. The builder's built-in
          # `--user-agent "curl/<v> Nixpkgs/<v>"` flag is emitted
          # BEFORE the user-supplied `curlOptsList`, so curl's
          # last-flag-wins rule (see `man curl`) means our
          # appended flag overrides the built-in one without
          # needing to strip it.
          fetchurl = final.lib.extendMkDerivation {
            inherit (fu) constructDrv excludeDrvArgNames;
            inheritFunctionArgs = false;
            extendDrvArgs = finalAttrs: drvArgs:
              let
                orig = fu.extendDrvArgs finalAttrs drvArgs;
                # Safe default: absent `curlOptsList` in `orig`
                # means no pre-existing flags from the original
                # extendDrvArgs result. If a caller already
                # passed `--user-agent` in their own
                # curlOptsList, our append still wins (curl uses
                # the last `--user-agent` flag).
                baseOpts = orig.curlOptsList or [ ];
              in orig // {
                curlOptsList =
                  baseOpts ++ [ "--user-agent" cratesIoUserAgent ];
              };
          } // {
            # `resolveUrl` is a non-standard attribute added by
            # the downstream nixpkgs fetchurl wrapper (used by
            # `mirror://` resolution); `extendMkDerivation` does
            # not reconstruct it, so stitch it back in.
            inherit (fu) resolveUrl;
          };
        };
    in {
      packages = forEachSystem (pkgs: rec {
        # Build the `chordsketch` CLI from the Cargo workspace.
        #
        # `cargoLock.lockFile` is used for reproducible dependency vendoring
        # without requiring a pre-computed cargoHash.  All crates in this
        # workspace are pure Rust with no native C library dependencies, so no
        # additional `buildInputs` are needed.
        chordsketch = pkgs.rustPlatform.buildRustPackage {
          pname = "chordsketch";
          version = cliCargoToml.package.version;

          src = ./.;

          cargoLock.lockFile = ./Cargo.lock;

          # Build only the CLI crate from the workspace; this avoids pulling in
          # the WASM, FFI, and NAPI crates whose build requirements differ.
          cargoBuildFlags = [ "--package" "chordsketch" ];
          cargoTestFlags = [ "--package" "chordsketch" ];

          meta = with pkgs.lib; {
            description = "ChordPro file format renderer and CLI (text, HTML, PDF)";
            homepage = "https://github.com/koedame/chordsketch";
            license = licenses.mit;
            maintainers = [ ];
            mainProgram = "chordsketch";
            platforms = systems;
          };
        };

        default = chordsketch;
      });

      # Development shell: `rustup` manages the active Rust toolchain (the
      # workspace requires Rust ≥ 1.85; run `rustup show` inside the shell),
      # and `wasm-pack` is required to build the `@chordsketch/wasm` package.
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustup
            wasm-pack
          ];
        };
      });

      # `nix flake check`-discoverable assertions. Currently scoped to
      # pinning the User-Agent overlay so a refactor that silently
      # drops the `--user-agent` flag fails the check explicitly
      # rather than relying on crates.io reproducing the 403 to
      # surface the regression.
      checks = forEachSystem (pkgs:
        let
          # Instantiate a representative fetchurl derivation; the
          # `curlOptsList` attribute is computed eagerly by
          # `extendDrvArgs` at evaluation time, so we can inspect
          # it without performing a fetch.
          probe = pkgs.fetchurl {
            url = "https://example.invalid/probe.tar.gz";
            # Any valid-shape sha256 works; we never fetch.
            sha256 = pkgs.lib.fakeSha256;
          };
          opts = probe.curlOptsList or [ ];
          hasUserAgent = pkgs.lib.elem "--user-agent" opts;
          hasIdentifier =
            pkgs.lib.any
              (s: pkgs.lib.isString s
                && pkgs.lib.hasInfix "chordsketch/" s)
              opts;
        in
        {
          fetchurl-ua-injected =
            assert hasUserAgent
              || throw "identifiedFetchurlOverlay: --user-agent flag missing from curlOptsList";
            assert hasIdentifier
              || throw "identifiedFetchurlOverlay: chordsketch/<v> identifier missing from curlOptsList";
            pkgs.runCommand "fetchurl-ua-injected" { } "echo ok > $out";
        });
    };
}
