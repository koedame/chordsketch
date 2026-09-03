// Vue entry for the `/chordsketch/vue/` live demo. Mirrors
// `src/chordpro/main.tsx`'s job for the React playground: load the
// shared playground chrome, load the package's own component
// stylesheet, mount.
import { createApp } from 'vue';

import '../playground.css';
import '../framework-demo.css';
import '@chordsketch/vue/styles.css';

import App from './App.vue';

const host = document.getElementById('app');
if (host === null) throw new Error('Missing #app mount point in vue/index.html');

createApp(App).mount(host);
