//! Selector resolution for conditional directives.
//!
//! ChordPro directives can have a selector suffix (e.g., `{textfont-piano: Courier}`)
//! that targets a specific instrument or user. The selector resolution logic
//! determines whether a directive should be applied based on the current
//! rendering context.
//!
//! # Examples
//!
//! ```
//! use chordpro_core::selector::SelectorContext;
//!
//! let ctx = SelectorContext::new(Some("guitar"), None);
//! assert!(ctx.matches(None));           // No selector = always matches
//! assert!(ctx.matches(Some("guitar"))); // Matches active instrument
//! assert!(!ctx.matches(Some("piano"))); // Different instrument
//! ```

/// Context for resolving directive selectors.
///
/// Holds the active instrument type and user name from configuration.
/// Directives with selectors are tested against this context to decide
/// whether they should be applied.
#[derive(Debug, Clone, Default)]
pub struct SelectorContext {
    /// The active instrument type (e.g., `"guitar"`, `"ukulele"`).
    pub instrument: Option<String>,
    /// The active user name (e.g., `"default"`, `"john"`).
    pub user: Option<String>,
}

impl SelectorContext {
    /// Create a new selector context.
    #[must_use]
    pub fn new(instrument: Option<&str>, user: Option<&str>) -> Self {
        Self {
            instrument: instrument.map(|s| s.to_ascii_lowercase()),
            user: user.map(|s| s.to_ascii_lowercase()),
        }
    }

    /// Create a context from a [`Config`](crate::config::Config).
    ///
    /// Reads `instrument.type` and `user.name` from the configuration.
    #[must_use]
    pub fn from_config(config: &crate::config::Config) -> Self {
        let instrument = config
            .get_path("instrument.type")
            .as_str()
            .map(|s| s.to_ascii_lowercase());
        let user = config
            .get_path("user.name")
            .as_str()
            .map(|s| s.to_ascii_lowercase());
        Self { instrument, user }
    }

    /// Test whether a directive selector matches this context.
    ///
    /// - `None` (no selector) → always matches
    /// - `Some(selector)` → matches if it equals the active instrument or user
    ///   (case-insensitive comparison)
    ///
    /// Unrecognized selectors (that match neither instrument nor user) are
    /// silently ignored (return `false`).
    #[must_use]
    pub fn matches(&self, selector: Option<&str>) -> bool {
        let Some(sel) = selector else {
            return true; // No selector = unconditional
        };
        let sel_lower = sel.to_ascii_lowercase();

        // Check against instrument
        if let Some(ref instrument) = self.instrument {
            if *instrument == sel_lower {
                return true;
            }
        }

        // Check against user
        if let Some(ref user) = self.user {
            if *user == sel_lower {
                return true;
            }
        }

        false
    }

    /// Test whether a [`Directive`](crate::ast::Directive)'s selector matches.
    #[must_use]
    pub fn matches_directive(&self, directive: &crate::ast::Directive) -> bool {
        self.matches(directive.selector.as_deref())
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_selector_always_matches() {
        let ctx = SelectorContext::default();
        assert!(ctx.matches(None));
    }

    #[test]
    fn test_instrument_match() {
        let ctx = SelectorContext::new(Some("guitar"), None);
        assert!(ctx.matches(Some("guitar")));
    }

    #[test]
    fn test_instrument_mismatch() {
        let ctx = SelectorContext::new(Some("guitar"), None);
        assert!(!ctx.matches(Some("piano")));
    }

    #[test]
    fn test_instrument_case_insensitive() {
        let ctx = SelectorContext::new(Some("Guitar"), None);
        assert!(ctx.matches(Some("GUITAR")));
        assert!(ctx.matches(Some("guitar")));
    }

    #[test]
    fn test_user_match() {
        let ctx = SelectorContext::new(None, Some("john"));
        assert!(ctx.matches(Some("john")));
    }

    #[test]
    fn test_user_mismatch() {
        let ctx = SelectorContext::new(None, Some("john"));
        assert!(!ctx.matches(Some("alice")));
    }

    #[test]
    fn test_both_instrument_and_user() {
        let ctx = SelectorContext::new(Some("guitar"), Some("john"));
        assert!(ctx.matches(Some("guitar")));
        assert!(ctx.matches(Some("john")));
        assert!(!ctx.matches(Some("piano")));
    }

    #[test]
    fn test_empty_context_rejects_selector() {
        let ctx = SelectorContext::default();
        assert!(!ctx.matches(Some("anything")));
    }

    #[test]
    fn test_from_config() {
        let config = crate::config::Config::parse(
            r#"{"instrument": {"type": "ukulele"}, "user": {"name": "Alice"}}"#,
        )
        .unwrap();
        let ctx = SelectorContext::from_config(&config);
        assert!(ctx.matches(Some("ukulele")));
        assert!(ctx.matches(Some("alice"))); // case-insensitive
        assert!(!ctx.matches(Some("guitar")));
    }

    #[test]
    fn test_from_config_missing_fields() {
        let config = crate::config::Config::empty();
        let ctx = SelectorContext::from_config(&config);
        assert!(ctx.matches(None));
        assert!(!ctx.matches(Some("guitar")));
    }

    #[test]
    fn test_matches_directive() {
        let ctx = SelectorContext::new(Some("guitar"), None);
        let directive = crate::ast::Directive {
            name: "textfont".to_string(),
            value: Some("Courier".to_string()),
            kind: crate::ast::DirectiveKind::TextFont,
            selector: Some("guitar".to_string()),
        };
        assert!(ctx.matches_directive(&directive));
    }

    #[test]
    fn test_matches_directive_no_selector() {
        let ctx = SelectorContext::new(Some("guitar"), None);
        let directive = crate::ast::Directive {
            name: "textfont".to_string(),
            value: Some("Courier".to_string()),
            kind: crate::ast::DirectiveKind::TextFont,
            selector: None,
        };
        assert!(ctx.matches_directive(&directive));
    }

    #[test]
    fn test_matches_directive_mismatch() {
        let ctx = SelectorContext::new(Some("guitar"), None);
        let directive = crate::ast::Directive {
            name: "textfont".to_string(),
            value: Some("Courier".to_string()),
            kind: crate::ast::DirectiveKind::TextFont,
            selector: Some("piano".to_string()),
        };
        assert!(!ctx.matches_directive(&directive));
    }
}
