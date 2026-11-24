# 0098. CLI exit codes follow `sysexits.h`

- **Status**: Accepted
- **Date**: 2026-11-24

## Context

The `chordsketch` binary exited with `1` for every failure it detected
itself, and `2` for the command-line errors `clap` detects. A script that
runs the CLI could not tell a song with a syntax error from a missing file,
a bad `--config` file or a full disk without matching on the stderr text,
which is not a stable interface.

Pre-1.0, a change to the exit codes does not need a compatibility path
([ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md)).

## Decision

1. Each kind of failure has its own exit code. The kinds are the variants
   of `Failure` in `crates/cli/src/exit.rs`, and `Failure::code` is the only
   place a kind becomes a number.

   | Code | `sysexits.h` | Kind |
   |---|---|---|
   | `1` | | `fmt --check` found a file that needs formatting |
   | `2` | | invalid command line |
   | `65` | `EX_DATAERR` | the input was read but is not valid |
   | `66` | `EX_NOINPUT` | an input file does not exist or cannot be read |
   | `70` | `EX_SOFTWARE` | `mcp`: the server could not start or stopped abnormally |
   | `73` | `EX_CANTCREAT` | an output file could not be written |
   | `74` | `EX_IOERR` | reading stdin or writing stdout failed |
   | `76` | `EX_PROTOCOL` | `mcp`: the handshake did not complete |
   | `78` | `EX_CONFIG` | a `--config` file is missing, unreadable or malformed |

2. Only kinds the code can produce today have a variant. A new kind of
   failure adds a variant, a row in the README table and a test in
   `crates/cli/tests/exit_codes.rs` in the same change.
3. When several failures are reported in one run, the exit code is that of
   the first one reported. The run still processes the remaining inputs, so
   every problem is printed.
4. `fmt --check` exits `1` only when no error occurred: an error takes
   precedence, so `1` always means every file was checked.

## Rationale

- **The values are not invented.** `sysexits.h` is the one published list
  of exit codes for "what kind of failure was it", and its definitions fit
  the kinds the CLI has: `EX_DATAERR` "the input data was incorrect in some
  way", `EX_NOINPUT` "an input file (not a system file) did not exist or
  was not readable", `EX_CANTCREAT` "a (user specified) output file cannot
  be created", `EX_IOERR` "an error occurred while doing I/O on some file",
  `EX_CONFIG` "something was found in an unconfigured or misconfigured
  state" (FreeBSD `sysexits(3)`). The range starts at 64, so it does not
  collide with `1`, `2`, the shell's `126` / `127`, or the `128 + signal`
  range.
- **Usage errors stay `2`, not `EX_USAGE` (64).** `clap` exits with `2` for
  the errors it detects and that cannot be changed per error kind without
  replacing its error handling. One code for every usage error is worth
  more than matching the header, so the usage errors the CLI detects itself
  (a malformed `--define`, several inputs to `convert --to musicxml`) use
  `2` as well.
- **`fmt --check` stays `1`.** An unformatted file is the answer to the
  question the command asks, not a failure to answer it. `diff`, `grep` and
  `rustfmt --check` use `1` the same way.
- **A missing `--config` file is `78`, not `66`.** A name that is not a
  preset is used as a path, so a mistyped preset name surfaces as a missing
  file. Both are a configuration mistake to the person running the command,
  and `66` then always means a song could not be read.
- **An oversized or non-UTF-8 input is `65`, not `66`.** The file was found
  and read; what is wrong is its content.
- **First failure wins** because it needs no ranking of kinds, and it is
  the failure whose message is at the top of stderr.

## Consequences

- Scripts that test for `== 1` break; scripts that test for `!= 0` do not.
  The CHANGELOG entry says so.
- FreeBSD's `sysexits(3)` now describes the interface as deprecated and
  discouraged, on the grounds that it is not portable and the choice of a
  value is often ambiguous. The values are used here as a published
  vocabulary, not through the header, so portability of the header does not
  matter; the ambiguity is settled once, in this record and in the README
  table.
- An output file that was created but could not be written completely
  (a full disk) reports `73`, although `EX_CANTCREAT` strictly speaks of
  creation. `std::fs::write` does not say which step failed, and to the
  caller the result is the same: the named output is not usable.
- A panic still exits with Rust's `101`. No code path maps one to `70`.
- The table lives in three places: `Failure::code`, the crate README and
  this record. A unit test in `exit.rs` fails when the README table and
  `Failure::code` disagree.

## Alternatives considered

- **Small consecutive codes (`3`, `4`, `5`, …).** Rejected: the numbers
  would mean nothing outside this project, and would be one more list to
  invent and defend.
- **`EX_USAGE` (64) for usage errors.** Rejected for the reason above: it
  would split usage errors between `2` (from `clap`) and `64`.
- **The most severe failure wins.** Rejected: it needs an ordering of the
  kinds that no source defines.
- **A flag to keep the old single code.** Rejected: pre-1.0, compatibility
  switches are not carried ([ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md)).

## References

- FreeBSD `sysexits(3)`:
  <https://man.freebsd.org/cgi/man.cgi?query=sysexits&sektion=3>
- `crates/cli/src/exit.rs`, `crates/cli/tests/exit_codes.rs`,
  `crates/cli/README.md` ("Exit codes")
- Watch signal: a request to distinguish kinds the table merges (for
  example a parse error from an oversized input) is a reason to revisit the
  granularity, not the scheme.
