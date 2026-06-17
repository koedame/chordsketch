import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { KeySignatureGlyph, unicodeAccidentals } from './music-glyphs';
import { type KeyAudioWasmLoader, useKeyAudio } from './use-key-audio';

/** Props for {@link KeySignatureButton}. */
export interface KeySignatureButtonProps {
  /** Authored key, as written in the `{key}` directive (e.g. `"G"`, `"Am"`). */
  keyName: string;
  /**
   * Sounding (transposed) key, when a transpose / capo is active. When
   * present, the chip renders an `Original → Playing` pair and the
   * audition plays the *sounding* key — what the reader actually hears.
   */
  soundingKey?: string | null;
  /**
   * Class(es) for the chip root. The AST walker passes
   * `"meta-inline meta-inline--key"` (plus `meta-inline--key-pair` when a
   * sounding key is present); `pushElement` may append `line--active`.
   */
  className?: string;
  /**
   * Forwarded to the chip root so the editor↔preview caret sync can map
   * the chip back to its source line (set by the walker's `pushElement`).
   */
  'data-source-line'?: number;
  /**
   * WASM loader override for tests. Production uses the `useKeyAudio`
   * default, which lazy-loads `@chordsketch/wasm`.
   */
  wasmLoader?: KeyAudioWasmLoader;
}

/**
 * Interactive `{key}` chip.
 *
 * The whole chip is the click target (not just the icon): clicking
 * anywhere on it auditions the key (via {@link useKeyAudio}) — the
 * movable-do scale "do re mi fa sol la ti do" followed by the tonic triad
 * "do mi sol" strummed. Major and minor keys are both supported. The
 * cursor turns into a speaker on hover.
 *
 * When a transpose is active the chip shows the `Original → Playing` pair
 * and the audition plays the *sounding* key (what the reader hears).
 *
 * When the Web Audio API is unavailable — SSR, or a browser without
 * `AudioContext` — it degrades to a plain, non-interactive `<span>` chip
 * (byte-identical to the walker's pre-#2658 markup) so no dead control is
 * rendered. The interactive upgrade is deferred to a post-mount effect so
 * the server-rendered markup matches the client's first render and React
 * does not report a hydration mismatch.
 */
export function KeySignatureButton({
  keyName,
  soundingKey,
  className,
  'data-source-line': dataSourceLine,
  wasmLoader,
}: KeySignatureButtonProps): JSX.Element {
  const audio = useKeyAudio(wasmLoader);
  const [interactive, setInteractive] = useState(false);

  useEffect(() => {
    setInteractive(audio.supported);
  }, [audio.supported]);

  const isPair = soundingKey != null && soundingKey.length > 0;
  // The audible key is what the reader hears: the sounding key when a
  // transpose is active, otherwise the authored key.
  const audibleKey = isPair ? soundingKey : keyName;

  // Inner chip content — identical between the interactive button and the
  // non-interactive span fallback so the DOM contract (`.meta-inline__*`
  // classes, the Original → Playing pair) and CSS stay stable regardless
  // of which element type wraps it. In interactive mode the glyphs are
  // hidden from AT because the button supplies its own complete label.
  const content = isPair ? (
    <>
      <span className="meta-inline__group">
        <KeySignatureGlyph
          keyName={keyName}
          className="meta-inline__glyph"
          aria-hidden={interactive || undefined}
        />
        <span className="meta-inline__label">Original:</span>{' '}
        <span className="meta-inline__value">{unicodeAccidentals(keyName)}</span>
      </span>
      <span className="meta-inline__separator" aria-hidden="true">
        →
      </span>
      <span className="meta-inline__group">
        <KeySignatureGlyph
          keyName={soundingKey}
          className="meta-inline__glyph"
          aria-hidden={interactive || undefined}
        />
        <span className="meta-inline__label">Playing:</span>{' '}
        <span className="meta-inline__value">{unicodeAccidentals(soundingKey)}</span>
      </span>
    </>
  ) : (
    <>
      <KeySignatureGlyph
        keyName={keyName}
        className="meta-inline__glyph"
        aria-hidden={interactive || undefined}
      />
      <span className="meta-inline__label">Key:</span>{' '}
      <span className="meta-inline__value">{unicodeAccidentals(keyName)}</span>
    </>
  );

  if (!interactive) {
    return (
      <span className={className} data-source-line={dataSourceLine}>
        {content}
      </span>
    );
  }

  const audibleDisplay = unicodeAccidentals(audibleKey);
  const label = isPair
    ? `Play the ${audibleDisplay} scale and chord (transposed from ${unicodeAccidentals(
        keyName,
      )})`
    : `Play the ${audibleDisplay} scale and chord`;

  return (
    <button
      type="button"
      className={[className, 'meta-inline--interactive'].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      data-source-line={dataSourceLine}
      onClick={() => audio.play(audibleKey)}
    >
      {content}
    </button>
  );
}
