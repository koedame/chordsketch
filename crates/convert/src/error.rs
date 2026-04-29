//! Error and warning types shared by every conversion direction.

/// Reason a conversion can fail.
///
/// The `NotImplemented` variant is the placeholder every
/// pre-implementation function returns. Subsequent issues
/// (#2053 iReal→ChordPro, #2061 ChordPro→iReal) replace those
/// returns with real implementations; new variants are added at
/// the bottom of the enum to preserve compatibility with code that
/// matches on the existing variants.
///
/// Marked `#[non_exhaustive]` so adding a new variant in a follow-up
/// PR is non-breaking for downstream `match` expressions, matching
/// the additive-evolution contract documented at the crate root.
///
/// # Note for future implementers
///
/// Once #2053 / #2061 land, [`Self::InvalidSource`] and
/// [`Self::UnrepresentableTarget`] will carry parser-derived,
/// potentially attacker-controlled text. Implementations SHOULD
/// truncate or sanitise their messages before constructing these
/// variants; downstream `Display` consumers and log forwarders
/// MUST NOT assume bounded length until that bound is enforced
/// upstream. (Same pattern as `chordsketch_ireal::json::truncate_for_message`.)
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConversionError {
    /// The conversion direction is recognised but not yet
    /// implemented in this crate version. The contained `&'static
    /// str` is the URL of the issue tracking the implementation
    /// so callers can give a useful diagnostic.
    NotImplemented(&'static str),
    /// The source value was structurally invalid and could not be
    /// converted at all (distinct from a lossy-but-successful
    /// conversion, which returns `Ok` with warnings).
    InvalidSource(String),
    /// The conversion would produce a target value that is not
    /// representable in the target format (e.g. an out-of-range
    /// time signature on the iReal side).
    UnrepresentableTarget(String),
}

impl std::fmt::Display for ConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotImplemented(tracking_url) => {
                write!(
                    f,
                    "conversion not yet implemented (tracked at {tracking_url})"
                )
            }
            Self::InvalidSource(msg) => write!(f, "invalid source: {msg}"),
            Self::UnrepresentableTarget(msg) => {
                write!(f, "unrepresentable target: {msg}")
            }
        }
    }
}

impl std::error::Error for ConversionError {}

/// A non-fatal information loss recorded during conversion.
///
/// Conversions return `Ok(ConversionOutput { warnings, .. })` for
/// lossy-but-successful runs; callers decide whether to fail on a
/// non-empty warning list. This keeps the strictness policy in the
/// caller's hands rather than baking it into the converter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionWarning {
    /// Class of information loss.
    pub kind: WarningKind,
    /// Human-readable description of what was dropped or
    /// approximated.
    pub message: String,
}

impl ConversionWarning {
    /// Constructs a warning with the given kind and message.
    #[must_use]
    pub fn new(kind: WarningKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// Class of information loss in a [`ConversionWarning`].
///
/// New variants are appended; existing variants are stable across
/// minor versions. Marked `#[non_exhaustive]` so adding a variant
/// is non-breaking for downstream `match` arms.
///
/// `Copy` is intentional here because every variant is fieldless,
/// matching the per-warning struct (`ConversionWarning`) which
/// owns the attached message and is therefore not `Copy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum WarningKind {
    /// A feature in the source format has no equivalent in the
    /// target format and was dropped (e.g. lyrics on a
    /// ChordPro→iReal conversion — iReal has no lyrics surface).
    LossyDrop,
    /// A feature in the source format was approximated to the
    /// nearest equivalent in the target format (e.g. an unusual
    /// section label mapped to the closest iReal letter).
    Approximated,
    /// A feature in the source format is not yet supported by the
    /// converter, even though the target format could in principle
    /// represent it. Distinct from `LossyDrop` because resolving
    /// it is a future converter-side change rather than an inherent
    /// format limitation.
    Unsupported,
}
