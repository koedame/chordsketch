// Page-level shared Web Audio resources.
//
// Browsers cap the number of concurrent `AudioContext`s, and creating
// one per hook instance (a metronome chip plus a chord-audio surface,
// say) would race that cap. This module owns a single lazily-created
// `AudioContext` that every audio hook in the package reuses for the
// page lifetime. The context is created on the first user gesture (to
// satisfy autoplay policies) and is suspended — not closed — when idle,
// the recommended Web Audio pattern, so it stays cheap to keep around.
//
// Extracted from `use-metronome.ts` (#2650) so `useMetronome` and
// `useChordAudio` share one context instead of spawning two.

type AudioContextCtor = new () => AudioContext;

let sharedContext: AudioContext | null = null;

/**
 * Resolve the platform `AudioContext` constructor, tolerating the legacy
 * `webkitAudioContext` prefix. Returns `null` under SSR or when neither is
 * present, so callers can branch on Web Audio support.
 */
export function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & {
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Lazily create (or reuse) the page-level shared `AudioContext`. Returns
 * `null` when Web Audio is unavailable.
 */
export function getSharedAudioContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  sharedContext = new Ctor();
  return sharedContext;
}

/**
 * Reset the module-level shared `AudioContext`.
 *
 * **Test-only** — not re-exported from the package index. Lets each test
 * start from a clean singleton after swapping the `window.AudioContext`
 * stub.
 *
 * @internal
 */
export function resetSharedAudioContextForTests(): void {
  sharedContext = null;
}
