// Svelte entry for the `/chordsketch/svelte/` live demo. Mirrors
// `src/vue/main.ts`: load the shared playground chrome, load the
// package's own component stylesheet, mount.
import { mount } from 'svelte';

import '../playground.css';
import '../framework-demo.css';
import '@chordsketch/svelte/styles.css';

import App from './App.svelte';

const host = document.getElementById('app');
if (host === null) throw new Error('Missing #app mount point in svelte/index.html');

mount(App, { target: host });
