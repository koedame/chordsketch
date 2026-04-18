//! Structured render result type for capturing warnings during rendering,
//! plus the canonical warning-accumulation helpers used by every renderer.
//!
//! Shared by `chordsketch-render-text`, `chordsketch-render-html`, and
//! `chordsketch-render-pdf`. Consolidating the helpers here eliminates
//! three maintenance points for the same logic (issue #1874).

use crate::ast::{CapoValidation, Metadata};

/// Maximum number of warnings any renderer accumulates for a single
/// render pass (issue #1833). Without a cap, a pathological input such
/// as one million malformed `{transpose}` lines would push the warnings
/// vector to tens of megabytes. `push_warning` refuses to exceed this
/// limit and appends a single truncation marker the first time the cap
/// is hit.
pub const MAX_WARNINGS: usize = 1000;

/// Push a warning into the renderer's accumulator, enforcing
/// [`MAX_WARNINGS`].
///
/// Once the cap is reached the function pushes a single truncation
/// marker in place of the overflowing warning and silently ignores
/// every subsequent warning in the same pass. Every renderer
/// (`render-text`, `render-html`, `render-pdf`) calls this helper so
/// the cap behaviour is identical across output formats.
pub fn push_warning(warnings: &mut Vec<String>, message: impl Into<String>) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(message.into());
    } else if warnings.len() == MAX_WARNINGS {
        warnings.push(format!(
            "additional warnings suppressed; MAX_WARNINGS ({MAX_WARNINGS}) reached"
        ));
    }
}

/// Validate the `{capo}` metadata value at the render boundary and push
/// a warning for any value outside `1..=24` (issue #1834,
/// `.claude/rules/renderer-parity.md` §Validation Parity).
///
/// Renderers call this helper once at the top of their main entry point
/// so the validation message is byte-identical across output formats —
/// a user who pipes the same `.cho` file to text, HTML, and PDF now
/// sees the same warning regardless of which renderer they chose.
pub fn validate_capo(metadata: &Metadata, warnings: &mut Vec<String>) {
    match metadata.capo_validated() {
        CapoValidation::Unset | CapoValidation::Valid(_) => {}
        CapoValidation::OutOfRange(n) => {
            push_warning(
                warnings,
                format!("{{capo}} value {n} out of range (expected 1..=24); ignored"),
            );
        }
        CapoValidation::NotInteger(raw) => {
            push_warning(
                warnings,
                format!("{{capo}} value {raw:?} is not a valid integer; ignored"),
            );
        }
    }
}

/// Result of a render operation, containing both the rendered output
/// and any warnings produced during rendering.
///
/// Renderers collect warnings (e.g., transpose saturation, chorus recall
/// limits) into [`warnings`](Self::warnings) instead of printing them
/// directly. Callers can inspect and display warnings as they see fit.
#[derive(Debug, Clone)]
#[must_use]
pub struct RenderResult<T> {
    /// The rendered output.
    pub output: T,
    /// Warnings emitted during rendering.
    pub warnings: Vec<String>,
}

impl<T> RenderResult<T> {
    /// Create a new `RenderResult` with the given output and no warnings.
    pub fn new(output: T) -> Self {
        Self {
            output,
            warnings: Vec::new(),
        }
    }

    /// Create a new `RenderResult` with the given output and warnings.
    pub fn with_warnings(output: T, warnings: Vec<String>) -> Self {
        Self { output, warnings }
    }

    /// Returns `true` if there are no warnings.
    #[must_use]
    pub fn has_warnings(&self) -> bool {
        !self.warnings.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_has_no_warnings() {
        let result = RenderResult::new("hello");
        assert_eq!(result.output, "hello");
        assert!(result.warnings.is_empty());
        assert!(!result.has_warnings());
    }

    #[test]
    fn test_with_warnings() {
        let result = RenderResult::with_warnings("output", vec!["warning 1".to_string()]);
        assert_eq!(result.output, "output");
        assert_eq!(result.warnings.len(), 1);
        assert!(result.has_warnings());
    }

    #[test]
    fn test_with_empty_warnings() {
        let result = RenderResult::with_warnings(42, Vec::new());
        assert_eq!(result.output, 42);
        assert!(!result.has_warnings());
    }

    // -- push_warning cap -------------------------------------------------

    #[test]
    fn test_push_warning_under_cap_appends() {
        let mut v: Vec<String> = Vec::new();
        push_warning(&mut v, "a");
        push_warning(&mut v, "b");
        assert_eq!(v, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn test_push_warning_caps_and_truncates_once() {
        let mut v: Vec<String> = Vec::with_capacity(MAX_WARNINGS + 5);
        for i in 0..(MAX_WARNINGS + 50) {
            push_warning(&mut v, format!("w{i}"));
        }
        assert_eq!(v.len(), MAX_WARNINGS + 1);
        assert!(
            v.last().unwrap().contains("MAX_WARNINGS"),
            "last entry must be the truncation marker; got {:?}",
            v.last()
        );
    }

    // -- validate_capo uniform messages -----------------------------------

    #[test]
    fn test_validate_capo_unset_and_valid_emit_nothing() {
        let mut v = Vec::<String>::new();
        let md = Metadata::default();
        validate_capo(&md, &mut v);
        assert!(v.is_empty());

        let md = Metadata {
            capo: Some("5".to_string()),
            ..Metadata::default()
        };
        validate_capo(&md, &mut v);
        assert!(v.is_empty());
    }

    #[test]
    fn test_validate_capo_out_of_range_warns_with_value() {
        let mut v = Vec::<String>::new();
        let md = Metadata {
            capo: Some("999".to_string()),
            ..Metadata::default()
        };
        validate_capo(&md, &mut v);
        assert_eq!(v.len(), 1);
        assert!(v[0].contains("999") && v[0].contains("out of range"));
    }

    #[test]
    fn test_validate_capo_non_integer_warns_with_value() {
        let mut v = Vec::<String>::new();
        let md = Metadata {
            capo: Some("foo".to_string()),
            ..Metadata::default()
        };
        validate_capo(&md, &mut v);
        assert_eq!(v.len(), 1);
        assert!(v[0].contains("foo") && v[0].contains("not a valid integer"));
    }
}
