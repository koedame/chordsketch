#!/usr/bin/env python3
"""Lift inline `run:` bodies out of an `action.yml` or a workflow.

Shared by the test suites that execute those bodies under a real shell
(`test_chocolatey_pack_push.py`, `test_chocolatey_generate_package.py`,
`test_release_checksum_guards.py`), so the scanner they all depend on has one
definition to keep in step with the YAML layout.

`extract_step_run` addresses one step by name, which suits a composite action.
`iter_step_runs` walks every step that has one, which suits a workflow, where
step names repeat across jobs.

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


def iter_step_runs(yaml_text: str) -> list[tuple[str, str]]:
    """Return `(step name, dedented run body)` for every step that has one.

    Same line-scanning discipline as `extract_step_run`, minus the
    single-match requirement: a workflow reuses a step name across jobs
    (`post-release.yml` has two `Generate manifest` steps), so a caller that
    needs all of them cannot address them by name. Steps without a `run: |`
    block — `uses:` steps — are skipped rather than raising, since a workflow
    is expected to hold both kinds.
    """
    lines = yaml_text.splitlines()
    found: list[tuple[str, str]] = []
    for start, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("- name: "):
            continue
        name = stripped[len("- name: ") :]
        step_indent = len(line) - len(line.lstrip())

        run_idx = None
        for i in range(start + 1, len(lines)):
            inner = lines[i]
            if not inner.strip():
                continue
            indent = len(inner) - len(inner.lstrip())
            if indent <= step_indent:
                break
            if inner.strip() == "run: |":
                run_idx = i
                break
        if run_idx is None:
            continue

        key_indent = len(lines[run_idx]) - len(lines[run_idx].lstrip())
        body: list[str] = []
        for inner in lines[run_idx + 1 :]:
            if not inner.strip():
                body.append("")
                continue
            if len(inner) - len(inner.lstrip()) <= key_indent:
                break
            body.append(inner)
        text = textwrap.dedent("\n".join(body)).strip("\n")
        if text:
            found.append((name, text))
    return found
