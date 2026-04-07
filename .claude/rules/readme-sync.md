# README Sync Rule

`README.md` is the project's contract with end users. Every install method
and usage example listed in `## Installation` and `## Usage` MUST be
exercised by `.github/workflows/readme-smoke.yml` against the binary it
actually produces — not just `--version`, but a real render assertion via
the `cli-render-smoke` composite action.

## How it is enforced

1. `scripts/extract-readme-commands.py` deterministically extracts every
   bash command line under `## Installation` and `## Usage` from
   `README.md`, prefixed with the section name.
2. The current extraction is committed at
   `.github/snapshots/readme-commands.txt`.
3. `.github/workflows/readme-sync.yml` runs the extractor with `--check`
   on every PR that touches `README.md`, the snapshot, the extractor
   script, or the workflow itself, and fails if the snapshot drifts.

## How to update the snapshot

When you intentionally change a documented install or usage command:

```bash
python3 scripts/extract-readme-commands.py > .github/snapshots/readme-commands.txt
```

Before committing the refreshed snapshot, you MUST also:

- Add or update a job in `.github/workflows/readme-smoke.yml` that
  exercises the new command end-to-end. If the command applies to an
  install path that already has a job, add coverage to the
  `cli-render-smoke` composite action so every install path picks it up.
- Verify the new coverage actually fails when the command is broken.
  Snapshot updates without corresponding CI coverage defeat the purpose
  of this rule.

## Why

A real failure motivated this rule: `docker run --rm
ghcr.io/koedame/chordsketch --version` was advertised in `README.md` but
returned `unauthorized` because the GHCR package was created private by
default. The Docker workflow itself ran successfully, so existing CI was
completely blind to the user-visible breakage. The README sync check
prevents that class of bug from being reintroduced silently.
