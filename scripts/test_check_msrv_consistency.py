#!/usr/bin/env python3
"""Tests for `check-msrv-consistency.py`.

Uses only `unittest` from stdlib so CI does not need a `pip install` step.

The synthetic cases cover the shapes the parser has to survive — a
digest-only pin, a floating tag, a missing digest, a qualified image
name, a multi-stage file whose non-Rust stages must be ignored. The
regression case is the one that motivated the checker: `Dockerfile`
naming `rust:1.85-bookworm` while the workspace declared
`rust-version = "1.88"`, which no workflow built and therefore nothing
caught.

The last group runs against the repository's real `Cargo.toml`,
Dockerfiles and `README.md`, so an MSRV bump that forgets either site
turns this suite red on the PR that does it.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent

_spec = importlib.util.spec_from_file_location(
    "check_msrv_consistency", SCRIPTS_DIR / "check-msrv-consistency.py"
)
checker = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(checker)

DOCKERFILE = Path("Dockerfile")

# The builder stage as it stood when the MSRV moved to 1.88 and this pin
# did not, plus the runtime stage that must be ignored.
STALE_PIN = """\
# Multi-stage Dockerfile for building ChordSketch from source.
FROM rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4 AS builder

WORKDIR /build
COPY . .

RUN cargo build --release --locked -p chordsketch

FROM debian:bookworm-20260406-slim@sha256:4724b8cc51e33e398f0e2e15e18d5ec2851ff0c2280647e1310bc1642182655d
ENTRYPOINT ["/usr/local/bin/chordsketch"]
"""

CURRENT_PIN = STALE_PIN.replace(
    "rust:1.85-bookworm@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4",
    "rust:1.98-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922",
)


class ReadMsrvTests(unittest.TestCase):
    def test_reads_the_workspace_package_declaration(self):
        text = '[workspace.package]\nedition = "2024"\nrust-version = "1.88"\n'
        self.assertEqual(checker.read_msrv(text), "1.88")

    def test_exits_when_the_declaration_is_absent(self):
        with self.assertRaises(SystemExit):
            checker.read_msrv('[workspace.package]\nedition = "2024"\n')


class DockerfileTests(unittest.TestCase):
    def test_a_pin_below_the_floor_is_an_error(self):
        errors = checker.check_dockerfile(STALE_PIN, DOCKERFILE, "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("Dockerfile:2", errors[0])
        self.assertIn("below the workspace", errors[0])

    def test_a_pin_at_or_above_the_floor_passes(self):
        self.assertEqual(checker.check_dockerfile(CURRENT_PIN, DOCKERFILE, "1.88"), [])

    def test_a_pin_exactly_at_the_floor_passes(self):
        text = "FROM rust:1.88-bookworm@sha256:" + "a" * 64 + " AS builder\n"
        self.assertEqual(checker.check_dockerfile(text, DOCKERFILE, "1.88"), [])

    def test_a_patch_level_tag_is_compared_component_wise(self):
        # Naive string comparison would rank "1.9" above "1.88".
        text = "FROM rust:1.9.0-bookworm@sha256:" + "a" * 64 + " AS builder\n"
        errors = checker.check_dockerfile(text, DOCKERFILE, "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("below the workspace", errors[0])

    def test_a_missing_digest_is_an_error(self):
        errors = checker.check_dockerfile("FROM rust:1.98-bookworm AS builder\n", DOCKERFILE, "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("no `@sha256:` digest", errors[0])

    def test_a_digest_only_pin_is_an_error(self):
        text = "FROM rust@sha256:" + "a" * 64 + " AS builder\n"
        errors = checker.check_dockerfile(text, DOCKERFILE, "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("by digest alone", errors[0])

    def test_a_floating_tag_is_an_error(self):
        text = "FROM rust:bookworm@sha256:" + "a" * 64 + " AS builder\n"
        errors = checker.check_dockerfile(text, DOCKERFILE, "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("floating tag", errors[0])

    def test_a_platform_flag_and_a_qualified_name_are_still_matched(self):
        text = (
            "FROM --platform=$BUILDPLATFORM docker.io/library/rust:1.85-bookworm@sha256:"
            + "a" * 64
            + " AS builder\n"
        )
        errors = checker.check_dockerfile(text, DOCKERFILE, "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("below the workspace", errors[0])

    def test_a_dockerfile_with_no_rust_stage_has_nothing_to_say(self):
        text = "FROM alpine:3.23.3@sha256:" + "a" * 64 + "\nRUN adduser -D chordsketch\n"
        self.assertEqual(checker.check_dockerfile(text, DOCKERFILE, "1.88"), [])

    def test_an_image_whose_name_merely_starts_with_rust_is_not_matched(self):
        text = "FROM rustlang/rust:nightly@sha256:" + "a" * 64 + "\n"
        self.assertEqual(checker.check_dockerfile(text, DOCKERFILE, "1.88"), [])


class ReadmeTests(unittest.TestCase):
    def test_the_declared_version_passes(self):
        self.assertEqual(checker.check_readme("Requires Rust 1.88 or later.\n", "1.88"), [])

    def test_a_stale_version_is_an_error(self):
        errors = checker.check_readme("Requires Rust 1.85 or later.\n", "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("states Rust 1.85", errors[0])

    def test_a_missing_sentence_is_an_error(self):
        errors = checker.check_readme("### From source\n\ncargo install --path crates/cli\n", "1.88")
        self.assertEqual(len(errors), 1)
        self.assertIn("no \"Requires Rust", errors[0])


class RepositoryTests(unittest.TestCase):
    """Run the checker against the tree it ships in."""

    def setUp(self):
        self.msrv = checker.read_msrv((REPO_ROOT / checker.CARGO_TOML).read_text(encoding="utf-8"))

    def test_both_dockerfiles_are_discovered(self):
        found = checker.find_dockerfiles(REPO_ROOT)
        self.assertIn(Path("Dockerfile"), found)
        self.assertIn(Path("Dockerfile.release"), found)

    def test_every_dockerfile_in_the_tree_satisfies_the_floor(self):
        for dockerfile in checker.find_dockerfiles(REPO_ROOT):
            with self.subTest(dockerfile=str(dockerfile)):
                text = (REPO_ROOT / dockerfile).read_text(encoding="utf-8")
                self.assertEqual(checker.check_dockerfile(text, dockerfile, self.msrv), [])

    def test_the_readme_names_the_declared_msrv(self):
        text = (REPO_ROOT / checker.README).read_text(encoding="utf-8")
        self.assertEqual(checker.check_readme(text, self.msrv), [])

    def test_main_reports_success(self):
        self.assertEqual(checker.main(), 0)


if __name__ == "__main__":
    unittest.main()
