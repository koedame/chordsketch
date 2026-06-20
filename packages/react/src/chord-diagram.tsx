import type {
  AnimationEvent as ReactAnimationEvent,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from 'react';
import { useCallback, useRef } from 'react';

import { pulseElement } from './chord-pulse';
import type { ChordAudioConfig } from './use-chord-audio';
import {
  type ChordDiagramInstrument,
  type ChordDiagramOrientation,
  type ChordDiagramWasmLoader,
  useChordDiagram,
} from './use-chord-diagram';

/** Props accepted by {@link ChordDiagram}. */
export interface ChordDiagramProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Chord name (e.g. `"Am"`, `"C#m7"`, `"Bb"`). */
  chord: string;
  /** Instrument family. Defaults to `"guitar"`. */
  instrument?: ChordDiagramInstrument;
  /**
   * Optional list of song-level `{define: <name> <raw>}` voicings
   * to consult before falling back to the built-in voicing
   * database. Each entry is a `[chord_name, raw]` tuple — the raw
   * string carries the directive body (e.g. `"base-fret 1 frets
   * 3 3 0 0 1 3"`). Mirrors `chordsketch_chordpro::voicings::lookup_diagram`'s
   * "song-level defines take priority" rule so user-defined
   * chords show up here exactly like the Rust HTML renderer's
   * `<section class="chord-diagrams">` block.
   */
  defines?: ReadonlyArray<readonly [string, string]>;
  /**
   * Diagram orientation (#2572). Defaults to `"vertical"` — nut on
   * top, frets running downward. Pass `"horizontal"` for the
   * Japanese-tablature convention with nut on the left and frets
   * running rightward (reader-view, high pitch on top — see ADR-0026).
   */
  orientation?: ChordDiagramOrientation;
  /**
   * Render the compact above-a-lyric layout (a chordsketch extension
   * used by the `{diagrams: inline}` / `{diagrams: hover}` modes).
   * Defaults to `false` (the full-size diagram). The compact SVG keeps
   * the chord-name title and finger glyphs legible while shrinking the
   * grid geometry, and carries a `chord-diagram-compact` /
   * `keyboard-diagram-compact` class on its root for CSS targeting.
   * Falls back to the regular size on `@chordsketch/wasm` bundles that
   * predate the compact export.
   */
  compact?: boolean;
  /**
   * Chord-audio config (#2686). When `chordAudio.enabled` is `true`, the
   * whole diagram becomes a play button: clicking it (or pressing Enter /
   * Space while focused) sounds the chord via `chordAudio.play(chord)`,
   * with a brief activation pulse. When omitted / disabled, the diagram
   * renders as a static `role="img"` figure exactly as before.
   *
   * Wiring audio here — at the canonical diagram component — means every
   * consumer (the end-of-song chord-diagrams grid, the inline / hover
   * cells in the JSX walker, and external library consumers using
   * `<ChordDiagram>` directly) gets click-to-play uniformly, rather than
   * each call site bolting on its own handler.
   *
   * Degrades gracefully: the host is responsible for only supplying an
   * `enabled` config when Web Audio is actually available (e.g. via
   * `useChordAudio().supported`), so on SSR / unsupported browsers the
   * diagram stays a static figure instead of a dead button.
   */
  chordAudio?: ChordAudioConfig | null;
  /**
   * Optional node shown while the WASM module loads. Defaults to
   * a minimal `role="status"` placeholder.
   */
  loadingFallback?: ReactNode;
  /**
   * Rendered when the voicing database has no entry for the given
   * chord+instrument pair. Defaults to an inline `role="note"`
   * "Chord not found" message so the chord name remains visible
   * to a reader skimming the page.
   */
  notFoundFallback?: ((chord: string, instrument: ChordDiagramInstrument) => ReactNode) | ReactNode;
  /**
   * Rendered when the underlying call errors (unknown instrument,
   * WASM init failure). Defaults to an inline `role="alert"`
   * showing the error message. Pass `null` to hide and surface
   * errors via your own channel (e.g. a toast).
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override. Production callers never
   * supply this — the default lazy-loads `@chordsketch/wasm`.
   *
   * @internal
   */
  wasmLoader?: ChordDiagramWasmLoader;
}

function defaultNotFoundFallback(
  chord: string,
  instrument: ChordDiagramInstrument,
): ReactNode {
  return (
    <div role="note" className="chordsketch-diagram__notfound">
      <strong>{chord}</strong>
      <span> — no {instrument} voicing in the built-in database</span>
    </div>
  );
}

function defaultErrorFallback(error: Error): ReactNode {
  return (
    <div role="alert" className="chordsketch-diagram__error">
      {error.message}
    </div>
  );
}

function defaultLoadingFallback(): ReactNode {
  return (
    <div role="status" aria-live="polite" className="chordsketch-diagram__loading">
      Loading diagram…
    </div>
  );
}

/**
 * Render a chord diagram (guitar / ukulele / piano) as inline SVG
 * via `@chordsketch/wasm`. The SVG comes from the trusted
 * `chordsketch_chordpro::chord_diagram` Rust module — the same
 * generator `<ChordSheet>`'s HTML output uses — so injection via
 * `dangerouslySetInnerHTML` is safe.
 *
 * ```tsx
 * <ChordDiagram chord="Am" instrument="guitar" />
 * ```
 *
 * When the chord is not known to the built-in voicing database
 * the component renders `notFoundFallback` instead of the SVG
 * (defaults to an inline "chord not found" note). When the
 * underlying call errors (unknown instrument, WASM init failure),
 * `errorFallback` is rendered.
 */
export function ChordDiagram({
  chord,
  instrument = 'guitar',
  defines,
  orientation,
  compact,
  loadingFallback,
  notFoundFallback = defaultNotFoundFallback,
  errorFallback = defaultErrorFallback,
  chordAudio,
  wasmLoader,
  className,
  ...divProps
}: ChordDiagramProps): JSX.Element {
  const { svg, loading, error } = useChordDiagram(
    chord,
    instrument,
    wasmLoader,
    defines,
    orientation,
    compact,
  );

  // Chord-audio (#2686). When on, the diagram is a play button. The ref
  // points at whichever wrapper actually renders (svg / not-found /
  // loading) so the activation pulse lands on the visible element.
  const audioOn = Boolean(chordAudio?.enabled);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const handlePlay = useCallback(() => {
    chordAudio?.play(chord);
    if (ringRef.current) pulseElement(ringRef.current, 'chordsketch-diagram--ringing');
  }, [chordAudio, chord]);

  const wrapperClass = [
    'chordsketch-diagram',
    compact && 'chordsketch-diagram--compact',
    audioOn && 'chordsketch-diagram--audio',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  // Surface the active orientation as a DOM attribute so consumers
  // and tests can observe it without parsing the SVG. Omitted (not
  // emitted as `data-orientation=""`) when the prop is unset so the
  // default vertical case stays attribute-free.
  const orientationAttr = orientation !== undefined ? { 'data-orientation': orientation } : {};

  // Interactive button props applied to the content-bearing branches
  // (svg / not-found / loading) when audio is on. The error branch stays
  // a static `role="alert"` — a failed diagram is not a play target, and
  // audio would not work either if the wasm module failed to init. The
  // `role="button"` here replaces the static `role="img"` (an element
  // cannot be both), with an action-naming `aria-label` so the accessible
  // name conveys both the chord and that pressing plays it.
  const audioInteractiveProps = audioOn
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': `Play chord ${chord} (${instrument})`,
        'data-chord': chord,
        onClick: () => handlePlay(),
        onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handlePlay();
          }
        },
        // Safety cleanup mirroring the walker's chord-name path: drop the
        // transient ring class once its animation ends.
        onAnimationEnd: (e: ReactAnimationEvent<HTMLDivElement>) => {
          e.currentTarget.classList.remove('chordsketch-diagram--ringing');
        },
      }
    : null;

  if (error !== null && errorFallback !== null) {
    const node =
      typeof errorFallback === 'function' ? errorFallback(error) : errorFallback;
    return (
      <div {...divProps} {...orientationAttr} className={wrapperClass}>
        {node}
      </div>
    );
  }

  if (svg === null) {
    if (loading) {
      const node = loadingFallback ?? defaultLoadingFallback();
      return (
        <div
          {...divProps}
          {...orientationAttr}
          ref={audioOn ? ringRef : undefined}
          className={wrapperClass}
          aria-busy="true"
          {...(audioInteractiveProps ?? {})}
        >
          {node}
        </div>
      );
    }
    // Not loading and no SVG — the voicing database has no entry. The
    // diagram still plays when audio is on (the chord name fallback the
    // inline-diagram mode shows here stays a play target).
    const node =
      typeof notFoundFallback === 'function'
        ? notFoundFallback(chord, instrument)
        : notFoundFallback;
    return (
      <div
        {...divProps}
        {...orientationAttr}
        ref={audioOn ? ringRef : undefined}
        className={wrapperClass}
        {...(audioInteractiveProps ?? {})}
      >
        {node}
      </div>
    );
  }

  return (
    <div
      {...divProps}
      {...orientationAttr}
      ref={audioOn ? ringRef : undefined}
      className={wrapperClass}
      // When audio is off, expose the diagram as a labelled image to
      // assistive tech (without this, the inline SVG's accessible name is
      // the empty string and the chord identity is invisible to screen
      // readers). When audio is on, `audioInteractiveProps` supplies
      // `role="button"` + an action label instead — an element cannot be
      // both an image and a button.
      {...(audioInteractiveProps ?? {
        role: 'img',
        'aria-label': `${chord} chord diagram (${instrument})`,
      })}
      // The SVG is produced by our own Rust renderer
      // (`chord_diagram::render_svg` / `render_keyboard_svg`),
      // which emits a fixed, hand-written template — nothing in
      // the output is derived from user-controlled attributes.
      // Injection via `dangerouslySetInnerHTML` is safe here.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
