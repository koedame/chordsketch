//! Plain text renderer for ChordPro documents.

/// Render a ChordPro source string to plain text.
#[must_use]
pub fn render(_input: &str) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_empty() {
        assert_eq!(render(""), "");
    }
}
