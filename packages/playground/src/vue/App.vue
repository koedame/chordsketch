<script setup lang="ts">
// Live demo of `@chordsketch/vue`, written the way the recipe page
// tells a consumer to write it: `<ChordTextarea>` bound with
// `v-model` for the source and `v-model:transpose` for the preview
// offset, plus a standalone `<Transpose>` select driving the same
// ref. Nothing here reaches past the package's public surface — the
// component tree IS the recipe, running.
//
// The page's nav, heading and lede live in `vue/index.html` as
// static markup; only the editor needs Vue, so only the editor is
// mounted (see that file's comment).
import { ref } from 'vue';
import { ChordTextarea, Transpose, version } from '@chordsketch/vue';

import { SAMPLE_CHORDPRO } from '../sample';

const source = ref(SAMPLE_CHORDPRO);
const transpose = ref(0);
</script>

<template>
  <div class="toolbar framework-demo__toolbar">
    <div class="tool-group">
      <span class="label">Preview</span>
      <Transpose v-model="transpose" />
    </div>
    <div class="tool-group">
      <span class="label">Package</span>
      <code class="framework-demo__version">&#64;chordsketch/vue {{ version() }}</code>
    </div>
  </div>
  <ChordTextarea v-model="source" v-model:transpose="transpose" />
</template>
