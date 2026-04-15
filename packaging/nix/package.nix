# Reference nixpkgs derivation for chordsketch.
#
# This file is a template for submitting a PR to NixOS/nixpkgs.
# Place it at pkgs/by-name/ch/chordsketch/package.nix in a nixpkgs
# checkout and submit a PR.
#
# Before submitting, update:
#   - `version` to match the latest release tag
#   - `hash` and `cargoHash` — leave both as "" initially, run
#     `nix-build`, and copy the SRI hashes from the error messages.
#   - `maintainers` — add your nixpkgs maintainer handle

{
  lib,
  rustPlatform,
  fetchFromGitHub,
}:

rustPlatform.buildRustPackage rec {
  pname = "chordsketch";
  version = "0.2.0";

  src = fetchFromGitHub {
    owner = "koedame";
    repo = "chordsketch";
    tag = "v${version}";
    hash = ""; # leave empty; build once and copy the SRI hash from the error
  };

  cargoHash = ""; # leave empty; build once and copy the SRI hash from the error

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
