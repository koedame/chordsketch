# No Lyrics Of Songs Still Under Copyright

Samples, fixtures, tests, documentation and design mock-ups must not
contain the lyrics of a song that is still under copyright, and must not
contain the full chord chart of one.

## Rule

- Use a public-domain song (the author died more than 70 years ago,
  or the text is traditional — e.g. Amazing Grace, Scarborough Fair,
  Oh! Susanna, Silent Night, Danny Boy) or text written for the purpose.
- Test strings that only need *some* lyric are written as neutral
  placeholders (`Sample text`, `Hello world`), not a line from a real song.
- A real title or artist name may appear in a list only when it is
  needed to make the point; prefer a public-domain title or an invented name.
- Fixtures that mirror a real chart (iReal Pro exports, imported
  files) are re-titled and their chords changed before they are committed.

## Why

Lyrics are copyrighted works. A public sample or a published package that
carries one invites a take-down request, and git history keeps the text
even after the file is changed.
