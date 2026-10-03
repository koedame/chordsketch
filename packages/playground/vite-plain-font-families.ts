// The @fontsource-variable packages register their faces as "Inter Variable",
// "Noto Sans JP Variable", ... The design tokens, the HTML the Rust renderers
// emit and the editor theme all name the families without the suffix, so the
// bundled faces are registered under the plain names. Without this the text
// silently falls back to a system font.
export const plainFontFamilies = {
  postcssPlugin: 'plain-font-families',
  AtRule: {
    'font-face'(rule: { walkDecls: (prop: string, cb: (decl: { value: string }) => void) => void }) {
      rule.walkDecls('font-family', (decl) => {
        decl.value = decl.value.replace(/ Variable(['"]?)$/, '$1');
      });
    },
  },
};
