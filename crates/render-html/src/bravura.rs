//! Bravura SMuFL glyph outlines for the HTML `{key}` chip, baked as
//! inline SVG `<path>` data.
//!
//! These are real font outlines (treble clef, sharp, flat), not the
//! simplified caricatures the key-signature glyph used previously — the
//! caricature clef read as a distorted squiggle at chip size. The
//! path-baked-not-font approach is the one [ADR-0014] established for the
//! iReal renderer: ship the outlines as `<path d="…">` so no ~500 KB music
//! font has to be loaded, yet the glyph is a true SMuFL shape.
//!
//! Sister sites (keep in lockstep — `.claude/rules/fix-propagation.md`):
//!   - `packages/react/src/bravura-glyphs.ts` — same gClef / sharp / flat for
//!     the React `<KeySignatureGlyph>` (renderer-parity with this crate's
//!     HTML output).
//!   - `crates/render-ireal/src/bravura.rs` — segno / coda / fermata.
//!
//! The path strings are in **font units** (OpenType convention: +X right,
//! +Y up, origin at the glyph's SMuFL reference point). Regenerate via:
//!
//! ```text
//! python3 scripts/extract-bravura-paths.py --target html
//! ```
//!
//! Attribution: the outlines are derivative works of the Bravura font,
//! redistributed under SIL OFL-1.1 — see the project-root `NOTICE`,
//! `crates/render-html/LICENSE-OFL.txt`, and ADR-0014.
//!
//! [ADR-0014]: ../../../docs/adr/0014-bravura-glyphs-as-svg-paths.md

use std::fmt::Write;

/// Font units per staff space (SMuFL: one staff space = 0.25 em at UPEM 1000).
pub(crate) const STAFF_SPACE_FONT_UNITS: f32 = 250.0;

/// A baked Bravura glyph: its advance width and SVG path, in font units
/// (OpenType convention: +X right, +Y up, origin at the glyph's SMuFL
/// reference point). The HTML key-signature glyph needs only the advance (to
/// center an accidental) and the path; the TS sister-site additionally
/// carries the bounding box for dynamic-bounds layout.
pub(crate) struct BravuraGlyph {
    /// Advance width in font units.
    pub advance: f32,
    /// SVG path data in font space (`fill`, never `stroke`).
    pub d: &'static str,
}

// ---- generated: extract-bravura-paths.py --target html --------------------
// upem = 1000
// pinned commit = 02e8ed29a29115df35007d1178cebaeee26c20e1

// GCLEF (U+E050)
pub(crate) const GCLEF: BravuraGlyph = BravuraGlyph {
    advance: 671.0,
    d: "M376 415C374 427 376 428 382 434C490 535 572 662 572 815C572 902 548 988 507 1048C492 1070 466 1098 455 1098C441 1098 410 1072 390 1050C316 968 292 843 292 739C292 681 299 616 306 575C308 563 309 561 297 551C153 432 0 289 0 87C0 -87 119 -252 364 -252C387 -252 413 -250 433 -246C444 -244 446 -243 448 -255C460 -322 475 -409 475 -456C475 -604 375 -622 316 -622C262 -622 236 -606 236 -593C236 -586 245 -583 268 -576C299 -567 335 -540 335 -482C335 -427 300 -380 239 -380C172 -380 132 -433 132 -495C132 -560 171 -658 322 -658C389 -658 519 -628 519 -458C519 -401 501 -306 490 -244C488 -232 489 -233 503 -227C604 -187 671 -102 671 11C671 139 577 252 430 252C404 252 404 252 401 270ZM470 943C503 943 530 916 530 861C530 750 435 660 356 591C349 585 345 586 343 599C339 625 337 659 337 691C337 847 409 943 470 943ZM361 262C364 243 364 244 346 238C258 208 201 129 201 44C201 -46 248 -110 316 -133C324 -136 336 -139 343 -139C351 -139 355 -134 355 -128C355 -121 347 -118 340 -115C298 -97 268 -54 268 -8C268 49 307 92 368 109C384 113 386 112 388 101L438 -197C440 -208 439 -208 424 -211C408 -214 388 -216 368 -216C193 -216 80 -119 80 20C80 79 90 158 173 252C233 319 279 356 326 394C336 402 338 401 340 390ZM430 103C428 115 429 118 441 117C522 110 589 42 589 -46C589 -109 551 -160 495 -188C483 -194 481 -194 479 -182Z",
};

// ACCIDENTAL_SHARP (U+E262)
pub(crate) const ACCIDENTAL_SHARP: BravuraGlyph = BravuraGlyph {
    advance: 249.0,
    d: "M237 118C244 121 249 129 249 135V206C249 211 246 214 242 214C240 214 239 214 237 213C237 213 217 205 212 204C205 204 198 209 198 217V339C198 345 192 350 184 350C174 350 168 345 168 339V209C167 199 164 186 155 180C143 173 109 159 92 155C83 155 80 167 80 175V295C80 301 73 306 66 306C56 306 50 301 50 295V160C50 146 44 136 38 133C32 130 12 122 12 122C5 120 0 112 0 106V35C0 29 3 26 9 26L11 27C12 27 27 33 35 37L36 38C44 38 50 28 50 20V-79C50 -90 45 -99 39 -102C33 -104 12 -113 12 -113C5 -115 0 -123 0 -129V-200C0 -206 3 -209 9 -209L11 -208C12 -208 26 -202 35 -199C36 -198 37 -198 38 -198C45 -198 50 -209 50 -214V-337C50 -343 56 -348 63 -348C73 -348 80 -343 80 -337V-198C80 -185 85 -178 90 -176L151 -151C151 -151 152 -151 152 -151L154 -150C163 -150 168 -162 168 -168V-293C168 -299 174 -304 181 -304C192 -304 198 -299 198 -293V-151C198 -143 202 -131 209 -128C216 -125 237 -117 237 -117C244 -114 249 -106 249 -100V-29C249 -24 246 -21 242 -21C240 -21 239 -21 237 -22L211 -32C205 -32 198 -26 198 -14V79C198 86 203 105 211 108ZM168 -45C162 -65 115 -85 92 -85C86 -85 81 -83 80 -80C78 -76 77 -54 77 -30C77 1 78 36 80 44C82 61 128 82 153 82C160 82 166 80 168 76C170 71 172 46 172 19C172 -8 170 -36 168 -45Z",
};

// ACCIDENTAL_FLAT (U+E260)
pub(crate) const ACCIDENTAL_FLAT: BravuraGlyph = BravuraGlyph {
    advance: 226.0,
    d: "M12 -170C15 -174 18 -175 21 -175C24 -175 27 -173 27 -173C57 -156 81 -129 106 -112C195 -50 226 11 226 57C226 114 182 150 136 153C119 153 95 145 81 136C75 131 64 122 59 122C57 122 56 122 54 123C47 126 43 133 43 140C44 162 50 402 50 422C50 433 41 439 31 439C17 439 1 429 0 411C0 411 4 -160 12 -170ZM47 -81C47 -81 44 -21 44 19C44 35 45 47 46 51C53 71 93 100 116 100C145 100 157 67 157 42C157 -12 111 -66 68 -93C64 -95 61 -96 58 -96C49 -96 47 -86 47 -81Z",
};

// ---- end generated --------------------------------------------------------

/// Format a transform coordinate compactly (no trailing zeros), matching the
/// TypeScript sister-site's `fmt` (`packages/react/src/bravura-glyphs.ts`) so
/// the HTML and React key-signature glyphs emit identical `transform` strings
/// (renderer-parity). Both round to four decimals; the rounding *mode* differs
/// in principle (Rust `{:.4}` is half-to-even, JS `toFixed` is half-away-from-
/// zero) but the inputs — `staff_space / 250` scaled by small integers and
/// half-integers — never produce a 5th-decimal tie, so the two agree
/// byte-for-byte on every glyph placed here.
fn fmt(n: f32) -> String {
    let mut s = format!("{n:.4}");
    if s.contains('.') {
        let trimmed = s.trim_end_matches('0').trim_end_matches('.');
        s = trimmed.to_string();
    }
    // Normalise "-0" to "0".
    if s == "-0" { "0".to_string() } else { s }
}

/// SVG `transform` mapping a font-space anchor point onto a target user-space
/// point: scales so `staff_space` user units span one SMuFL staff space and
/// flips the Y axis (font +Y up → SVG +Y down).
///
/// `(font_ax, font_ay)` is the glyph point that should land exactly at
/// `(target_x, target_y)` — e.g. `(0, 0)` for the gClef's G-line origin, or
/// `(glyph.cx, 0)` to center a notehead.
///
/// The parity-relevant sister is `smuflTransform` in
/// `packages/react/src/bravura-glyphs.ts` (same algorithm, same output).
/// `crates/render-ireal/src/music_symbols.rs` composes an analogous but
/// distinct transform (bbox-center anchoring for segno / coda / fermata); it
/// is intentionally *not* shared — `render-html` depends only on
/// `chordsketch-chordpro`, not on `render-ireal`, and the two cover different
/// glyph-placement needs. Only the glyph *data* (`bravura.rs` / the `.ts`
/// sister) is regenerated from one script and kept in lockstep.
pub(crate) fn smufl_transform(
    staff_space: f32,
    font_ax: f32,
    font_ay: f32,
    target_x: f32,
    target_y: f32,
) -> String {
    let s = staff_space / STAFF_SPACE_FONT_UNITS;
    let tx = target_x - s * font_ax;
    let ty = target_y + s * font_ay;
    let mut out = String::with_capacity(48);
    let _ = write!(
        out,
        "translate({} {}) scale({} {})",
        fmt(tx),
        fmt(ty),
        fmt(s),
        fmt(-s),
    );
    out
}
