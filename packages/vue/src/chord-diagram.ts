import { computed, defineComponent, h, type PropType, type VNode } from 'vue';

import {
  useChordDiagram,
  type ChordDiagramInstrument,
  type ChordDiagramOrientation,
  type ChordDiagramWasmLoader,
} from './use-chord-diagram';

/**
 * Render a chord diagram (guitar / ukulele / piano) as inline SVG
 * via `@chordsketch/wasm`. The SVG comes from the trusted
 * `chordsketch_chordpro::chord_diagram` Rust module — the same
 * generator `<ChordSheet>`'s HTML output uses — so injecting it as
 * HTML is safe.
 *
 * ```vue
 * <ChordDiagram chord="Am" instrument="guitar" />
 * ```
 *
 * ### Slots
 *
 * - `loading` — while the WASM module loads. Defaults to a minimal
 *   `role="status"` placeholder.
 * - `not-found` — scoped slot receiving `{ chord, instrument }`,
 *   rendered when the voicing database has no entry for the pair.
 *   Defaults to an inline `role="note"` message so the chord name
 *   stays visible to a reader skimming the page.
 * - `error` — scoped slot receiving `{ error }`, rendered when the
 *   underlying call fails (unknown instrument, WASM init failure).
 *   Defaults to an inline `role="alert"`.
 */
export const ChordDiagram = defineComponent({
  name: 'ChordDiagram',
  props: {
    /** Chord name (e.g. `"Am"`, `"C#m7"`, `"Bb"`). */
    chord: { type: String, required: true },
    /** Instrument family. Defaults to `"guitar"`. */
    instrument: {
      type: String as PropType<ChordDiagramInstrument>,
      default: 'guitar' as const,
    },
    /**
     * Optional list of song-level `{define: <name> <raw>}` voicings
     * to consult before falling back to the built-in voicing
     * database. Each entry is a `[chord_name, raw]` tuple — the raw
     * string carries the directive body (e.g. `"base-fret 1 frets
     * 3 3 0 0 1 3"`). Mirrors the Rust
     * `voicings::lookup_diagram`'s "song-level defines take
     * priority" rule.
     */
    defines: {
      type: Array as PropType<ReadonlyArray<readonly [string, string]>>,
      default: undefined,
    },
    /**
     * Diagram orientation. Defaults to `"vertical"` — nut on top,
     * frets running downward. Pass `"horizontal"` for the
     * Japanese-tablature convention with nut on the left and frets
     * running rightward (reader-view, high pitch on top).
     */
    orientation: {
      type: String as PropType<ChordDiagramOrientation>,
      default: undefined,
    },
    /**
     * Render the compact above-a-lyric layout (the chordsketch
     * extension used by the `{diagrams: inline}` / `{diagrams:
     * hover}` modes). Defaults to `false` (the full-size diagram).
     * Falls back to the regular size on `@chordsketch/wasm` bundles
     * that predate the compact export.
     */
    compact: { type: Boolean, default: false },
    /**
     * Test-only WASM loader override. Production callers never need
     * to supply this — the default lazy-loads `@chordsketch/wasm`.
     *
     * @internal
     */
    wasmLoader: { type: Function as PropType<ChordDiagramWasmLoader>, default: undefined },
  },
  setup(props, { slots }) {
    const options = computed(() => ({
      instrument: props.instrument,
      defines: props.defines,
      orientation: props.orientation,
      compact: props.compact,
    }));
    const { svg, loading, error } = useChordDiagram(
      () => props.chord,
      options,
      props.wasmLoader,
    );

    // Surface the active orientation as a DOM attribute so
    // consumers and tests can observe it without parsing the SVG.
    // Omitted (not emitted as `data-orientation=""`) when the prop
    // is unset so the default vertical case stays attribute-free.
    const orientationAttr = computed(() =>
      props.orientation !== undefined ? { 'data-orientation': props.orientation } : {},
    );

    // `--compact` is a hook for host CSS; the compact geometry
    // itself comes from the renderer's compact SVG template.
    const wrapperClass = computed(() => [
      'chordsketch-diagram',
      props.compact ? 'chordsketch-diagram--compact' : null,
    ]);

    return () => {
      if (error.value !== null) {
        const nodes: VNode[] = slots.error
          ? slots.error({ error: error.value })
          : [
              h(
                'div',
                { role: 'alert', class: 'chordsketch-diagram__error' },
                error.value.message,
              ),
            ];
        return h(
          'div',
          { ...orientationAttr.value, class: wrapperClass.value },
          nodes,
        );
      }

      if (svg.value === null) {
        if (loading.value) {
          const nodes: VNode[] = slots.loading
            ? slots.loading()
            : [
                h(
                  'div',
                  {
                    role: 'status',
                    'aria-live': 'polite',
                    class: 'chordsketch-diagram__loading',
                  },
                  'Loading diagram…',
                ),
              ];
          return h(
            'div',
            {
              ...orientationAttr.value,
              class: wrapperClass.value,
              'aria-busy': 'true',
            },
            nodes,
          );
        }

        // Not loading and no SVG — the voicing database has no
        // entry for this pair.
        const nodes: VNode[] = slots['not-found']
          ? slots['not-found']({ chord: props.chord, instrument: props.instrument })
          : [
              h('div', { role: 'note', class: 'chordsketch-diagram__notfound' }, [
                h('strong', props.chord),
                h('span', ` — no ${props.instrument} voicing in the built-in database`),
              ]),
            ];
        return h(
          'div',
          { ...orientationAttr.value, class: wrapperClass.value },
          nodes,
        );
      }

      return h('div', {
        ...orientationAttr.value,
        class: wrapperClass.value,
        // Without an explicit name the inline SVG's accessible name
        // is the empty string and the chord identity is invisible
        // to screen readers. A consumer-supplied `role` (e.g. a
        // tooltip wrapper) overrides this one through attribute
        // fallthrough.
        role: 'img',
        'aria-label': `${props.chord} chord diagram (${props.instrument})`,
        innerHTML: svg.value,
      });
    };
  },
});
