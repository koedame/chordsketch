//! Directive coverage against the Perl ChordPro reference implementation.
//!
//! The lists below are a snapshot of what ChordPro R6.101.0 (the release
//! recorded in `.github/upstream-version`) recognises: its directive table,
//! its abbreviation table, the `metadata.keys` of its default configuration,
//! and the `<item>font` / `<item>size` / `<item>colour` family. They back the
//! README's statement about which directives are parsed, so a new upstream
//! release is checked by regenerating the snapshot, not by editing the claim.

use chordsketch_chordpro::ast::DirectiveKind;

fn is_known(name: &str) -> bool {
    !matches!(DirectiveKind::from_name(name), DirectiveKind::Unknown(_))
}

const DIRECTIVES: &[&str] = &[
    "chord",
    "chorus",
    "column_break",
    "columns",
    "comment",
    "comment_box",
    "comment_italic",
    "define",
    "diagrams",
    "end_of_bridge",
    "end_of_chorus",
    "end_of_grid",
    "end_of_grille",
    "end_of_tab",
    "end_of_verse",
    "highlight",
    "image",
    "meta",
    "new_page",
    "new_physical_page",
    "new_song",
    "pagetype",
    "start_of_bridge",
    "start_of_chorus",
    "start_of_grid",
    "start_of_grille",
    "start_of_tab",
    "start_of_verse",
    "subtitle",
    "title",
    "transpose",
];

const ABBREVIATIONS: &[(&str, &str)] = &[
    ("c", "comment"),
    ("cb", "comment_box"),
    ("cf", "chordfont"),
    ("ci", "comment_italic"),
    ("col", "columns"),
    ("colb", "column_break"),
    ("cs", "chordsize"),
    ("eob", "end_of_bridge"),
    ("eoc", "end_of_chorus"),
    ("eog", "end_of_grid"),
    ("eot", "end_of_tab"),
    ("eov", "end_of_verse"),
    ("np", "new_page"),
    ("npp", "new_physical_page"),
    ("ns", "new_song"),
    ("sob", "start_of_bridge"),
    ("soc", "start_of_chorus"),
    ("sog", "start_of_grid"),
    ("sot", "start_of_tab"),
    ("sov", "start_of_verse"),
    ("st", "subtitle"),
    ("t", "title"),
    ("tf", "textfont"),
    ("ts", "textsize"),
];

const METADATA_KEYS: &[&str] = &[
    "title",
    "subtitle",
    "album",
    "arranger",
    "artist",
    "capo",
    "composer",
    "copyright",
    "duration",
    "key",
    "lyricist",
    "sortartist",
    "sorttitle",
    "tag",
    "tempo",
    "time",
    "year",
];

/// Upstream's own item list also contains `diagrams`, but `{diagramsfont}` and
/// its siblings are not documented directives, so they are left out here.
const PROPERTY_ITEMS: &[&str] = &[
    "chord", "chorus", "footer", "grid", "label", "tab", "text", "title", "toc",
];

/// Directives ChordPro R6.101.0 still accepts but documents as obsolete or
/// deprecated (`Directives-grid_legacy`, `Directives-titles_legacy`,
/// `Directives-pagetype_legacy`). ChordSketch does not implement them; the
/// list is mirrored in `docs/known-deviations.md`.
const OBSOLETE_UNSUPPORTED: &[&str] = &["grid", "g", "no_grid", "ng", "titles", "pagesize"];

#[test]
fn every_directive_in_the_upstream_table_is_recognised() {
    for name in DIRECTIVES {
        assert!(is_known(name), "{name:?} is not recognised");
    }
}

#[test]
fn every_upstream_abbreviation_resolves_to_the_same_directive_as_its_full_name() {
    for (short, full) in ABBREVIATIONS {
        assert_eq!(
            DirectiveKind::from_name(short),
            DirectiveKind::from_name(full),
            "{short:?} should resolve like {full:?}"
        );
        assert!(is_known(full), "{full:?} is not recognised");
    }
}

#[test]
fn every_upstream_metadata_key_is_recognised() {
    for name in METADATA_KEYS {
        assert!(is_known(name), "metadata key {name:?} is not recognised");
    }
}

#[test]
fn every_upstream_font_size_and_colour_property_is_recognised() {
    for item in PROPERTY_ITEMS {
        for suffix in ["font", "size", "colour", "color"] {
            let name = format!("{item}{suffix}");
            assert!(is_known(&name), "{name:?} is not recognised");
        }
    }
}

#[test]
fn the_obsolete_upstream_directives_are_the_only_ones_left_unrecognised() {
    for name in OBSOLETE_UNSUPPORTED {
        assert!(
            !is_known(name),
            "{name:?} is now recognised; update docs/known-deviations.md and this list"
        );
    }
}
