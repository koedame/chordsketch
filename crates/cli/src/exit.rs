//! Exit codes of the `chordsketch` binary.
//!
//! [`Failure`] is the only place a failure kind is turned into a number.
//! The user-facing table in the crate README is checked against it by the
//! test at the bottom of this file, and `tests/exit_codes.rs` asserts each
//! code on the built binary.
//!
//! The values above 2 are the BSD `sysexits.h` ones
//! (<https://man.freebsd.org/cgi/man.cgi?query=sysexits&sektion=3>), the
//! one published list of exit codes for "what kind of failure was it", so a
//! script can tell the kinds apart without matching on stderr text.

use std::process::ExitCode;

/// Why a run did not succeed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// `fmt --check` found a file that needs formatting. This is the answer
    /// to the question the command asks rather than an error, so it keeps
    /// the conventional `1` of `diff` and `rustfmt --check`.
    Unformatted,
    /// The command line is wrong. `2` is what `clap` itself exits with for
    /// the errors it detects, so every usage error shares one code.
    Usage,
    /// The input was read but is not valid: a parse error, an input over
    /// the size limit, bytes that are not UTF-8, or a format `convert`
    /// cannot detect (`EX_DATAERR`).
    Data,
    /// An input file does not exist or cannot be read (`EX_NOINPUT`).
    NoInput,
    /// The MCP server could not start or stopped abnormally
    /// (`EX_SOFTWARE`).
    Software,
    /// A file named by `-o`, or a file `fmt` rewrites in place, could not
    /// be written (`EX_CANTCREAT`).
    CantCreate,
    /// Reading stdin or writing stdout failed (`EX_IOERR`).
    Io,
    /// The MCP client closed the connection or sent something unusable
    /// during the handshake (`EX_PROTOCOL`).
    Protocol,
    /// A `--config` file is missing, unreadable or malformed
    /// (`EX_CONFIG`).
    Config,
}

impl Failure {
    /// Every kind, for checking the documented table against [`code`].
    ///
    /// [`code`]: Failure::code
    #[cfg(test)]
    const ALL: [Self; 9] = [
        Self::Unformatted,
        Self::Usage,
        Self::Data,
        Self::NoInput,
        Self::Software,
        Self::CantCreate,
        Self::Io,
        Self::Protocol,
        Self::Config,
    ];

    /// The process exit code for this kind of failure.
    #[must_use]
    pub(crate) const fn code(self) -> u8 {
        match self {
            Self::Unformatted => 1,
            Self::Usage => 2,
            Self::Data => 65,
            Self::NoInput => 66,
            Self::Software => 70,
            Self::CantCreate => 73,
            Self::Io => 74,
            Self::Protocol => 76,
            Self::Config => 78,
        }
    }
}

impl From<Failure> for ExitCode {
    fn from(failure: Failure) -> Self {
        Self::from(failure.code())
    }
}

/// The exit code of a run that reported `first_failure`, or success when
/// nothing failed.
pub(crate) fn exit_code(first_failure: Option<Failure>) -> ExitCode {
    first_failure.map_or(ExitCode::SUCCESS, ExitCode::from)
}

#[cfg(test)]
mod tests {
    use super::Failure;

    /// The codes listed in the "Exit codes" table of the crate README.
    fn documented_codes() -> Vec<u8> {
        // Line by line, so a checkout with CRLF line endings reads the same.
        let codes: Vec<u8> = include_str!("../README.md")
            .lines()
            .skip_while(|line| *line != "## Exit codes")
            .skip(1)
            .take_while(|line| !line.starts_with("## "))
            .filter_map(|line| line.strip_prefix("| `"))
            .filter_map(|rest| rest.split('`').next())
            .map(|code| code.parse().expect("the first column is an exit code"))
            .collect();
        assert!(!codes.is_empty(), "the README has an `## Exit codes` table");
        codes
    }

    #[test]
    fn the_readme_table_lists_success_and_exactly_the_codes_failure_maps_to() {
        let mut expected: Vec<u8> = Failure::ALL.iter().map(|f| f.code()).collect();
        expected.insert(0, 0);
        assert_eq!(documented_codes(), expected);
    }

    #[test]
    fn every_failure_kind_has_its_own_non_zero_code() {
        let mut codes: Vec<u8> = Failure::ALL.iter().map(|f| f.code()).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), Failure::ALL.len());
        assert!(!codes.contains(&0));
    }
}
