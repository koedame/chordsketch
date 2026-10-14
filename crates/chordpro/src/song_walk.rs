//! State machines shared by every renderer's line-by-line song walk.
//!
//! The text, HTML and PDF renderers each walk [`Song::lines`] top to bottom
//! and have to agree on four pieces of bookkeeping that are not about the
//! output format at all:
//!
//! - how the capo, the CLI offset and the in-file transpose (the
//!   `{+config.settings.transpose}` delta, replaced by each `{transpose}`)
//!   compose into one displayed offset ([`SongTranspose`], ADR-0023);
//! - which lines make up the most recent chorus and how many times it may
//!   be recalled ([`ChorusTracker`]);
//! - how the body of an unsupported notation block is skipped
//!   ([`NotationSkip`]);
//! - how a recalled chorus body is replayed ([`replay_chorus_body`]).
//!
//! Keeping them here means a change to any of these rules lands in one
//! place and every renderer picks it up together.

use crate::ast::{CapoValidation, CommentStyle, Directive, Line, LyricsLine, Song};
use crate::config::Config;
use crate::notation::NotationKind;
use crate::render_result::push_warning;
use crate::transpose::effective_transpose;

/// Maximum number of `{chorus}` recall directives rendered per song.
///
/// Prevents output amplification from inputs with a very large number of
/// `{chorus}` lines.
pub const MAX_CHORUS_RECALLS: usize = 1000;

/// The displayed transpose offset of a song, tracked as the walk meets
/// `{transpose}` directives.
///
/// The offset is `file + cli - capo` (ADR-0023). `file` is the in-file
/// `{+config.settings.transpose}` delta at the start of the song and the
/// latest `{transpose}` value afterwards.
#[derive(Clone, Copy, Debug)]
pub struct SongTranspose {
    cli_transpose: i8,
    song_capo: u8,
    offset: i8,
}

impl SongTranspose {
    /// Compute the offset in force at the top of `song`.
    ///
    /// An offset that does not fit in `i8` is clamped and reported through
    /// `warnings`.
    pub fn new(song: &Song, cli_transpose: i8, warnings: &mut Vec<String>) -> Self {
        let song_transpose_delta = Config::song_transpose_delta(&song.config_overrides());
        let song_capo = match song.metadata.capo_validated() {
            CapoValidation::Valid(n) => n,
            _ => 0,
        };
        let top = effective_transpose(cli_transpose, song_transpose_delta, song_capo);
        if top.saturated {
            push_warning(
                warnings,
                format!(
                    "transpose offset {cli_transpose} + {song_transpose_delta} - capo \
                     {song_capo} exceeds i8 range, clamped to {}",
                    top.offset
                ),
            );
        }
        Self {
            cli_transpose,
            song_capo,
            offset: top.offset,
        }
    }

    /// The offset to apply to chords at the current position.
    #[must_use]
    pub fn offset(&self) -> i8 {
        self.offset
    }

    /// Apply a `{transpose: N}` directive.
    ///
    /// A missing or empty value resets the in-file offset to 0; a non-empty
    /// value that cannot be parsed as `i8` is reported and treated as 0.
    pub fn apply_directive(&mut self, value: Option<&str>, warnings: &mut Vec<String>) {
        let file_offset: i8 = match value {
            None | Some("") => 0,
            Some(raw) => match raw.parse() {
                Ok(v) => v,
                Err(_) => {
                    push_warning(
                        warnings,
                        format!(
                            "{{transpose}} value {raw:?} cannot be \
                             parsed as i8, ignored (using 0)"
                        ),
                    );
                    0
                }
            },
        };
        let cli_transpose = self.cli_transpose;
        let combined = effective_transpose(file_offset, cli_transpose, self.song_capo);
        if combined.saturated {
            push_warning(
                warnings,
                format!(
                    "transpose offset {file_offset} + {cli_transpose} - capo \
                     {} exceeds i8 range, clamped to {}",
                    self.song_capo, combined.offset
                ),
            );
        }
        self.offset = combined.offset;
    }
}

/// Records the lines of the most recent `{start_of_chorus}` section and
/// meters `{chorus}` recalls against [`MAX_CHORUS_RECALLS`].
///
/// The body is stored as AST lines so a recall re-renders it with the
/// transpose offset in force at the recall, not the one at the definition.
#[derive(Debug, Default)]
pub struct ChorusTracker {
    body: Vec<Line>,
    collecting: Option<Vec<Line>>,
    recall_count: usize,
}

impl ChorusTracker {
    /// Start collecting a new chorus body (`{start_of_chorus}`).
    pub fn start(&mut self) {
        self.collecting = Some(Vec::new());
    }

    /// Finish the chorus being collected (`{end_of_chorus}`). The collected
    /// lines replace the previously stored body. Does nothing when no chorus
    /// is open.
    pub fn end(&mut self) {
        if let Some(buf) = self.collecting.take() {
            self.body = buf;
        }
    }

    /// Append `line` to the chorus being collected. Does nothing outside a
    /// chorus.
    pub fn record(&mut self, line: &Line) {
        if let Some(buf) = self.collecting.as_mut() {
            buf.push(line.clone());
        }
    }

    /// Account for one `{chorus}` recall.
    ///
    /// Returns `true` when the recall should be rendered. Once
    /// [`MAX_CHORUS_RECALLS`] recalls have been rendered the next call pushes
    /// a single warning and every call from then on returns `false`.
    pub fn try_recall(&mut self, warnings: &mut Vec<String>) -> bool {
        if self.recall_count < MAX_CHORUS_RECALLS {
            self.recall_count += 1;
            true
        } else {
            if self.recall_count == MAX_CHORUS_RECALLS {
                push_warning(
                    warnings,
                    format!(
                        "chorus recall limit ({MAX_CHORUS_RECALLS}) reached, \
                         further recalls suppressed"
                    ),
                );
                self.recall_count += 1;
            }
            false
        }
    }

    /// The lines of the most recently completed chorus.
    #[must_use]
    pub fn body(&self) -> &[Line] {
        &self.body
    }
}

/// Skips the body of a notation block (`{start_of_abc}` … `{end_of_abc}` and
/// friends) that a renderer cannot draw.
#[derive(Clone, Copy, Debug, Default)]
pub struct NotationSkip {
    open: Option<NotationKind>,
}

impl NotationSkip {
    /// Enter the notation block `kind`: push the "not supported" warning for
    /// `renderer` (e.g. `"PDF"`) and return the placeholder line to emit in
    /// place of the body. Every following line is discarded by
    /// [`consume`](Self::consume) until the matching end directive.
    pub fn begin(
        &mut self,
        kind: NotationKind,
        renderer: &str,
        warnings: &mut Vec<String>,
    ) -> String {
        let label = kind.label();
        let tag = kind.tag();
        push_warning(
            warnings,
            format!(
                "{renderer} renderer does not support {label} blocks; body of the \
                 `{{start_of_{tag}}} … {{end_of_{tag}}}` section has been \
                 omitted. Use the HTML renderer for full {label} support.",
            ),
        );
        self.open = Some(kind);
        format!("[{label} block omitted — use the HTML renderer to view it]")
    }

    /// Returns `true` when `line` is inside a skipped block and must not be
    /// rendered. The matching end directive closes the block and is itself
    /// consumed.
    pub fn consume(&mut self, line: &Line) -> bool {
        let Some(kind) = self.open else {
            return false;
        };
        if let Line::Directive(d) = line
            && kind.is_end_directive(&d.kind)
        {
            self.open = None;
        }
        true
    }
}

/// Where a recalled chorus body is drawn. The walk over the body is the
/// same for every renderer; only these four leaves differ.
pub trait ChorusReplay {
    /// A lyrics line (with or without chords).
    fn lyrics(&mut self, line: &LyricsLine);
    /// A comment line.
    fn comment(&mut self, style: CommentStyle, text: &str);
    /// A blank line.
    fn empty(&mut self);
    /// Any directive that is not metadata (metadata is shown by the header,
    /// not replayed).
    fn directive(&mut self, directive: &Directive);
}

/// Replay `body` into `sink`, skipping metadata directives.
pub fn replay_chorus_body<R: ChorusReplay>(body: &[Line], sink: &mut R) {
    for line in body {
        match line {
            Line::Lyrics(lyrics) => sink.lyrics(lyrics),
            Line::Comment(style, text) => sink.comment(*style, text),
            Line::Empty => sink.empty(),
            Line::Directive(d) if !d.kind.is_metadata() => sink.directive(d),
            Line::Directive(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    fn song(src: &str) -> Song {
        parse(src).expect("test input parses")
    }

    #[test]
    fn song_transpose_new_composes_cli_offset_and_capo_when_capo_is_set() {
        let s = song("{capo: 2}\n[C]La");
        let mut warnings = Vec::new();
        let t = SongTranspose::new(&s, 5, &mut warnings);
        assert_eq!(t.offset(), 3, "5 - capo 2");
        assert!(warnings.is_empty());
    }

    #[test]
    fn song_transpose_new_warns_and_clamps_when_the_sum_overflows_i8() {
        let s = song("{+config.settings.transpose: 100}\n[C]La");
        let mut warnings = Vec::new();
        let t = SongTranspose::new(&s, 100, &mut warnings);
        assert_eq!(t.offset(), i8::MAX);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("exceeds i8 range"), "{warnings:?}");
    }

    #[test]
    fn apply_directive_replaces_the_file_offset_and_keeps_cli_and_capo() {
        let s = song("{capo: 1}\n[C]La");
        let mut warnings = Vec::new();
        let mut t = SongTranspose::new(&s, 2, &mut warnings);
        t.apply_directive(Some("4"), &mut warnings);
        assert_eq!(t.offset(), 5, "4 + cli 2 - capo 1");
        t.apply_directive(None, &mut warnings);
        assert_eq!(t.offset(), 1, "a missing value resets the file offset to 0");
        t.apply_directive(Some(""), &mut warnings);
        assert_eq!(t.offset(), 1);
        assert!(warnings.is_empty());
    }

    #[test]
    fn apply_directive_warns_and_uses_zero_when_the_value_is_not_an_i8() {
        let s = song("[C]La");
        let mut warnings = Vec::new();
        let mut t = SongTranspose::new(&s, 3, &mut warnings);
        t.apply_directive(Some("up"), &mut warnings);
        assert_eq!(t.offset(), 3);
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("cannot be parsed as i8"),
            "{warnings:?}"
        );
    }

    #[test]
    fn apply_directive_warns_and_clamps_when_the_sum_overflows_i8() {
        let s = song("[C]La");
        let mut warnings = Vec::new();
        let mut t = SongTranspose::new(&s, 100, &mut warnings);
        t.apply_directive(Some("100"), &mut warnings);
        assert_eq!(t.offset(), i8::MAX);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn chorus_tracker_keeps_the_last_completed_chorus_as_the_body() {
        let first = Line::Empty;
        let second = Line::Comment(CommentStyle::Normal, "x".to_string());
        let mut c = ChorusTracker::default();
        c.record(&first);
        assert!(c.body().is_empty(), "lines outside a chorus are not kept");
        c.start();
        c.record(&first);
        c.end();
        assert_eq!(c.body(), std::slice::from_ref(&first));
        c.start();
        c.record(&second);
        assert_eq!(
            c.body(),
            std::slice::from_ref(&first),
            "a chorus still being collected does not replace the stored body"
        );
        c.end();
        assert_eq!(c.body(), std::slice::from_ref(&second));
    }

    #[test]
    fn chorus_tracker_end_without_start_keeps_the_stored_body() {
        let mut c = ChorusTracker::default();
        c.start();
        c.record(&Line::Empty);
        c.end();
        c.end();
        assert_eq!(c.body(), std::slice::from_ref(&Line::Empty));
    }

    #[test]
    fn try_recall_allows_the_limit_then_warns_once_and_refuses_the_rest() {
        let mut c = ChorusTracker::default();
        let mut warnings = Vec::new();
        for _ in 0..MAX_CHORUS_RECALLS {
            assert!(c.try_recall(&mut warnings));
        }
        assert!(warnings.is_empty());
        assert!(!c.try_recall(&mut warnings));
        assert!(!c.try_recall(&mut warnings));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("chorus recall limit"), "{warnings:?}");
    }

    #[test]
    fn notation_skip_discards_lines_until_the_matching_end_directive() {
        let s = song("{start_of_abc}\nX:1\n{end_of_abc}\n[C]La");
        let mut skip = NotationSkip::default();
        let mut warnings = Vec::new();
        let mut kept = 0;
        for line in &s.lines {
            if let Line::Directive(d) = line
                && let Some(kind) = NotationKind::from_start_directive(&d.kind)
            {
                let placeholder = skip.begin(kind, "Text", &mut warnings);
                assert_eq!(
                    placeholder,
                    "[ABC block omitted — use the HTML renderer to view it]"
                );
                continue;
            }
            if !skip.consume(line) {
                kept += 1;
            }
        }
        assert_eq!(kept, 1, "only the lyrics line after the block survives");
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].starts_with("Text renderer does not support ABC blocks"),
            "{warnings:?}"
        );
    }

    #[test]
    fn notation_skip_passes_every_line_through_when_no_block_is_open() {
        let mut skip = NotationSkip::default();
        assert!(!skip.consume(&Line::Empty));
    }

    #[derive(Default)]
    struct Recorder(Vec<&'static str>);

    impl ChorusReplay for Recorder {
        fn lyrics(&mut self, _: &LyricsLine) {
            self.0.push("lyrics");
        }
        fn comment(&mut self, _: CommentStyle, _: &str) {
            self.0.push("comment");
        }
        fn empty(&mut self) {
            self.0.push("empty");
        }
        fn directive(&mut self, _: &Directive) {
            self.0.push("directive");
        }
    }

    #[test]
    fn replay_chorus_body_skips_metadata_and_dispatches_every_other_line_kind() {
        let s = song("{title: T}\n[C]La\n{comment: c}\n\n{textsize: 20}");
        let mut r = Recorder::default();
        replay_chorus_body(&s.lines, &mut r);
        assert_eq!(r.0, ["lyrics", "comment", "empty", "directive"]);
    }

    #[test]
    fn apply_directive_replaces_the_config_delta_instead_of_adding_to_it() {
        let s = song("{+config.settings.transpose: 5}\n[C]La");
        let mut warnings = Vec::new();
        let mut t = SongTranspose::new(&s, 1, &mut warnings);
        assert_eq!(t.offset(), 6, "cli 1 + config delta 5");
        t.apply_directive(Some("2"), &mut warnings);
        assert_eq!(
            t.offset(),
            3,
            "{{transpose: 2}} + cli 1; the config delta is gone"
        );
    }

    #[test]
    fn chorus_tracker_start_inside_an_open_chorus_discards_the_partial_body() {
        let kept = Line::Empty;
        let dropped = Line::Comment(CommentStyle::Normal, "dropped".to_string());
        let mut c = ChorusTracker::default();
        c.start();
        c.record(&dropped);
        c.start();
        c.record(&kept);
        c.end();
        assert_eq!(c.body(), std::slice::from_ref(&kept));
    }

    #[test]
    fn notation_skip_keeps_skipping_when_another_kinds_end_directive_appears() {
        let s = song("{start_of_abc}\n{end_of_ly}\nX:1\n{end_of_abc}\n[C]La");
        let mut skip = NotationSkip::default();
        let mut warnings = Vec::new();
        let _ = skip.begin(NotationKind::Abc, "Text", &mut warnings);
        let consumed: Vec<bool> = s.lines[1..].iter().map(|l| skip.consume(l)).collect();
        assert_eq!(
            consumed,
            [true, true, true, false],
            "{{end_of_ly}} and the body are skipped, {{end_of_abc}} closes the block, the lyrics line is kept"
        );
    }
}
