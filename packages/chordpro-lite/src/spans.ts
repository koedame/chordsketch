/**
 * Linear-time span scanning for a single line.
 *
 * `/\[[^\]\n]*\]/g` and `/\{[^}\n]*\}/g` are quadratic on a line of many
 * unterminated openers (`[[[[...`): every opener rescans to the end of the
 * line before failing. When one opener finds no closer, no later opener can
 * either, so the scan stops there. `line` must not contain `\n` (callers
 * split on it first).
 */

/** The `[start, end)` ranges of each `open ... close` span, in order. */
function spanRanges(line: string, open: string, close: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const start = line.indexOf(open, from);
    if (start === -1) return ranges;
    const end = line.indexOf(close, start + 1);
    if (end === -1) return ranges;
    ranges.push([start, end + 1]);
    from = end + 1;
  }
}

/** `line` with every `open ... close` span removed. */
export function removeSpans(line: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (const [start, end] of spanRanges(line, open, close)) {
    out += line.slice(from, start);
    from = end;
  }
  return out + line.slice(from);
}

/** The text between `open` and `close` of every span, in order. */
export function spanContents(line: string, open: string, close: string): string[] {
  return spanRanges(line, open, close).map(([start, end]) => line.slice(start + 1, end - 1));
}
