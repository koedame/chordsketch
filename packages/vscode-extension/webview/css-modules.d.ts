/**
 * Ambient declarations for CSS imports the WebView bundles as text.
 *
 * `esbuild.mjs` sets `loader: { '.css': 'text' }` on the webview build so
 * the imported value is the file's raw contents as a string. The runtime
 * injects this into a `<style>` tag (see `injectChordsketchReactStyles`
 * in `preview.tsx`). TypeScript needs an ambient module so the import
 * specifier resolves with a known type.
 */

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '@chordsketch/react/styles.css' {
  const content: string;
  export default content;
}
