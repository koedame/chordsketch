//! Errors returned by the Guitar Pro importer.

/// Why a Guitar Pro file could not be imported.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum GpError {
    /// The input is larger than [`crate::MAX_INPUT_BYTES`].
    TooLarge {
        /// Size of the rejected input in bytes.
        size: usize,
    },
    /// The file is not a Guitar Pro 5 file (or is a GP5 clipboard
    /// fragment). `version` is the version string found at the start of the
    /// file, or empty when there was none.
    UnsupportedVersion {
        /// Version string read from the file header.
        version: String,
    },
    /// The file ended before a structure the format requires.
    Truncated {
        /// Byte offset at which more input was needed.
        offset: usize,
    },
    /// A value in the file is impossible for a valid GP5 file.
    InvalidData {
        /// Byte offset of the offending value.
        offset: usize,
        /// What was wrong with it.
        message: String,
    },
    /// `ImportOptions::track` names a track the file does not have.
    TrackOutOfRange {
        /// The 1-based track number that was requested.
        requested: usize,
        /// The names of the tracks the file does have, in order.
        tracks: Vec<String>,
    },
}

impl std::fmt::Display for GpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { size } => write!(
                f,
                "Guitar Pro input is {size} bytes; the limit is {} bytes",
                crate::MAX_INPUT_BYTES
            ),
            Self::UnsupportedVersion { version } if version.is_empty() => {
                write!(f, "not a Guitar Pro 5 file (no version header)")
            }
            Self::UnsupportedVersion { version } => write!(
                f,
                "unsupported Guitar Pro version \"{version}\" (only Guitar Pro 5 files are supported)"
            ),
            Self::Truncated { offset } => {
                write!(f, "Guitar Pro file is truncated at byte {offset}")
            }
            Self::InvalidData { offset, message } => {
                write!(f, "invalid Guitar Pro data at byte {offset}: {message}")
            }
            Self::TrackOutOfRange { requested, tracks } => {
                write!(
                    f,
                    "track {requested} does not exist; the file has {} track(s)",
                    tracks.len()
                )?;
                for (i, name) in tracks.iter().enumerate() {
                    write!(f, "{}{}: {name}", if i == 0 { ": " } else { ", " }, i + 1)?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for GpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_a_track_is_out_of_range_the_message_lists_the_tracks() {
        let err = GpError::TrackOutOfRange {
            requested: 4,
            tracks: vec!["Lead".to_string(), "Rhythm".to_string()],
        };
        assert_eq!(
            err.to_string(),
            "track 4 does not exist; the file has 2 track(s): 1: Lead, 2: Rhythm"
        );
    }

    #[test]
    fn when_the_version_header_is_missing_the_message_says_so() {
        let err = GpError::UnsupportedVersion {
            version: String::new(),
        };
        assert_eq!(
            err.to_string(),
            "not a Guitar Pro 5 file (no version header)"
        );
    }

    #[test]
    fn when_the_version_header_names_an_unsupported_version_it_is_quoted() {
        let err = GpError::UnsupportedVersion {
            version: "FICHIER GUITAR PRO v4.06".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "unsupported Guitar Pro version \"FICHIER GUITAR PRO v4.06\" \
             (only Guitar Pro 5 files are supported)"
        );
    }

    #[test]
    fn when_the_input_is_too_large_the_message_names_the_limit() {
        let err = GpError::TooLarge {
            size: crate::MAX_INPUT_BYTES + 1,
        };
        assert_eq!(
            err.to_string(),
            format!(
                "Guitar Pro input is {} bytes; the limit is {} bytes",
                crate::MAX_INPUT_BYTES + 1,
                crate::MAX_INPUT_BYTES
            )
        );
    }

    #[test]
    fn when_the_input_is_truncated_the_message_names_the_offset() {
        let err = GpError::Truncated { offset: 42 };
        assert_eq!(err.to_string(), "Guitar Pro file is truncated at byte 42");
    }

    #[test]
    fn when_a_value_is_invalid_the_message_names_the_offset_and_reason() {
        let err = GpError::InvalidData {
            offset: 7,
            message: "negative measure count (-1)".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "invalid Guitar Pro data at byte 7: negative measure count (-1)"
        );
    }
}
