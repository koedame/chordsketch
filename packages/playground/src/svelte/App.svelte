<script lang="ts">
  // Live demo of `@chordsketch/svelte`, written the way the recipe
  // page tells a consumer to write it: `<ChordTextarea>` with
  // `bind:value` for the source and `bind:transpose` for the preview
  // offset, plus a standalone `<Transpose>` bound to the same rune.
  // Nothing here reaches past the package's public surface — the
  // component tree IS the recipe, running.
  //
  // The page's nav, heading and lede live in `svelte/index.html` as
  // static markup; only the editor needs Svelte, so only the editor
  // is mounted (see that file's comment).
  import { ChordTextarea, Transpose, version } from '@chordsketch/svelte';

  import { SAMPLE_CHORDPRO } from '../sample';

  let source = $state(SAMPLE_CHORDPRO);
  let transpose = $state(0);
</script>

<div class="toolbar framework-demo__toolbar">
  <div class="tool-group">
    <span class="label">Preview</span>
    <Transpose bind:value={transpose} />
  </div>
  <div class="tool-group">
    <span class="label">Package</span>
    <code class="framework-demo__version">&#64;chordsketch/svelte {version()}</code>
  </div>
</div>
<ChordTextarea bind:value={source} bind:transpose />
