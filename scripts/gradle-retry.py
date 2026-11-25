#!/usr/bin/env python3
"""Run `./gradlew` in a project, again after a wait when a repository could not be fetched from.

    python3 scripts/gradle-retry.py packages/kotlin test

Maven Central and the Gradle plugin portal answer 429 / 5xx now and then for
files that exist. The retry is the one the publish checks use
(`run_gradle` in `scripts/_publish_checks.py`). A build that fails any other
way is not run again. Exits with Gradle's exit code.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _publish_checks as checks  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: gradle-retry.py <project directory> <gradle arguments>...", file=sys.stderr)
        return 2
    directory = Path(argv[0])
    return checks.run_gradle(checks.run, ["./gradlew", *argv[1:]], directory).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
