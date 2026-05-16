//! AST types for an iReal Pro chart.
//!
//! Every node is a plain owned struct/enum with `Clone`, `Debug`, and
//! `PartialEq` (and `Eq` where the contained types allow). The types
//! are deliberately decoupled from any specific wire format —
//! parsing the `irealb://` URL into this AST happens in #2054,
//! serializing back happens in #2052, and either direction can
//! evolve without disturbing call sites once this scaffold is in
//! place.
//!
//! See `ARCHITECTURE.md` for the field-level design rationale.
//!
//! # Public-field mutation contract
//!
//! Every struct in this module exposes its fields as `pub`, deliberately,
//! so test fixtures and builders can mutate the AST inline. The
//! validating constructors ([`TimeSignature::new`], [`Ending::new`],
//! [`BeatPosition::on_beat`]) and the [`crate::json::FromJson`]
//! deserializer enforce the documented value ranges; **direct
//! field mutation bypasses those checks**. Downstream consumers
//! (renderer in #2057, URL writer in #2052) are expected to treat
//! ASTs constructed by anything other than a documented constructor /
//! parser as untrusted and re-validate at their own boundary, per the
//! "validate at the public boundary" rule in `defensive-inputs.md`.
//! In particular: [`TimeSignature::numerator`] / [`TimeSignature::denominator`],
//! [`IrealSong::transpose`], [`BeatPosition::subdivision`], and
//! [`ChordRoot::note`] all carry doc-comment ranges that the type system
//! does not enforce.

use std::num::NonZeroU8;

// ---------------------------------------------------------------------------
// Song (root node)
// ---------------------------------------------------------------------------

/// The root node — a single iReal Pro chart.
///
/// A chart has document-level metadata (title, composer, style, key,
/// time, tempo, transposition) plus an ordered list of [`Section`]s.
/// Multi-song iReal collections (`irealbook://...===Title2===...`)
/// are represented at a higher layer as a `Vec<IrealSong>`; this
/// struct models exactly one chart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrealSong {
    /// Title of the tune. Empty string if the chart did not declare
    /// one, mirroring the iReal Pro app's tolerance for unnamed
    /// charts. Use [`IrealSong::new`] to start from an empty default.
    pub title: String,
    /// Composer attribution (`Author` field in the iReal format).
    /// Optional because old user-submitted charts often omit it.
    pub composer: Option<String>,
    /// iReal Pro style tag — e.g. "Medium Swing", "Bossa Nova",
    /// "Ballad". Optional; the iReal app falls back to "Medium Swing"
    /// when missing, but the AST does not impose that default.
    pub style: Option<String>,
    /// Concert-pitch key the chart is written in.
    pub key_signature: KeySignature,
    /// Time signature in force at the start of the chart. Time
    /// changes inside the chart are not yet modelled — see
    /// `ARCHITECTURE.md` §"Deferred AST scope" for the rationale.
    pub time_signature: TimeSignature,
    /// Beats-per-minute tempo. Optional because many shared charts
    /// leave tempo to the player.
    pub tempo: Option<u16>,
    /// Display-time transposition in semitones, in the range
    /// `[-11, 11]`. Stored as the chart-level transpose offset; the
    /// iReal app applies this on top of `key_signature` when rendering.
    pub transpose: i8,
    /// Ordered list of sections (intro / A / B / outro / etc.).
    pub sections: Vec<Section>,
}

impl IrealSong {
    /// Creates an empty chart with a `C major` key, `4/4` time, and
    /// no metadata, sections, tempo, or transpose. Mirrors
    /// `Song::new` in `chordsketch-chordpro` so call sites can pick
    /// the same idiom.
    #[must_use]
    pub fn new() -> Self {
        Self {
            title: String::new(),
            composer: None,
            style: None,
            key_signature: KeySignature::default(),
            time_signature: TimeSignature::default(),
            tempo: None,
            transpose: 0,
            sections: Vec::new(),
        }
    }
}

impl Default for IrealSong {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/// A labelled block of bars (e.g. "A", "B", "Verse").
///
/// iReal charts use letter labels for jazz-form sections (A / B / C /
/// D); fakebook-style or non-jazz charts may use named labels like
/// "Verse" / "Chorus" / "Intro" / "Outro". Both are representable
/// via [`SectionLabel`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// The section's label. See [`SectionLabel`] for the supported
    /// shapes.
    pub label: SectionLabel,
    /// Ordered list of bars in this section.
    pub bars: Vec<Bar>,
}

impl Section {
    /// Creates a new section with the given label and an empty bar list.
    #[must_use]
    pub fn new(label: SectionLabel) -> Self {
        Self {
            label,
            bars: Vec::new(),
        }
    }
}

/// A section label.
///
/// Per the iReal Pro open-protocol spec the app emits exactly six
/// rehearsal-mark tokens: `*A`, `*B`, `*C`, `*D` (jazz-form letter
/// labels), `*i` (intro), and `*V` (verse). Letter labels are
/// modelled by [`SectionLabel::Letter`]; the two named variants
/// `Intro` and `Verse` exist so the conversion crate (#2053 /
/// #2061) can deterministically map them to ChordPro's
/// `{start_of_verse}` / verse-environment directives without each
/// site re-comparing strings. Anything outside that six-token
/// vocabulary lands in [`SectionLabel::Custom`].
///
/// Earlier revisions also carried `Chorus`, `Bridge`, and `Outro`
/// variants but those tokens are not emitted by the iReal Pro app
/// (see `.claude/rules/`-tracked issue #2450). They were removed
/// to align the type with the spec; consumers that previously held
/// `SectionLabel::Chorus` etc. now receive `Custom("Chorus")` /
/// `Custom("Bridge")` from the convert crate (`to_ireal.rs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionLabel {
    /// A single uppercase letter — the canonical jazz-form label.
    Letter(char),
    /// `Verse` — emitted by the iReal Pro app as `*V` (uppercase
    /// per the spec; the parser also accepts the lowercase `*v`
    /// for backwards-compatibility with hand-edited URLs).
    Verse,
    /// `Intro` — emitted by the iReal Pro app as `*i` (lowercase
    /// per the spec).
    Intro,
    /// Any other label. The contained string is preserved verbatim
    /// and is the canonical round-trip carrier for labels that do
    /// not fit one of the named variants.
    Custom(String),
}

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------

/// One measure inside a [`Section`].
///
/// A bar has an opening and closing barline, an ordered list of
/// chords (each anchored at a beat position), an optional ending
/// number, and an optional musical symbol attached to the bar (e.g.
/// the segno or coda mark).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bar {
    /// Opening barline. Defaults to [`BarLine::Single`] for
    /// mid-section bars.
    pub start: BarLine,
    /// Closing barline.
    pub end: BarLine,
    /// Chords in this bar, anchored to beat positions. An empty
    /// vector represents a bar that repeats the prior bar's chords
    /// — see [`BarChord`] for anchoring semantics.
    pub chords: Vec<BarChord>,
    /// `Some(NonZeroU8)` if this bar starts an N-th ending bracket.
    /// `None` if the bar is not part of an ending. The non-zero
    /// guarantee means a `1`/`2`/`3` ending always reads as a
    /// non-zero number; `Ending::is_first` style helpers live on
    /// [`Ending`] so call sites do not re-derive them.
    pub ending: Option<Ending>,
    /// Optional musical-symbol attachment (segno / coda / D.C. /
    /// D.S. / Fine). At most one symbol per bar is the iReal Pro
    /// convention; if a future format extension allows multiple
    /// symbols per bar, this becomes `Vec<MusicalSymbol>` and call
    /// sites that match on `Option` will need to update — flagged
    /// in `ARCHITECTURE.md`.
    pub symbol: Option<MusicalSymbol>,
    /// `true` when this bar is iReal Pro's "repeat previous measure"
    /// marker (URL tokens `Kcl` and `x`). The bar carries no chords
    /// of its own; the renderer paints a percent-style repeat glyph
    /// (1-bar simile, U+E500) in the bar's centre. Distinct from an
    /// empty placeholder bar.
    pub repeat_previous: bool,
    /// `true` when this bar is iReal Pro's "no chord" marker (URL
    /// token `n`). The renderer paints a literal `N.C.` glyph in
    /// place of a chord — the bar still consumes a measure of time
    /// but no chord is sounded.
    pub no_chord: bool,
    /// Free-form text comment attached to this bar (URL token
    /// `<...>` excluding the recognised musical-direction macros
    /// `D.C.` / `D.S.` / `Fine` / variants — those are stored on
    /// `symbol` instead). The renderer paints the text below the
    /// bar's right barline as an italic serif caption (e.g. "13
    /// measure lead break"). Order is preserved; multiple comments
    /// on one bar concatenate with `; ` separator.
    pub text_comment: Option<String>,
    /// Vertical-space hint (URL tokens `Y` / `YY` / `YYY` at the
    /// start of a system) preserved as an integer count in
    /// `0..=3`. `0` means "no extra space" (default); `1` / `2` /
    /// `3` ask the renderer to add proportional vertical padding
    /// above the row this bar belongs to so the engraved chart can
    /// reproduce the source's between-system spacing.
    ///
    /// The parser counts consecutive `Y` characters between bar
    /// boundaries (clamping at `3` to match the spec) and stamps
    /// the count on the next bar that begins. Whether that bar
    /// actually lands at a row start is a render-time concern; the
    /// AST records the hint verbatim so the source `Y+` token
    /// round-trips through serialise → parse without loss.
    pub system_break_space: u8,
}

impl Bar {
    /// Creates a new bar with single barlines on both sides and no
    /// chords / ending / symbol. The most common starting point.
    #[must_use]
    pub fn new() -> Self {
        Self {
            start: BarLine::Single,
            end: BarLine::Single,
            chords: Vec::new(),
            ending: None,
            symbol: None,
            repeat_previous: false,
            no_chord: false,
            text_comment: None,
            system_break_space: 0,
        }
    }
}

impl Default for Bar {
    fn default() -> Self {
        Self::new()
    }
}

/// Barline shape at a bar boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarLine {
    /// Single barline `|`.
    Single,
    /// Double barline `||` — used between sections.
    Double,
    /// Final barline `|||` — only at the end of a chart.
    Final,
    /// Open-repeat `|:` — start of a repeat block.
    OpenRepeat,
    /// Close-repeat `:|` — end of a repeat block.
    CloseRepeat,
}

/// Ending bracket number (1, 2, 3 …). Stored as [`NonZeroU8`] so the
/// `Option<Ending>` discriminant cannot drift into "ending zero" via
/// `Default`. Call sites read the number with [`Ending::number`];
/// equality is structural.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ending(NonZeroU8);

impl Ending {
    /// Creates an ending with the given number. Returns `None` if
    /// `n == 0` since "ending zero" is not a meaningful concept in
    /// the iReal format.
    #[must_use]
    pub const fn new(n: u8) -> Option<Self> {
        match NonZeroU8::new(n) {
            Some(nz) => Some(Self(nz)),
            None => None,
        }
    }

    /// Returns the ending number as a plain `u8`.
    #[must_use]
    pub const fn number(self) -> u8 {
        self.0.get()
    }
}

/// A chord placed at a beat inside a bar.
///
/// iReal's bar grid divides the bar into beat slots (one per
/// numerator beat); a chord can sit on any beat. [`BeatPosition`]
/// carries the slot index plus an optional sub-beat fraction for
/// charts that mark "and-of-2" or similar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarChord {
    /// The chord at this position.
    pub chord: Chord,
    /// Where in the bar the chord lands.
    pub position: BeatPosition,
    /// Display size for this chord.
    ///
    /// iReal Pro's [Custom Chord Chart Protocol](https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol)
    /// lets an author insert a lowercase `s` in the chord
    /// progression to make subsequent chords narrower (useful when
    /// packing many chords into one measure); a lowercase `l`
    /// restores the default size. The parser tracks the active
    /// "current size" across bars and stamps it on each emitted
    /// chord, so the renderer can paint Small chords at a reduced
    /// font / width without losing per-chord granularity.
    pub size: ChordSize,
}

/// Per-chord display size, controlled by the iReal Pro `s` / `l`
/// markers.
///
/// The marker semantics are stateful: an `s` in the chord stream
/// switches all subsequent chords to [`ChordSize::Small`], and an
/// `l` switches back to [`ChordSize::Default`]. The state persists
/// across bar boundaries until the next marker, matching the spec's
/// "all the following chord symbols will be narrower until an `l`
/// symbol is encountered" wording.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ChordSize {
    /// Normal-sized chord. The renderer uses
    /// [`crate`]-level chord font-size constants unmodified.
    #[default]
    Default,
    /// Narrower chord. The renderer scales chord glyphs down so
    /// dense bars (multiple chords per measure) stay legible.
    Small,
}

/// Position inside a bar, expressed as `beat` (1-indexed, 1 ..= the
/// time-signature numerator) and an optional `subdivision` integer
/// in the unit `2 ^ subdivision` of a beat. `subdivision == 0`
/// (default) means "on the beat"; `subdivision == 1` means "the
/// half-beat after"; etc. Practical values are 0..=3 (down to
/// 32nd-note resolution); larger values are not produced by any
/// known iReal Pro source format and are reserved for future grid-
/// resolution increases. The discrete-integer layout keeps
/// equality byte-stable for golden tests, which a `f32` would not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BeatPosition {
    /// 1-indexed beat number inside the bar.
    pub beat: NonZeroU8,
    /// Sub-beat offset; `0` means "on the beat".
    pub subdivision: u8,
}

impl BeatPosition {
    /// Creates a position on beat `beat` (1-indexed) with no
    /// subdivision. Returns `None` if `beat == 0`.
    #[must_use]
    pub const fn on_beat(beat: u8) -> Option<Self> {
        match NonZeroU8::new(beat) {
            Some(nz) => Some(Self {
                beat: nz,
                subdivision: 0,
            }),
            None => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Chord
// ---------------------------------------------------------------------------

/// A chord: root, quality, and optional bass note (slash chord).
///
/// Slash chords are represented with the bass distinct from the
/// root — `C/G` is `Chord { root: C, quality: Major, bass: Some(G) }`.
/// `bass.is_none()` means "no slash". Equality is by all three
/// fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    /// Root note of the chord.
    pub root: ChordRoot,
    /// Chord quality.
    pub quality: ChordQuality,
    /// Slash-chord bass note. `None` if the chord has no slash.
    pub bass: Option<ChordRoot>,
    /// Optional alternate chord (URL `(altchord)` next to the
    /// primary). Renders as a smaller chord stacked above the
    /// primary, mirroring iReal Pro's convention.
    pub alternate: Option<Box<Chord>>,
}

impl Chord {
    /// Creates a triad with no slash. The most common starting
    /// point for AST construction in tests.
    #[must_use]
    pub fn triad(root: ChordRoot, quality: ChordQuality) -> Self {
        Self {
            root,
            quality,
            bass: None,
            alternate: None,
        }
    }
}

/// A root or bass note: pitch class + accidental.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChordRoot {
    /// The diatonic letter (`A` … `G`). Stored as the uppercase
    /// ASCII letter so the value is a structural enum-like key
    /// without the round-trip cost of a real `enum`. The
    /// [`crate::json::FromJson`] deserializer enforces the
    /// `A..=G` range; direct field assignment does not.
    pub note: char,
    /// Accidental on the root.
    pub accidental: Accidental,
}

impl ChordRoot {
    /// Creates a root with a natural accidental.
    ///
    /// `note` is expected to be an uppercase ASCII letter in `'A'..='G'`.
    /// No validation is performed here — enforcing valid note letters is
    /// the responsibility of the iReal URL parser (#2054), which is the
    /// public-API entry point.
    #[must_use]
    pub const fn natural(note: char) -> Self {
        Self {
            note,
            accidental: Accidental::Natural,
        }
    }
}

/// Accidental on a note: natural, flat, sharp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accidental {
    /// Natural — the unaltered diatonic letter.
    Natural,
    /// Flat (♭).
    Flat,
    /// Sharp (♯).
    Sharp,
}

/// Chord quality (triad + extension).
///
/// The named variants cover the qualities iReal Pro renders as a
/// distinct symbol; everything else (slash, suspended, altered,
/// polychord, etc.) falls into [`ChordQuality::Custom`]. The
/// `Custom` variant is intentional: keeping the named set narrow
/// avoids the AST having to track every notation variant the iReal
/// format permits, and lets the rendering crate (#2057) decide on
/// glyph mapping without an enum-bloat refactor here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChordQuality {
    /// Major triad (e.g. `C`).
    Major,
    /// Minor triad (e.g. `Cm`).
    Minor,
    /// Diminished triad (e.g. `Cdim` / `Co`).
    Diminished,
    /// Augmented triad (e.g. `Caug` / `C+`).
    Augmented,
    /// Major 7th (e.g. `Cmaj7` / `CM7` / `CΔ`).
    Major7,
    /// Minor 7th (e.g. `Cm7`).
    Minor7,
    /// Dominant 7th (e.g. `C7`).
    Dominant7,
    /// Half-diminished 7th (e.g. `Cm7♭5` / `Cø`).
    HalfDiminished,
    /// Fully diminished 7th (e.g. `Cdim7` / `C°7`).
    Diminished7,
    /// Suspended 2nd (e.g. `Csus2`).
    Suspended2,
    /// Suspended 4th (e.g. `Csus4`).
    Suspended4,
    /// Anything else, preserved verbatim from the source.
    /// Examples: `C7♯9`, `C13♭9♯11`, `C/G/E` polychord. The string
    /// is the post-root quality token (i.e. without the root letter
    /// or accidental), so `C7♯9` stores `"7♯9"` here.
    Custom(String),
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/// Time signature `numerator / denominator`.
///
/// `numerator` is in `1 ..= 12` for representable iReal time
/// signatures (the iReal app accepts up to 12/x), and `denominator`
/// is one of 2, 4, or 8. This range is enforced at construction by
/// [`TimeSignature::new`]; the public fields are still settable so
/// callers building ASTs in tests can intentionally exercise edge
/// cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeSignature {
    /// Beats per bar.
    pub numerator: u8,
    /// Beat unit (typically 2, 4, or 8).
    pub denominator: u8,
}

impl TimeSignature {
    /// Creates a time signature, returning `None` if `numerator` is
    /// outside `1 ..= 12` or `denominator` is not one of 2, 4, 8.
    /// The numerator cap matches iReal Pro's own UI; the denominator
    /// allow-list excludes `1/x` (uncommon) and `x/16` (not
    /// representable in the iReal grid).
    #[must_use]
    pub const fn new(numerator: u8, denominator: u8) -> Option<Self> {
        if numerator == 0 || numerator > 12 {
            return None;
        }
        match denominator {
            2 | 4 | 8 => Some(Self {
                numerator,
                denominator,
            }),
            _ => None,
        }
    }
}

impl Default for TimeSignature {
    fn default() -> Self {
        // 4/4 is iReal Pro's implicit default when a chart omits a
        // time signature. `unwrap()` is safe because (4, 4) is
        // always inside the allowed range.
        Self::new(4, 4).expect("4/4 is a valid TimeSignature")
    }
}

/// Key signature: tonic + mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySignature {
    /// Tonic of the key.
    pub root: ChordRoot,
    /// Major / minor.
    pub mode: KeyMode,
}

impl Default for KeySignature {
    fn default() -> Self {
        // C major matches iReal Pro's implicit default.
        Self {
            root: ChordRoot::natural('C'),
            mode: KeyMode::Major,
        }
    }
}

/// Key mode: major / minor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMode {
    /// Major mode.
    Major,
    /// Minor mode.
    Minor,
}

// ---------------------------------------------------------------------------
// Musical symbols
// ---------------------------------------------------------------------------

/// A repeat / navigation symbol attached to a bar.
///
/// iReal Pro renders these as Bravura-font glyphs (#2062). The
/// AST keeps them as plain enum variants so the rendering crate
/// owns the glyph mapping and the conversion crate (#2053) can
/// decide which ChordPro directive each symbol maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MusicalSymbol {
    /// Segno mark (𝄋).
    Segno,
    /// Coda mark (𝄌).
    Coda,
    /// "Da Capo" jump-to-start instruction.
    DaCapo,
    /// "Dal Segno" jump-to-segno instruction.
    DalSegno,
    /// "Fine" — terminal marker for a `D.C. al fine` / `D.S. al fine`.
    Fine,
    /// Fermata mark (𝄐) — hold the marked bar longer than notated.
    /// Spec token: lowercase `f` in the Rehearsal Marks table at
    /// <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>.
    Fermata,
}
