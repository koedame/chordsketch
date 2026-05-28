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

      # Evaluate `f pkgs` for each system in `systems`, with the
      # crates.io-compliant User-Agent overlay applied.
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
      # "violation of our API data access policy" message. The
      # default `curl/<version>` UA that nixpkgs `fetchurl` sends
      # was tightened to reject some time around 2026-05, so every
      # `nix build` fails at the first crate download
      # (`adobe-cmap-parser`) until we send an identifying UA.
      #
      # `fetchurl` in modern nixpkgs is an attribute set with a
      # `__functor` (making it callable) and an `extendDrvArgs`
      # helper purpose-built for layering extra derivation
      # arguments. Use the helper directly so all of fetchurl's
      # other attributes (`override`, `overrideDerivation`,
      # `__functionArgs`, etc.) remain intact — a plain `args:
      # prev.fetchurl args` replacement would strip them and break
      # downstream consumers that do attribute access on
      # `pkgs.fetchurl`.
      cratesIoUserAgent =
        "chordsketch/${cliVersion} "
        + "(+https://github.com/koedame/chordsketch)";

      identifiedFetchurlOverlay = final: prev: {
        # Rebuild `fetchurl` via `lib.extendMkDerivation` (the
        # constructor nixpkgs itself uses), wrapping the original
        # `extendDrvArgs` so the resulting derivation args always
        # carry an identifying `--user-agent` in `curlOptsList`.
        # Preserves the original attribute-set shape that
        # `lib/customisation.nix` and downstream `nixpkgs` code
        # introspect on (`__functor`, `__functionArgs`,
        # `constructDrv`, `extendDrvArgs`, `override`, ...).
        fetchurl = final.lib.extendMkDerivation {
          inherit (prev.fetchurl) constructDrv excludeDrvArgNames;
          inheritFunctionArgs = false;
          extendDrvArgs = finalAttrs: drvArgs:
            let orig = prev.fetchurl.extendDrvArgs finalAttrs drvArgs;
            in orig // {
              curlOptsList =
                (orig.curlOptsList or [ ])
                ++ [ "--user-agent" cratesIoUserAgent ];
            };
        } // {
          inherit (prev.fetchurl) resolveUrl;
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
    };
}
