//! The size limit for ChordPro source, and a bounded reader to enforce it.
//!
//! The parser refuses a source over [`MAX_INPUT_BYTES`]. Every entry point
//! that takes a source from outside — a file, standard input, an editor
//! buffer — checks the same number before it reads or hands the text on, so
//! an oversized source fails early with one message instead of travelling
//! to the parser first, and raising the limit is one edit.

use std::fmt;
use std::io::{self, Read};

/// Maximum size of a ChordPro source, in bytes (10 MiB). The parser's
/// [`ParseOptions::max_input_size`](crate::ParseOptions::max_input_size)
/// default.
pub const MAX_INPUT_BYTES: usize = 10 * 1024 * 1024;

/// Why [`read_to_string_limited`] gave up.
#[derive(Debug)]
#[non_exhaustive]
pub enum ReadLimitedError {
    /// The reader holds more than `limit` bytes.
    TooLarge {
        /// The limit that was exceeded, in bytes.
        limit: usize,
    },
    /// Reading failed, or the bytes are not valid UTF-8.
    Io(io::Error),
}

impl fmt::Display for ReadLimitedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } if limit % (1024 * 1024) == 0 => {
                write!(f, "input exceeds the {} MiB limit", limit / (1024 * 1024))
            }
            Self::TooLarge { limit } => write!(f, "input exceeds the {limit} byte limit"),
            Self::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ReadLimitedError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::TooLarge { .. } => None,
            Self::Io(e) => Some(e),
        }
    }
}

/// Read `reader` to a string, refusing more than `limit` bytes.
///
/// At most `limit + 1` bytes are buffered: reading one byte past the limit
/// tells "exactly at the limit" (accepted) from "over it" (rejected) in a
/// single pass, with no separate size check a growing file could outrun. The
/// size is judged before the bytes are decoded, so an oversized source is
/// reported as too large even when the cut falls inside a multi-byte
/// character.
///
/// # Errors
///
/// [`ReadLimitedError::TooLarge`] when the reader holds more than `limit`
/// bytes; [`ReadLimitedError::Io`] when reading fails or the bytes are not
/// UTF-8.
#[must_use = "an oversized or unreadable source must be reported"]
pub fn read_to_string_limited(reader: impl Read, limit: usize) -> Result<String, ReadLimitedError> {
    let mut bytes = Vec::new();
    reader
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(ReadLimitedError::Io)?;
    if bytes.len() > limit {
        return Err(ReadLimitedError::TooLarge { limit });
    }
    String::from_utf8(bytes).map_err(|e| {
        ReadLimitedError::Io(io::Error::new(io::ErrorKind::InvalidData, e.utf8_error()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_to_string_limited_returns_the_text_when_it_is_under_the_limit() {
        assert_eq!(read_to_string_limited("abc".as_bytes(), 10).unwrap(), "abc");
    }

    #[test]
    fn read_to_string_limited_accepts_text_of_exactly_the_limit() {
        assert_eq!(
            read_to_string_limited("abcd".as_bytes(), 4).unwrap(),
            "abcd"
        );
    }

    #[test]
    fn read_to_string_limited_rejects_text_one_byte_over_the_limit() {
        let err = read_to_string_limited("abcde".as_bytes(), 4).unwrap_err();
        assert!(
            matches!(err, ReadLimitedError::TooLarge { limit: 4 }),
            "{err:?}"
        );
    }

    #[test]
    fn read_to_string_limited_stops_reading_just_past_the_limit() {
        struct Endless(u64);
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0 += buf.len() as u64;
                buf.fill(b'a');
                Ok(buf.len())
            }
        }
        let mut source = Endless(0);
        let err = read_to_string_limited(&mut source, 100).unwrap_err();
        assert!(matches!(err, ReadLimitedError::TooLarge { .. }));
        assert!(source.0 <= 100 + 8192, "read {} bytes", source.0);
    }

    #[test]
    fn read_to_string_limited_reports_oversized_cjk_text_as_too_large_not_as_bad_utf8() {
        // Each of these characters is 3 bytes; a limit of 10 cuts the 11th
        // byte inside the 4th character.
        let source = "あいうえお";
        let err = read_to_string_limited(source.as_bytes(), 10).unwrap_err();
        assert!(
            matches!(err, ReadLimitedError::TooLarge { limit: 10 }),
            "{err:?}"
        );
    }

    #[test]
    fn read_to_string_limited_accepts_the_largest_possible_limit_without_overflow() {
        assert_eq!(
            read_to_string_limited("abc".as_bytes(), usize::MAX).unwrap(),
            "abc"
        );
    }

    #[test]
    fn read_to_string_limited_reports_text_that_is_not_utf8_as_an_io_error() {
        let err = read_to_string_limited(&[0xff, 0xfe][..], 10).unwrap_err();
        assert!(matches!(err, ReadLimitedError::Io(_)), "{err:?}");
    }

    #[test]
    fn display_names_the_limit_in_mib_when_it_is_a_whole_number_of_them() {
        let err = ReadLimitedError::TooLarge {
            limit: MAX_INPUT_BYTES,
        };
        assert_eq!(err.to_string(), "input exceeds the 10 MiB limit");
        let err = ReadLimitedError::TooLarge { limit: 100 };
        assert_eq!(err.to_string(), "input exceeds the 100 byte limit");
    }

    #[test]
    fn the_parser_default_is_the_shared_limit() {
        assert_eq!(
            crate::ParseOptions::default().max_input_size,
            MAX_INPUT_BYTES
        );
    }
}
