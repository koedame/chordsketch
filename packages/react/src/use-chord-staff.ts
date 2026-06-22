import { useEffect, useRef, useState } from 'react';

// Narrow WASM surface this hook touches. Kept structural so the React
// package does not drag the WASM glue into its type graph — the module is
// dynamically imported at runtime. Mirrors the `chordStaffNotes` export added
// in #2695 (sister to `chordsketch_chordpro::chord_staff_notes`).
interface StaffNotesModule {
  default: () => Promise<unknown>;
  /**
   * Constituent tones of `chord` spelled for staff notation, ascending by
   * pitch (a slash bass sorts first), or `null` / `undefined` when the
   * string is not parseable as a chord.
   */
  chordStaffNotes: (chord: string) => StaffNote[] | null | undefined;
}

/**
 * One staff-placed chord tone — the React mirror of the wasm `StaffNote`
 * object (`chordsketch_chordpro::StaffNote`). Spelled diatonically from the
 * chord's structure so it lands on its conventional staff line (e.g. `Ebm7`
 * → E♭ G♭ B♭ D♭, not the enharmonic D♯ F♯ A♯ C♯).
 */
export interface StaffNote {
  /** Note letter the tone is spelled on, `"A"`–`"G"`. */
  readonly letter: string;
  /**
   * Signed accidental as a semitone offset on {@link letter}: `-2`
   * double-flat, `-1` flat, `0` natural, `1` sharp, `2` double-sharp.
   */
  readonly accidental: number;
  /** Scientific-pitch-notation octave (middle C = C4). */
  readonly octave: number;
  /** Absolute MIDI note number, consistent with the spelling. */
  readonly midi: number;
}

/**
 * WASM loader injected by tests. Production callers take the default, which
 * lazy-loads `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordStaffWasmLoader = () => Promise<StaffNotesModule>;

// Two-step cast through `unknown` — the wasm module's generated types,
// resolved against the JS bundle host bundlers see, do not formally include
// `chordStaffNotes`'s typed signature even though the export is present at
// runtime. The `StaffNotesModule` shape models the runtime contract; the
// runtime test against a stubbed loader is what guards it.
const defaultLoader: ChordStaffWasmLoader = () =>
  import('@chordsketch/wasm') as unknown as Promise<StaffNotesModule>;

/** State exposed by {@link useChordStaff}. */
export interface ChordStaffResult {
  /**
   * The chord's spelled constituent tones, or `null` while the WASM module
   * loads or when `chord` is not parseable. A parseable chord with no tones
   * is not possible — `null` always means "loading or not a chord".
   */
  notes: StaffNote[] | null;
  /** `true` while the WASM module loads or a lookup is in flight. */
  loading: boolean;
  /** Set only when WASM init itself fails. An unparseable chord is NOT an
   * error — it surfaces via `notes === null` once `loading` is `false`. */
  error: Error | null;
}

/**
 * Resolve a chord's spelled staff tones via `@chordsketch/wasm`'s
 * `chordStaffNotes`. The WASM module is loaded lazily and cached per hook
 * instance; the result re-resolves whenever `chord` changes.
 *
 * The musical-theory source of truth (which tones a chord contains and how
 * they are spelled) lives in the core library, not here — this hook only
 * fetches the precomputed placement (see
 * `.claude/rules/playground-is-a-sample.md`).
 *
 * ```ts
 * const { notes, loading } = useChordStaff('Cmaj9');
 * ```
 */
export function useChordStaff(
  chord: string,
  loader: ChordStaffWasmLoader = defaultLoader,
): ChordStaffResult {
  const [notes, setNotes] = useState<StaffNote[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const moduleRef = useRef<StaffNotesModule | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        if (moduleRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          if (cancelled) return;
          moduleRef.current = mod;
        }
        const result = moduleRef.current.chordStaffNotes(chord);
        if (cancelled) return;
        setNotes(result ?? null);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setNotes(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [chord]);

  return { notes, loading, error };
}
