// Sample iReal Pro URL exported by the upstream `pianosnake/ireal-reader`
// test corpus and re-used here for read-only preview demos. The URL
// percent-decodes to a single-song iReal chart; the editor seeds the
// ChordPro sample by default and switches to this constant when a host
// (e.g. desktop App Open with `.irealb`, or playground "Try iReal"
// toggle in #2366) flips the editor to the iReal mode. The constant
// is exported here so #2363+ can pick it up without re-coding the URL.
export const SAMPLE_IREALB =
  'irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,' +
  '%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,' +
  '%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,' +
  '%43%20%7C%20==%31%34%30=%33';

// Sample ChordPro content preloaded in the editor.
export const SAMPLE_CHORDPRO = `{title: Amazing Grace}
{subtitle: John Newton}
{key: G}
{tempo: 80}

{start_of_verse: Verse 1}
[G]Amazing [G7]grace, how [C]sweet the [G]sound,
That [G]saved a [Em]wretch like [D]me.
I [G]once was [G7]lost, but [C]now am [G]found,
Was [G]blind but [D]now I [G]see.
{end_of_verse}

{start_of_verse: Verse 2}
[G]'Twas grace that [G7]taught my [C]heart to [G]fear,
And [G]grace my [Em]fears re[D]lieved.
How [G]precious [G7]did that [C]grace ap[G]pear,
The [G]hour I [D]first be[G]lieved.
{end_of_verse}

{start_of_chorus}
[C]Through many [G]dangers, [Em]toils and [G]snares,
I [G]have al[Em]ready [D]come.
'Tis [G]grace hath [G7]brought me [C]safe thus [G]far,
And [G]grace will [D]lead me [G]home.
{end_of_chorus}
`;
