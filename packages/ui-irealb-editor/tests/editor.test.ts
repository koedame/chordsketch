// Unit tests for `createIrealbEditor`. The wasm bridge is stubbed —
// the suite does not depend on a built `@chordsketch/wasm`. The stub
// is a hand-rolled bijection: `parseIrealb(STUB_URL)` returns
// `STUB_SONG_JSON`, and `serializeIrealb` returns
// `irealb://` + `<JSON>` so the test can assert which JSON object the
// editor handed to the wasm boundary on each call.
//
// Why a stub rather than the real wasm: this package has zero runtime
// dependency on `@chordsketch/wasm` and a peer-dep relationship at
// publish time. Pulling the wasm into vitest would require a
// build-then-test pipeline (the wasm-pack output is not in the repo
// at test time outside of CI's release path) and would not catch
// anything the wasm crate's own unit tests already do. The contract
// under test here is "the editor mutates state and calls
// `serializeIrealb` correctly", not "wasm parses URLs correctly".

import { describe, expect, test, vi } from 'vitest';
import { createIrealbEditor, type IrealbWasm } from '../src/index';
import type { IrealSong } from '../src/ast';

const SAMPLE_SONG: IrealSong = {
  title: 'Stub Sample',
  composer: 'Anon',
  style: 'Medium Swing',
  key_signature: {
    root: { note: 'F', accidental: 'natural' },
    mode: 'major',
  },
  time_signature: { numerator: 4, denominator: 4 },
  tempo: 140,
  transpose: 0,
  sections: [
    {
      label: { kind: 'letter', value: 'A' },
      bars: [
        {
          start: 'open_repeat',
          end: 'single',
          chords: [
            {
              chord: {
                root: { note: 'C', accidental: 'natural' },
                quality: { kind: 'major7' },
                bass: null,
              },
              position: { beat: 1, subdivision: 0 },
            },
          ],
          ending: null,
          symbol: null,
        },
        {
          start: 'single',
          end: 'close_repeat',
          chords: [
            {
              chord: {
                root: { note: 'F', accidental: 'natural' },
                quality: { kind: 'dominant7' },
                bass: null,
              },
              position: { beat: 1, subdivision: 0 },
            },
          ],
          ending: null,
          symbol: null,
        },
      ],
    },
  ],
};
const SAMPLE_SONG_JSON = JSON.stringify(SAMPLE_SONG);
const SAMPLE_URL = 'irealb://stub-sample';

function makeStubWasm(): IrealbWasm & {
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
} {
  const parseIrealb = vi.fn((input: string): string => {
    if (input === SAMPLE_URL) return SAMPLE_SONG_JSON;
    if (input.startsWith('irealb://json:')) {
      return decodeURIComponent(input.slice('irealb://json:'.length));
    }
    throw new Error(`stub parseIrealb: unknown URL: ${input}`);
  });
  const serializeIrealb = vi.fn((input: string): string => {
    // Round-trip envelope: serialize back to a URL that parseIrealb
    // can later decode. The envelope keeps the JSON byte-equal so
    // string-equality assertions still mean what they appear to.
    return `irealb://json:${encodeURIComponent(input)}`;
  });
  return { parseIrealb, serializeIrealb };
}

describe('createIrealbEditor', () => {
  test('parse -> mutate header -> serialize round-trip', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    // Sanity: the editor parsed the initial URL once.
    expect(wasm.parseIrealb).toHaveBeenCalledTimes(1);
    expect(wasm.parseIrealb).toHaveBeenCalledWith(SAMPLE_URL);

    // Pre-mutation getValue returns a URL whose embedded JSON is
    // byte-equal to the source AST.
    const initialUrl = editor.getValue();
    const initialJson = decodeURIComponent(initialUrl.slice('irealb://json:'.length));
    expect(JSON.parse(initialJson)).toEqual(SAMPLE_SONG);

    // Mutate the title via the corresponding form input.
    const titleInput = editor.element.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    if (!titleInput) throw new Error('title input not rendered');
    titleInput.value = 'Mutated Title';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Post-mutation getValue exposes the new title in the JSON the
    // editor passed to serializeIrealb.
    const mutatedUrl = editor.getValue();
    expect(mutatedUrl).not.toBe(initialUrl);
    const mutatedJson = JSON.parse(
      decodeURIComponent(mutatedUrl.slice('irealb://json:'.length)),
    ) as IrealSong;
    expect(mutatedJson.title).toBe('Mutated Title');
    // Other fields untouched — confirms we mutated in place rather
    // than reseeding from a fresh empty AST.
    expect(mutatedJson.composer).toBe(SAMPLE_SONG.composer);
    expect(mutatedJson.sections.length).toBe(SAMPLE_SONG.sections.length);

    editor.destroy();
  });

  test('parse -> serialize byte-equal for unchanged AST', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    // Two consecutive getValue() calls without any user mutation
    // emit byte-equal URLs: the AST has not drifted, and the
    // serialise call is deterministic against an unchanged AST.
    const url1 = editor.getValue();
    const url2 = editor.getValue();
    expect(url2).toBe(url1);

    // The serialised JSON is byte-equal to JSON.stringify on the
    // original AST. This pins "AST round-trips through the editor
    // unchanged" as a structural property the editor must preserve.
    const json = decodeURIComponent(url1.slice('irealb://json:'.length));
    expect(JSON.parse(json)).toEqual(SAMPLE_SONG);

    editor.destroy();
  });

  test('setValue does NOT fire onChange', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    const handler = vi.fn();
    editor.onChange(handler);

    // Replace the editor contents programmatically. The contract
    // says: setValue is a load, not a user edit, so onChange must
    // NOT fire. Mirrors `defaultTextareaEditor` in ui-web.
    const replacementSong: IrealSong = { ...SAMPLE_SONG, title: 'Loaded' };
    const replacementUrl = `irealb://json:${encodeURIComponent(
      JSON.stringify(replacementSong),
    )}`;
    editor.setValue(replacementUrl);

    expect(handler).not.toHaveBeenCalled();

    // Confirm the load actually took effect — the form should now
    // show the new title.
    const titleInput = editor.element.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    if (!titleInput) throw new Error('title input not rendered after setValue');
    expect(titleInput.value).toBe('Loaded');

    // A subsequent USER edit DOES fire the handler — the
    // suppression is specific to the setValue path, not blanket.
    titleInput.value = 'User Edit';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('destroy removes all DOM children and stops dispatching onChange', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    const handler = vi.fn();
    editor.onChange(handler);

    // Capture a reference to the title input BEFORE destroy so we
    // can prove that dispatching an event on the (orphaned) node
    // does not call back into the editor's listener after destroy.
    const titleInput = editor.element.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    if (!titleInput) throw new Error('title input not rendered before destroy');

    editor.destroy();

    // Element is empty. The host removes the element from the
    // document; we verify only that we cleared our own children.
    expect(editor.element.children.length).toBe(0);

    // Dispatching on the orphaned node MUST NOT invoke the
    // onChange handler — the editor's listener has been removed.
    titleInput.value = 'After Destroy';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();

    // Calling destroy again is a no-op (idempotent) — pins the
    // double-call safety property.
    expect(() => editor.destroy()).not.toThrow();
  });

  test('onChange unsubscription stops handler delivery', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    const handler = vi.fn();
    const unsub = editor.onChange(handler);

    const titleInput = editor.element.querySelector<HTMLInputElement>(
      'input[type="text"]',
    );
    if (!titleInput) throw new Error('title input not rendered');

    // Fire before unsubscribing — the handler must be called.
    titleInput.value = 'Before Unsub';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);

    // Unsubscribe.
    unsub();

    // Fire after unsubscribing — the handler must NOT be called again.
    titleInput.value = 'After Unsub';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('initialValue === "" seeds an empty chart without invoking parseIrealb', () => {
    // Empty-string fast path: skipping the wasm parse keeps a
    // freshly-mounted editor predictable when the host has not yet
    // loaded a file (matches `defaultTextareaEditor`'s empty
    // initial behaviour).
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: '', wasm });

    expect(wasm.parseIrealb).not.toHaveBeenCalled();

    // The form is rendered with empty defaults — title is empty,
    // mode is major, etc. Read back through serializeIrealb.
    const url = editor.getValue();
    const json = JSON.parse(
      decodeURIComponent(url.slice('irealb://json:'.length)),
    ) as IrealSong;
    expect(json.title).toBe('');
    expect(json.composer).toBeNull();
    expect(json.sections).toEqual([]);

    editor.destroy();
  });
});
