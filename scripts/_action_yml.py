#!/usr/bin/env python3
"""Lift a composite action's inline `run:` body out of its `action.yml`.

Shared by the test suites that execute those bodies under a real shell
(`test_chocolatey_pack_push.py`, `test_chocolatey_generate_package.py`), so
the scanner they both depend on has one definition to keep in step with the
action layout.

Stdlib only, like the rest of `scripts/`.
"""
from __future__ import annotations

import textwrap


def extract_step_run(action_yml: str, step_name: str) -> str:
    """Return the dedented `run:` body of the named step in a composite action.

    Deliberately a narrow line scanner rather than a YAML parse: the check
    scripts in this repo are stdlib-only (see the header of
    `ci/release-channels.toml`), and PyYAML is not otherwise a dependency.
    The narrowness is made safe by failing loudly — an `action.yml` whose
    shape this does not fit raises instead of silently yielding a short or
    empty body that would make a caller's assertions vacuous.
    """
    lines = action_yml.splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip() == f"- name: {step_name}"]
    if len(starts) != 1:
        raise AssertionError(f"expected exactly one step named {step_name!r}, found {len(starts)}")
    start = starts[0]
    step_indent = len(lines[start]) - len(lines[start].lstrip())

    run_idx = None
    for i in range(start + 1, len(lines)):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            continue
        indent = len(line) - len(line.lstrip())
        # A new list item at the same depth means the step ended without a
        # `run:` — i.e. the body moved somewhere this extractor cannot see.
        if indent <= step_indent and stripped.startswith("- "):
            break
        if stripped == "run: |":
            run_idx = i
            break
    if run_idx is None:
        raise AssertionError(f"step {step_name!r} has no `run: |` block")

    key_indent = len(lines[run_idx]) - len(lines[run_idx].lstrip())
    body: list[str] = []
    for line in lines[run_idx + 1 :]:
        if not line.strip():
            body.append("")
            continue
        if len(line) - len(line.lstrip()) <= key_indent:
            break
        body.append(line)
    text = textwrap.dedent("\n".join(body)).strip("\n")
    if not text:
        raise AssertionError(f"step {step_name!r} has an empty `run:` body")
    return text
