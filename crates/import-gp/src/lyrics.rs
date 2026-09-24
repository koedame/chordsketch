//! Splits Guitar Pro lyric text into per-beat syllables.
//!
//! Guitar Pro lays lyrics over a track's beats one syllable per sounding
//! beat. The text syntax, as the alphaTab reference reader interprets it:
//!
//! - whitespace (space, tab, line break) separates syllables;
//! - a hyphen ends a syllable that continues into the next one (`A- ma-
//!   zing`), and spaces after it are not an extra separator;
//! - a second space in a row leaves one beat without a syllable;
//! - `+` joins words onto a single beat (`Guide+me` sings "Guide me" on one
//!   note);
//! - `[...]` is a comment and is dropped, along with the whitespace after
//!   it (alphaTab turns that whitespace into an empty beat);
//! - trailing underscores mark a held syllable and are dropped (`night__`).
//!
//! On top of that, the importer remembers which syllables start a new text
//! line, so the ChordPro output can break its lines where the lyricist did.

/// One syllable to place on a beat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Syllable {
    /// The text to print, with `+` turned into spaces and trailing
    /// underscores removed. Keeps a trailing `-` when the word continues.
    /// Empty for a beat that is skipped on purpose.
    pub text: String,
    /// The syllable is the first one after a line break in the source text.
    pub starts_line: bool,
}

impl Syllable {
    /// True when the next syllable continues the same word.
    pub(crate) fn continues_word(&self) -> bool {
        self.text.ends_with('-')
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// Between syllables, skipping separators.
    IgnoreSpaces,
    /// At the start of a syllable or comment.
    Begin,
    /// Inside a syllable.
    Text,
    /// Inside a `[...]` comment.
    Comment,
    /// After a hyphen that ends a syllable.
    Dash,
}

/// Splits `text` into syllables, one per sounding beat.
pub(crate) fn syllables(text: &str) -> Vec<Syllable> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut state = State::Begin;
    let mut skip_space = false;
    let mut start = 0;
    // A line break was seen since the last syllable was emitted.
    let mut pending_line_break = false;
    let mut first = true;
    let mut i = 0;

    let mut push = |chars: &[char], pending: &mut bool, first: &mut bool| {
        out.push(Syllable {
            text: prepare(chars),
            starts_line: *pending && !*first,
        });
        *pending = false;
        *first = false;
    };

    while i < chars.len() {
        let c = chars[i];
        match state {
            State::IgnoreSpaces => match c {
                '\n' | '\r' => pending_line_break = true,
                '\t' => {}
                ' ' => {
                    if !skip_space {
                        state = State::Begin;
                        continue;
                    }
                }
                _ => {
                    skip_space = false;
                    state = State::Begin;
                    continue;
                }
            },
            State::Begin => {
                if c == '[' {
                    state = State::Comment;
                } else {
                    start = i;
                    state = State::Text;
                    continue;
                }
            }
            State::Comment => {
                if c == ']' {
                    // Unlike alphaTab, whitespace after a comment is not a
                    // separator: "[Verse] Lan-" starts on the first note.
                    skip_space = true;
                    state = State::IgnoreSpaces;
                }
            }
            State::Text => match c {
                '-' => state = State::Dash,
                '\n' | '\r' | ' ' => {
                    push(&chars[start..i], &mut pending_line_break, &mut first);
                    if c != ' ' {
                        pending_line_break = true;
                    }
                    state = State::IgnoreSpaces;
                }
                _ => {}
            },
            State::Dash => {
                if c != '-' {
                    push(&chars[start..i], &mut pending_line_break, &mut first);
                    skip_space = true;
                    state = State::IgnoreSpaces;
                    continue;
                }
            }
        }
        i += 1;
    }
    if matches!(state, State::Text | State::Dash) && start < chars.len() {
        push(&chars[start..], &mut pending_line_break, &mut first);
    }
    out
}

/// Turns raw syllable characters into the text to print.
fn prepare(chars: &[char]) -> String {
    let joined: String = chars
        .iter()
        .map(|&c| if c == '+' { ' ' } else { c })
        .collect();
    joined.trim_end_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(input: &str) -> Vec<String> {
        syllables(input).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn when_words_are_separated_by_spaces_each_word_is_one_syllable() {
        assert_eq!(
            texts("how sweet the sound"),
            ["how", "sweet", "the", "sound"]
        );
    }

    #[test]
    fn when_a_word_is_hyphenated_the_hyphen_stays_on_the_first_part() {
        assert_eq!(texts("A- ma- zing grace"), ["A-", "ma-", "zing", "grace"]);
        assert_eq!(texts("A-ma-zing"), ["A-", "ma-", "zing"]);
    }

    #[test]
    fn when_two_spaces_follow_a_word_one_beat_is_left_empty() {
        assert_eq!(texts("la  la"), ["la", "", "la"]);
    }

    #[test]
    fn when_a_plus_joins_words_they_share_one_beat() {
        assert_eq!(texts("Guide+me home"), ["Guide me", "home"]);
    }

    #[test]
    fn when_the_text_has_a_bracketed_comment_it_is_dropped() {
        assert_eq!(texts("[verse] Lan- terns"), ["Lan-", "terns"]);
    }

    #[test]
    fn when_a_syllable_has_trailing_underscores_they_are_dropped() {
        assert_eq!(texts("to- night__"), ["to-", "night"]);
    }

    #[test]
    fn when_the_text_has_line_breaks_the_first_syllable_of_each_line_is_marked() {
        let out = syllables("one two\nthree\r\nfour");
        let starts: Vec<(&str, bool)> = out
            .iter()
            .map(|s| (s.text.as_str(), s.starts_line))
            .collect();
        assert_eq!(
            starts,
            [
                ("one", false),
                ("two", false),
                ("three", true),
                ("four", true)
            ]
        );
    }

    #[test]
    fn when_a_line_break_follows_a_hyphen_the_next_syllable_starts_a_line() {
        let out = syllables("wa-\nter");
        assert_eq!(out[1].text, "ter");
        assert!(out[1].starts_line);
    }

    #[test]
    fn when_the_text_is_empty_there_are_no_syllables() {
        assert!(syllables("").is_empty());
        assert!(syllables("   \n ").iter().all(|s| s.text.is_empty()));
    }

    #[test]
    fn when_lyrics_are_multibyte_they_are_split_on_character_boundaries() {
        assert_eq!(
            texts("きら- きら ひか- る"),
            ["きら-", "きら", "ひか-", "る"]
        );
    }
}
