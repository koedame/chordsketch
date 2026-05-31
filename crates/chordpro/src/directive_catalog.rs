//! Single source of truth for the ChordPro directive catalog.
//!
//! Every directive the parser recognises (see
//! [`crate::ast::DirectiveKind::from_name`]) has one entry here, carrying
//! its canonical name, short aliases, the shape of its value, and a
//! one-line description. The catalog exists so editor tooling — the LSP
//! completion provider (VS Code etc.) and, via the wasm bindings, the web
//! CodeMirror editor and the playground "+ Directive" picker — all read
//! ONE list instead of each maintaining its own drifting copy (see
//! `.claude/rules/fix-propagation.md`, ADR-0028).
//!
//! The crate is zero-dependency, so the catalog is plain `&'static` data;
//! serialization to JS happens at the wasm boundary, not here.
//!
//! A consistency test in this module asserts every catalog name + alias
//! resolves through `DirectiveKind::from_name` to the same (non-`Unknown`)
//! kind, so the catalog can never silently diverge from the parser.

/// The value a directive accepts after its colon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectiveValueKind {
    /// Value-less directive (e.g. `{new_page}`, `{soc}`).
    None,
    /// Free-form value with no fixed set (e.g. `{title: …}`, `{tempo: …}`).
    FreeForm,
    /// Value is one of a fixed set — completable (e.g. `{diagrams: …}`).
    Enum(&'static [&'static str]),
}

/// One directive's catalog entry.
#[derive(Debug, Clone, Copy)]
pub struct DirectiveInfo {
    /// Canonical directive name (what `from_name` canonicalises to).
    pub name: &'static str,
    /// Short / alternate spellings that resolve to the same directive.
    pub aliases: &'static [&'static str],
    /// What the directive accepts after the colon.
    pub value: DirectiveValueKind,
    /// One-line human description for completion documentation.
    pub summary: &'static str,
}

/// Completable value set for `{diagrams: …}`.
///
/// `on` / `off` / `guitar` / `ukulele` / `piano` are the standard ChordPro
/// values; `top` / `bottom` / `right` / `below` are the section-position
/// keywords; `section` is the default end-of-song diagram grid mode;
/// `inline` / `hover` are the chordsketch surfacing-mode extension
/// (ADR-0027). The parser also accepts the aliases `uke` / `keyboard` /
/// `keys`, but completion offers the canonical forms only.
const DIAGRAMS_VALUES: &[&str] = &[
    "on", "off", "guitar", "ukulele", "piano", "top", "bottom", "right", "below", "section",
    "inline", "hover",
];

/// Completable value set for the legacy `{pagetype: …}` directive.
const PAGETYPE_VALUES: &[&str] = &["a4", "letter"];

const NONE: DirectiveValueKind = DirectiveValueKind::None;
const FREE: DirectiveValueKind = DirectiveValueKind::FreeForm;

/// The directive catalog. One entry per directive recognised by
/// [`crate::ast::DirectiveKind::from_name`]; the consistency test below
/// enforces that correspondence in both directions.
pub const DIRECTIVES: &[DirectiveInfo] = &[
    // --- Metadata ---
    DirectiveInfo {
        name: "title",
        aliases: &["t"],
        value: FREE,
        summary: "Song title",
    },
    DirectiveInfo {
        name: "subtitle",
        aliases: &["st"],
        value: FREE,
        summary: "Song subtitle",
    },
    DirectiveInfo {
        name: "artist",
        aliases: &[],
        value: FREE,
        summary: "Performing artist",
    },
    DirectiveInfo {
        name: "composer",
        aliases: &[],
        value: FREE,
        summary: "Composer",
    },
    DirectiveInfo {
        name: "lyricist",
        aliases: &[],
        value: FREE,
        summary: "Lyricist",
    },
    DirectiveInfo {
        name: "album",
        aliases: &[],
        value: FREE,
        summary: "Album",
    },
    DirectiveInfo {
        name: "year",
        aliases: &[],
        value: FREE,
        summary: "Year",
    },
    DirectiveInfo {
        name: "key",
        aliases: &[],
        value: FREE,
        summary: "Musical key",
    },
    DirectiveInfo {
        name: "tempo",
        aliases: &[],
        value: FREE,
        summary: "Tempo (BPM)",
    },
    DirectiveInfo {
        name: "time",
        aliases: &[],
        value: FREE,
        summary: "Time signature",
    },
    DirectiveInfo {
        name: "capo",
        aliases: &[],
        value: FREE,
        summary: "Capo fret position",
    },
    DirectiveInfo {
        name: "sorttitle",
        aliases: &[],
        value: FREE,
        summary: "Sort-order title",
    },
    DirectiveInfo {
        name: "sortartist",
        aliases: &[],
        value: FREE,
        summary: "Sort-order artist",
    },
    DirectiveInfo {
        name: "arranger",
        aliases: &[],
        value: FREE,
        summary: "Arranger",
    },
    DirectiveInfo {
        name: "copyright",
        aliases: &[],
        value: FREE,
        summary: "Copyright notice",
    },
    DirectiveInfo {
        name: "duration",
        aliases: &[],
        value: FREE,
        summary: "Song duration",
    },
    DirectiveInfo {
        name: "tag",
        aliases: &[],
        value: FREE,
        summary: "Categorisation tag",
    },
    // --- Transpose ---
    DirectiveInfo {
        name: "transpose",
        aliases: &[],
        value: FREE,
        summary: "Transpose semitones",
    },
    // --- Song boundary ---
    DirectiveInfo {
        name: "new_song",
        aliases: &["ns"],
        value: NONE,
        summary: "Start a new song",
    },
    // --- Comments ---
    DirectiveInfo {
        name: "comment",
        aliases: &["c"],
        value: FREE,
        summary: "Comment line",
    },
    DirectiveInfo {
        name: "comment_italic",
        aliases: &["ci"],
        value: FREE,
        summary: "Italic comment",
    },
    DirectiveInfo {
        name: "comment_box",
        aliases: &["cb"],
        value: FREE,
        summary: "Boxed comment",
    },
    DirectiveInfo {
        name: "highlight",
        aliases: &[],
        value: FREE,
        summary: "Highlighted comment",
    },
    // --- Environments (sections) ---
    DirectiveInfo {
        name: "start_of_chorus",
        aliases: &["soc"],
        value: FREE,
        summary: "Begin chorus (optional label)",
    },
    DirectiveInfo {
        name: "end_of_chorus",
        aliases: &["eoc"],
        value: NONE,
        summary: "End chorus",
    },
    DirectiveInfo {
        name: "start_of_verse",
        aliases: &["sov"],
        value: FREE,
        summary: "Begin verse (optional label)",
    },
    DirectiveInfo {
        name: "end_of_verse",
        aliases: &["eov"],
        value: NONE,
        summary: "End verse",
    },
    DirectiveInfo {
        name: "start_of_bridge",
        aliases: &["sob"],
        value: FREE,
        summary: "Begin bridge (optional label)",
    },
    DirectiveInfo {
        name: "end_of_bridge",
        aliases: &["eob"],
        value: NONE,
        summary: "End bridge",
    },
    DirectiveInfo {
        name: "start_of_tab",
        aliases: &["sot"],
        value: FREE,
        summary: "Begin tablature block",
    },
    DirectiveInfo {
        name: "end_of_tab",
        aliases: &["eot"],
        value: NONE,
        summary: "End tablature block",
    },
    DirectiveInfo {
        name: "start_of_grid",
        aliases: &["sog"],
        value: FREE,
        summary: "Begin chord grid",
    },
    DirectiveInfo {
        name: "end_of_grid",
        aliases: &["eog"],
        value: NONE,
        summary: "End chord grid",
    },
    // --- Delegate / verbatim environments ---
    DirectiveInfo {
        name: "start_of_abc",
        aliases: &[],
        value: NONE,
        summary: "Begin ABC notation block",
    },
    DirectiveInfo {
        name: "end_of_abc",
        aliases: &[],
        value: NONE,
        summary: "End ABC notation block",
    },
    DirectiveInfo {
        name: "start_of_ly",
        aliases: &[],
        value: NONE,
        summary: "Begin Lilypond block",
    },
    DirectiveInfo {
        name: "end_of_ly",
        aliases: &[],
        value: NONE,
        summary: "End Lilypond block",
    },
    DirectiveInfo {
        name: "start_of_svg",
        aliases: &[],
        value: NONE,
        summary: "Begin SVG block",
    },
    DirectiveInfo {
        name: "end_of_svg",
        aliases: &[],
        value: NONE,
        summary: "End SVG block",
    },
    DirectiveInfo {
        name: "start_of_textblock",
        aliases: &[],
        value: NONE,
        summary: "Begin preformatted text block",
    },
    DirectiveInfo {
        name: "end_of_textblock",
        aliases: &[],
        value: NONE,
        summary: "End preformatted text block",
    },
    DirectiveInfo {
        name: "start_of_musicxml",
        aliases: &[],
        value: NONE,
        summary: "Begin MusicXML block",
    },
    DirectiveInfo {
        name: "end_of_musicxml",
        aliases: &[],
        value: NONE,
        summary: "End MusicXML block",
    },
    // --- Recall ---
    DirectiveInfo {
        name: "chorus",
        aliases: &[],
        value: FREE,
        summary: "Recall the last chorus (optional label)",
    },
    // --- Page control ---
    DirectiveInfo {
        name: "new_page",
        aliases: &["np"],
        value: NONE,
        summary: "Page break",
    },
    DirectiveInfo {
        name: "new_physical_page",
        aliases: &["npp"],
        value: NONE,
        summary: "Physical page break",
    },
    DirectiveInfo {
        name: "column_break",
        aliases: &["colb"],
        value: NONE,
        summary: "Column break",
    },
    DirectiveInfo {
        name: "columns",
        aliases: &["col"],
        value: FREE,
        summary: "Number of columns",
    },
    DirectiveInfo {
        name: "pagetype",
        aliases: &[],
        value: DirectiveValueKind::Enum(PAGETYPE_VALUES),
        summary: "Page size (legacy)",
    },
    // --- Font / size / colour ---
    DirectiveInfo {
        name: "textfont",
        aliases: &["tf"],
        value: FREE,
        summary: "Lyrics font",
    },
    DirectiveInfo {
        name: "textsize",
        aliases: &["ts"],
        value: FREE,
        summary: "Lyrics size",
    },
    DirectiveInfo {
        name: "textcolour",
        aliases: &["tc"],
        value: FREE,
        summary: "Lyrics colour",
    },
    DirectiveInfo {
        name: "chordfont",
        aliases: &["cf"],
        value: FREE,
        summary: "Chord font",
    },
    DirectiveInfo {
        name: "chordsize",
        aliases: &["cs"],
        value: FREE,
        summary: "Chord size",
    },
    DirectiveInfo {
        name: "chordcolour",
        aliases: &["cc"],
        value: FREE,
        summary: "Chord colour",
    },
    DirectiveInfo {
        name: "tabfont",
        aliases: &[],
        value: FREE,
        summary: "Tablature font",
    },
    DirectiveInfo {
        name: "tabsize",
        aliases: &[],
        value: FREE,
        summary: "Tablature size",
    },
    DirectiveInfo {
        name: "tabcolour",
        aliases: &[],
        value: FREE,
        summary: "Tablature colour",
    },
    DirectiveInfo {
        name: "titlefont",
        aliases: &[],
        value: FREE,
        summary: "Title font",
    },
    DirectiveInfo {
        name: "titlesize",
        aliases: &[],
        value: FREE,
        summary: "Title size",
    },
    DirectiveInfo {
        name: "titlecolour",
        aliases: &[],
        value: FREE,
        summary: "Title colour",
    },
    DirectiveInfo {
        name: "chorusfont",
        aliases: &[],
        value: FREE,
        summary: "Chorus font",
    },
    DirectiveInfo {
        name: "chorussize",
        aliases: &[],
        value: FREE,
        summary: "Chorus size",
    },
    DirectiveInfo {
        name: "choruscolour",
        aliases: &[],
        value: FREE,
        summary: "Chorus colour",
    },
    DirectiveInfo {
        name: "footerfont",
        aliases: &[],
        value: FREE,
        summary: "Footer font",
    },
    DirectiveInfo {
        name: "footersize",
        aliases: &[],
        value: FREE,
        summary: "Footer size",
    },
    DirectiveInfo {
        name: "footercolour",
        aliases: &[],
        value: FREE,
        summary: "Footer colour",
    },
    DirectiveInfo {
        name: "headerfont",
        aliases: &[],
        value: FREE,
        summary: "Header font",
    },
    DirectiveInfo {
        name: "headersize",
        aliases: &[],
        value: FREE,
        summary: "Header size",
    },
    DirectiveInfo {
        name: "headercolour",
        aliases: &[],
        value: FREE,
        summary: "Header colour",
    },
    DirectiveInfo {
        name: "labelfont",
        aliases: &[],
        value: FREE,
        summary: "Section-label font",
    },
    DirectiveInfo {
        name: "labelsize",
        aliases: &[],
        value: FREE,
        summary: "Section-label size",
    },
    DirectiveInfo {
        name: "labelcolour",
        aliases: &[],
        value: FREE,
        summary: "Section-label colour",
    },
    DirectiveInfo {
        name: "gridfont",
        aliases: &[],
        value: FREE,
        summary: "Grid font",
    },
    DirectiveInfo {
        name: "gridsize",
        aliases: &[],
        value: FREE,
        summary: "Grid size",
    },
    DirectiveInfo {
        name: "gridcolour",
        aliases: &[],
        value: FREE,
        summary: "Grid colour",
    },
    DirectiveInfo {
        name: "tocfont",
        aliases: &[],
        value: FREE,
        summary: "Table-of-contents font",
    },
    DirectiveInfo {
        name: "tocsize",
        aliases: &[],
        value: FREE,
        summary: "Table-of-contents size",
    },
    DirectiveInfo {
        name: "toccolour",
        aliases: &[],
        value: FREE,
        summary: "Table-of-contents colour",
    },
    // --- Chord definitions and diagrams ---
    DirectiveInfo {
        name: "define",
        aliases: &[],
        value: FREE,
        summary: "Define a chord shape",
    },
    DirectiveInfo {
        name: "chord",
        aliases: &[],
        value: FREE,
        summary: "Reference a defined chord",
    },
    DirectiveInfo {
        name: "diagrams",
        aliases: &[],
        value: DirectiveValueKind::Enum(DIAGRAMS_VALUES),
        summary: "Chord-diagram visibility / instrument / position / mode",
    },
    DirectiveInfo {
        name: "no_diagrams",
        aliases: &["nodiagrams"],
        value: NONE,
        summary: "Suppress chord diagrams",
    },
    // --- Generic metadata + image ---
    DirectiveInfo {
        name: "meta",
        aliases: &[],
        value: FREE,
        summary: "Generic metadata (key value)",
    },
    DirectiveInfo {
        name: "image",
        aliases: &[],
        value: FREE,
        summary: "Embed an image",
    },
];

/// Returns the full directive catalog.
#[must_use]
pub fn directives() -> &'static [DirectiveInfo] {
    DIRECTIVES
}

/// Looks up a directive entry by canonical name or alias (case-insensitive).
#[must_use]
pub fn lookup(name: &str) -> Option<&'static DirectiveInfo> {
    let lower = name.trim().to_ascii_lowercase();
    DIRECTIVES
        .iter()
        .find(|d| d.name == lower || d.aliases.contains(&lower.as_str()))
}

/// Returns the completable value set for a directive whose value is an
/// [`DirectiveValueKind::Enum`], or `None` for free-form / value-less
/// directives and unknown names. Alias-aware.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::directive_catalog::directive_value_options;
///
/// assert!(directive_value_options("diagrams").unwrap().contains(&"inline"));
/// assert_eq!(directive_value_options("title"), None);
/// assert_eq!(directive_value_options("not-a-directive"), None);
/// ```
#[must_use]
pub fn directive_value_options(name: &str) -> Option<&'static [&'static str]> {
    match lookup(name)?.value {
        DirectiveValueKind::Enum(values) => Some(values),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::DirectiveKind;

    #[test]
    fn every_catalog_name_and_alias_resolves_to_a_known_directive() {
        // The catalog must never list a name the parser does not know:
        // each canonical name and alias must resolve through `from_name`
        // to a non-`Unknown` kind, and every alias must resolve to the
        // same kind as its canonical name. This is the guard against the
        // catalog drifting from `DirectiveKind::from_name`.
        for d in DIRECTIVES {
            let canonical_kind = DirectiveKind::from_name(d.name);
            assert!(
                !matches!(canonical_kind, DirectiveKind::Unknown(_)),
                "catalog directive {:?} is not recognised by from_name",
                d.name
            );
            for alias in d.aliases {
                assert_eq!(
                    DirectiveKind::from_name(alias),
                    canonical_kind,
                    "alias {alias:?} of {:?} resolves to a different kind",
                    d.name
                );
            }
        }
    }

    #[test]
    fn catalog_names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for d in DIRECTIVES {
            assert!(seen.insert(d.name), "duplicate catalog name {:?}", d.name);
        }
    }

    #[test]
    fn diagrams_enum_includes_inline_and_hover_extension_values() {
        let values = directive_value_options("diagrams").expect("diagrams is an enum directive");
        for expected in [
            "on", "off", "guitar", "ukulele", "piano", "inline", "hover", "section",
        ] {
            assert!(
                values.contains(&expected),
                "diagrams values missing {expected:?}"
            );
        }
    }

    #[test]
    fn every_enum_directive_has_at_least_one_value() {
        for d in DIRECTIVES {
            if let DirectiveValueKind::Enum(values) = d.value {
                assert!(
                    !values.is_empty(),
                    "directive {:?} has Enum kind but empty values",
                    d.name
                );
            }
        }
    }

    #[test]
    fn free_form_and_value_less_directives_have_no_value_options() {
        assert_eq!(directive_value_options("title"), None);
        assert_eq!(directive_value_options("new_page"), None);
    }

    #[test]
    fn lookup_is_alias_aware_and_case_insensitive() {
        assert_eq!(lookup("SOC").map(|d| d.name), Some("start_of_chorus"));
        assert_eq!(lookup("t").map(|d| d.name), Some("title"));
        assert_eq!(lookup("Diagrams").map(|d| d.name), Some("diagrams"));
        assert!(lookup("definitely-not-a-directive").is_none());
    }

    #[test]
    fn pagetype_offers_its_enum_values() {
        let values = directive_value_options("pagetype").expect("pagetype is an enum directive");
        assert!(values.contains(&"a4"));
        assert!(values.contains(&"letter"));
    }
}
