// Sample iReal Pro URL re-exported from the upstream
// `pianosnake/ireal-reader` test corpus. Kept byte-equal to
// `packages/ui-web/src/sample.ts` SAMPLE_IREALB and to the CLI
// fixture `crates/cli/tests/cli.rs` TINY_IREAL_URL — the three
// constants are sister fixtures, and a future change to the
// upstream corpus URL must update all three. Duplicated rather
// than imported so this package's test suite does not pull a
// runtime dep on `@chordsketch/ui-web`.
export const SAMPLE_IREALB =
  'irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,' +
  '%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,' +
  '%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,' +
  '%43%20%7C%20==%31%34%30=%33';
