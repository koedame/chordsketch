#![no_main]

use libfuzzer_sys::fuzz_target;

// Every entry point that takes untrusted ChordPro source. A crash here is a
// panic, an out-of-memory abort, or a hang (libFuzzer's per-input timeout),
// each of which lets a hostile `.cho` take down whatever embeds the parser.
fuzz_target!(|data: &[u8]| {
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    let _ = chordsketch_chordpro::parse(input);
    let _ = chordsketch_chordpro::parse_lenient(input);
    let _ = chordsketch_chordpro::parse_multi(input);
    let _ = chordsketch_chordpro::parse_multi_lenient(input);
});
