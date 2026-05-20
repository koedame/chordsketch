# Reference nixpkgs derivation for chordsketch.
#
# This file is a template for submitting a PR to NixOS/nixpkgs.
# Place it at pkgs/by-name/ch/chordsketch/package.nix in a nixpkgs
# checkout and submit a PR.
#
# Last verified build: v0.2.0 on x86_64-linux with nixpkgs unstable.
# The `hash` / `cargoHash` fields below are intentionally blank on
# every release cut — the PR bumps `version` only and leaves the
# derivation in its "awaiting-build" state. Hashes are recomputed
# at nixpkgs-submission time per the workflow below.
#
# When bumping to a new release, update `version` and recompute `hash`
# and `cargoHash` by setting both to "" and building once — nix will
# report the correct SRI hashes in the error messages. After a
# successful build, update the "Last verified build" line above.

{
  lib,
  rustPlatform,
  fetchFromGitHub,
}:

rustPlatform.buildRustPackage rec {
  pname = "chordsketch";
  version = "0.5.0";

  src = fetchFromGitHub {
    owner = "koedame";
    repo = "chordsketch";
    tag = "v${version}";
    # Hashes must be recomputed for every release (both `hash` and
    # `cargoHash` below). Set to "" and run `nix build` once — nix
    # will report the correct SRI values in the build error message,
    # then paste them back here. See the leading comment for details.
    hash = "";
  };

  cargoHash = "";

  cargoBuildFlags = [ "--package" "chordsketch" ];
  cargoTestFlags = [ "--package" "chordsketch" ];

  meta = {
    description = "ChordPro file format renderer and CLI (text, HTML, PDF)";
    homepage = "https://github.com/koedame/chordsketch";
    changelog = "https://github.com/koedame/chordsketch/blob/main/CHANGELOG.md";
    license = lib.licenses.mit;
    maintainers = [ ]; # TODO: add your nixpkgs maintainer handle
    mainProgram = "chordsketch";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
