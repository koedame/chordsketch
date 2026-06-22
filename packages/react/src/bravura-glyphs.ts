/**
 * Real Bravura SMuFL glyph outlines, baked as inline SVG `<path>` data.
 *
 * These are the actual font outlines (treble clef, sharp, flat, black
 * notehead), not the simplified caricatures the key-signature chip and
 * chord-tone staff used before. The same path-baked-not-font approach the
 * iReal renderer adopted in [ADR-0014] is reused here: the glyphs ship as
 * `<path d="…">` data so `@chordsketch/react` never forces a ~500 KB music
 * font download on consumers, yet still draws true SMuFL shapes.
 *
 * Sister sites (keep in lockstep — `.claude/rules/fix-propagation.md`):
 *   - `crates/render-html/src/bravura.rs` — same gClef / sharp / flat for the
 *     HTML `{key}` chip (renderer-parity with `KeySignatureGlyph`).
 *   - `crates/render-ireal/src/bravura.rs` — segno / coda / fermata.
 *
 * Regenerate the constants below (font units, OpenType +Y-up convention) with:
 *
 *     python3 scripts/extract-bravura-paths.py --target react
 *
 * [ADR-0014]: docs/adr/0014-bravura-glyphs-as-svg-paths.md
 */

/** A baked Bravura glyph in font units (OpenType convention: +X right, +Y up,
 * origin at the glyph's SMuFL reference point). */
export interface BravuraGlyph {
  /** Advance width in font units. */
  advance: number;
  /** Outline bounding box in font units. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Bounding-box horizontal center in font units. */
  cx: number;
  /** Bounding-box vertical center in font units. */
  cy: number;
  /** SVG path data in font space (`fill`, never `stroke`). */
  d: string;
}

/** Font units per staff space (SMuFL: one staff space = 0.25 em at UPEM 1000). */
export const STAFF_SPACE_FONT_UNITS = 250;

// ---- generated: extract-bravura-paths.py --target react -------------------
// Re-emit into packages/react/src/bravura-glyphs.ts
// upem = 1000
// pinned commit = 02e8ed29a29115df35007d1178cebaeee26c20e1

// GCLEF (U+E050) — origin y=0 sits on the G (second-from-bottom) staff line.
export const GCLEF: BravuraGlyph = {
  advance: 671,
  bbox: { minX: 0, minY: -658, maxX: 671, maxY: 1098 },
  cx: 335.5,
  cy: 220,
  d: 'M376 415C374 427 376 428 382 434C490 535 572 662 572 815C572 902 548 988 507 1048C492 1070 466 1098 455 1098C441 1098 410 1072 390 1050C316 968 292 843 292 739C292 681 299 616 306 575C308 563 309 561 297 551C153 432 0 289 0 87C0 -87 119 -252 364 -252C387 -252 413 -250 433 -246C444 -244 446 -243 448 -255C460 -322 475 -409 475 -456C475 -604 375 -622 316 -622C262 -622 236 -606 236 -593C236 -586 245 -583 268 -576C299 -567 335 -540 335 -482C335 -427 300 -380 239 -380C172 -380 132 -433 132 -495C132 -560 171 -658 322 -658C389 -658 519 -628 519 -458C519 -401 501 -306 490 -244C488 -232 489 -233 503 -227C604 -187 671 -102 671 11C671 139 577 252 430 252C404 252 404 252 401 270ZM470 943C503 943 530 916 530 861C530 750 435 660 356 591C349 585 345 586 343 599C339 625 337 659 337 691C337 847 409 943 470 943ZM361 262C364 243 364 244 346 238C258 208 201 129 201 44C201 -46 248 -110 316 -133C324 -136 336 -139 343 -139C351 -139 355 -134 355 -128C355 -121 347 -118 340 -115C298 -97 268 -54 268 -8C268 49 307 92 368 109C384 113 386 112 388 101L438 -197C440 -208 439 -208 424 -211C408 -214 388 -216 368 -216C193 -216 80 -119 80 20C80 79 90 158 173 252C233 319 279 356 326 394C336 402 338 401 340 390ZM430 103C428 115 429 118 441 117C522 110 589 42 589 -46C589 -109 551 -160 495 -188C483 -194 481 -194 479 -182Z',
};

// ACCIDENTAL_SHARP (U+E262) — origin y=0 at the center of the altered pitch.
export const ACCIDENTAL_SHARP: BravuraGlyph = {
  advance: 249,
  bbox: { minX: 0, minY: -348, maxX: 249, maxY: 350 },
  cx: 124.5,
  cy: 1,
  d: 'M237 118C244 121 249 129 249 135V206C249 211 246 214 242 214C240 214 239 214 237 213C237 213 217 205 212 204C205 204 198 209 198 217V339C198 345 192 350 184 350C174 350 168 345 168 339V209C167 199 164 186 155 180C143 173 109 159 92 155C83 155 80 167 80 175V295C80 301 73 306 66 306C56 306 50 301 50 295V160C50 146 44 136 38 133C32 130 12 122 12 122C5 120 0 112 0 106V35C0 29 3 26 9 26L11 27C12 27 27 33 35 37L36 38C44 38 50 28 50 20V-79C50 -90 45 -99 39 -102C33 -104 12 -113 12 -113C5 -115 0 -123 0 -129V-200C0 -206 3 -209 9 -209L11 -208C12 -208 26 -202 35 -199C36 -198 37 -198 38 -198C45 -198 50 -209 50 -214V-337C50 -343 56 -348 63 -348C73 -348 80 -343 80 -337V-198C80 -185 85 -178 90 -176L151 -151C151 -151 152 -151 152 -151L154 -150C163 -150 168 -162 168 -168V-293C168 -299 174 -304 181 -304C192 -304 198 -299 198 -293V-151C198 -143 202 -131 209 -128C216 -125 237 -117 237 -117C244 -114 249 -106 249 -100V-29C249 -24 246 -21 242 -21C240 -21 239 -21 237 -22L211 -32C205 -32 198 -26 198 -14V79C198 86 203 105 211 108ZM168 -45C162 -65 115 -85 92 -85C86 -85 81 -83 80 -80C78 -76 77 -54 77 -30C77 1 78 36 80 44C82 61 128 82 153 82C160 82 166 80 168 76C170 71 172 46 172 19C172 -8 170 -36 168 -45Z',
};

// ACCIDENTAL_FLAT (U+E260) — origin y=0 at the center of the altered pitch.
export const ACCIDENTAL_FLAT: BravuraGlyph = {
  advance: 226,
  bbox: { minX: 0, minY: -175, maxX: 226, maxY: 439 },
  cx: 113,
  cy: 132,
  d: 'M12 -170C15 -174 18 -175 21 -175C24 -175 27 -173 27 -173C57 -156 81 -129 106 -112C195 -50 226 11 226 57C226 114 182 150 136 153C119 153 95 145 81 136C75 131 64 122 59 122C57 122 56 122 54 123C47 126 43 133 43 140C44 162 50 402 50 422C50 433 41 439 31 439C17 439 1 429 0 411C0 411 4 -160 12 -170ZM47 -81C47 -81 44 -21 44 19C44 35 45 47 46 51C53 71 93 100 116 100C145 100 157 67 157 42C157 -12 111 -66 68 -93C64 -95 61 -96 58 -96C49 -96 47 -86 47 -81Z',
};

// ACCIDENTAL_NATURAL (U+E261) — origin y=0 at the center of the altered pitch.
export const ACCIDENTAL_NATURAL: BravuraGlyph = {
  advance: 168,
  bbox: { minX: 0, minY: -335, maxX: 168, maxY: 341 },
  cx: 84,
  cy: 3,
  d: 'M141 181C139 181 138 180 137 180C137 180 73 157 47 157C41 157 37 158 37 162V329C37 336 31 341 25 341H12C5 341 0 336 0 329V-186C0 -192 3 -195 9 -195L11 -194C12 -194 14 -194 15 -193C29 -187 85 -163 114 -163C124 -163 131 -166 131 -174V-323C131 -330 136 -335 143 -335H156C162 -335 168 -330 168 -323V179C168 184 164 187 160 187C159 187 157 187 156 186ZM37 39C37 53 98 79 122 79C128 79 131 78 131 74V-29C131 -47 74 -70 49 -70C42 -70 37 -68 37 -64Z',
};

// NOTEHEAD_BLACK (U+E0A4) — origin y=0 at the notehead's vertical center.
export const NOTEHEAD_BLACK: BravuraGlyph = {
  advance: 295,
  bbox: { minX: 0, minY: -125, maxX: 295, maxY: 125 },
  cx: 147.5,
  cy: 0,
  d: 'M97 -125C186 -125 295 -43 295 42C295 93 255 125 198 125C88 125 0 44 0 -42C0 -94 43 -125 97 -125Z',
};

// ---- end generated --------------------------------------------------------

/**
 * Round to a compact decimal string (no spurious trailing zeros).
 *
 * Sister-site to `fmt` in `crates/render-html/src/bravura.rs`; both round to
 * four decimals so the React and HTML key-signature glyphs emit identical
 * `transform` strings (renderer-parity). The rounding *mode* differs in
 * principle — JS `toFixed` rounds halves away from zero, Rust `{:.4}` rounds
 * half-to-even — but the transform inputs here are `staffSpace / 250` scaled
 * by small integers and half-integers, which never land on a 5th-decimal tie,
 * so the two helpers agree byte-for-byte on every glyph this module places.
 */
function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/**
 * SVG `transform` mapping a font-space anchor point onto a target user-space
 * point: scales so `staffSpace` user units span one SMuFL staff space and
 * flips the Y axis (font +Y up → SVG +Y down).
 *
 * `fontAnchor` is the glyph point (in font units) that should land exactly at
 * `(targetX, targetY)` — e.g. `(0, 0)` for the gClef (its G-line origin), or
 * `(glyph.cx, 0)` to center a notehead on a target point.
 */
export function smuflTransform(opts: {
  staffSpace: number;
  fontAnchorX: number;
  fontAnchorY: number;
  targetX: number;
  targetY: number;
}): string {
  const s = opts.staffSpace / STAFF_SPACE_FONT_UNITS;
  const tx = opts.targetX - s * opts.fontAnchorX;
  const ty = opts.targetY + s * opts.fontAnchorY;
  return `translate(${fmt(tx)} ${fmt(ty)}) scale(${fmt(s)} ${fmt(-s)})`;
}
