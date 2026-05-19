// Docs site page registry.
//
// Each entry pairs a slug (which becomes the hash route under
// `/chordsketch/docs/#/<slug>`) with a Markdown source bundled at
// build time via Vite's `?raw` import.
//
// The canonical Markdown files live under `docs/sdk/` so a future
// GitHub viewer and this docs site render the same source. New
// pages get added by:
//   1. authoring the Markdown under `docs/sdk/<section>/<name>.md`,
//   2. registering its slug + group below,
//   3. extending the Playwright smoke if the page is the index of
//      a new group.

import gettingStartedSource from '../../../../docs/sdk/README.md?raw';
import embedReactSource from '../../../../docs/sdk/tasks/embed-react.md?raw';
import renderSource from '../../../../docs/sdk/tasks/render.md?raw';
import transposeTaskSource from '../../../../docs/sdk/tasks/transpose.md?raw';

import referenceIndexSource from '../../../../docs/sdk/reference/README.md?raw';
import refChordSheetSource from '../../../../docs/sdk/reference/chord-sheet.md?raw';
import refPlaygroundSource from '../../../../docs/sdk/reference/playground.md?raw';
import refEditorsSource from '../../../../docs/sdk/reference/editors.md?raw';
import refLayoutSource from '../../../../docs/sdk/reference/layout.md?raw';
import refTransposeSource from '../../../../docs/sdk/reference/transpose.md?raw';
import refChordDiagramSource from '../../../../docs/sdk/reference/chord-diagram.md?raw';
import refPdfExportSource from '../../../../docs/sdk/reference/pdf-export.md?raw';
import refChordSourceEditSource from '../../../../docs/sdk/reference/chord-source-edit.md?raw';
import refIrealComponentsSource from '../../../../docs/sdk/reference/ireal-components.md?raw';
import refIrealHooksSource from '../../../../docs/sdk/reference/ireal-hooks.md?raw';
import refIrealHelpersSource from '../../../../docs/sdk/reference/ireal-helpers.md?raw';
import refVersionSource from '../../../../docs/sdk/reference/version.md?raw';

export interface DocPage {
  slug: string;
  title: string;
  source: string;
  /** Short description shown on the index card / nav link. */
  blurb: string;
}

export interface DocGroup {
  label: string;
  pages: DocPage[];
}

/**
 * The canonical groups + pages, mirrored by the sidebar nav. The
 * order here drives the order in the sidebar.
 */
export const DOC_GROUPS: readonly DocGroup[] = [
  {
    label: 'Getting started',
    pages: [
      {
        slug: '',
        title: 'ChordSketch SDK',
        blurb:
          'Unified entry point for using ChordSketch from any language or runtime.',
        source: gettingStartedSource,
      },
    ],
  },
  {
    label: 'Recipes',
    pages: [
      {
        slug: 'embed-react',
        title: 'Embed in a React app',
        blurb:
          '10 copy-paste recipes for the @chordsketch/react component surface.',
        source: embedReactSource,
      },
      {
        slug: 'render',
        title: 'Render across every binding',
        blurb:
          'Render to HTML, plain text, or PDF — same operation, every host.',
        source: renderSource,
      },
      {
        slug: 'transpose-task',
        title: 'Transpose chords',
        blurb:
          'Transpose by N semitones across every binding (CLI / wasm / FFI / Rust).',
        source: transposeTaskSource,
      },
    ],
  },
  {
    label: 'API reference',
    pages: [
      {
        slug: 'reference',
        title: '@chordsketch/react reference',
        blurb:
          'Per-component and per-hook reference for every export.',
        source: referenceIndexSource,
      },
      {
        slug: 'reference/chord-sheet',
        title: '<ChordSheet> + AST hooks',
        blurb:
          '<ChordSheet>, renderChordproAst, useChordRender, useChordproAst.',
        source: refChordSheetSource,
      },
      {
        slug: 'reference/playground',
        title: '<Playground>',
        blurb:
          'One-component editor + preview + transpose embed.',
        source: refPlaygroundSource,
      },
      {
        slug: 'reference/editors',
        title: 'Editors',
        blurb:
          '<ChordEditor>, <SourceEditor>, chordProLanguage, chordProTagTable.',
        source: refEditorsSource,
      },
      {
        slug: 'reference/layout',
        title: 'Layout primitives',
        blurb: '<SplitLayout>, <RendererPreview>.',
        source: refLayoutSource,
      },
      {
        slug: 'reference/transpose',
        title: '<Transpose> + useTranspose',
        blurb:
          'Accessible ± / reset control + matching hook for arbitrary UIs.',
        source: refTransposeSource,
      },
      {
        slug: 'reference/chord-diagram',
        title: '<ChordDiagram> + useChordDiagram',
        blurb: 'Inline chord-voicing SVG renderer.',
        source: refChordDiagramSource,
      },
      {
        slug: 'reference/pdf-export',
        title: '<PdfExport> + usePdfExport',
        blurb:
          'Lazy-loaded PDF export button + hook for custom UIs.',
        source: refPdfExportSource,
      },
      {
        slug: 'reference/chord-source-edit',
        title: 'Chord source-edit helpers',
        blurb:
          'applyChordReposition, lyricsOffsetToSourceColumn — drag-to-edit primitives.',
        source: refChordSourceEditSource,
      },
      {
        slug: 'reference/ireal-components',
        title: 'iReal Pro components',
        blurb: '<IrealEditor>, <IrealPreview>, <IrealPlayground>.',
        source: refIrealComponentsSource,
      },
      {
        slug: 'reference/ireal-hooks',
        title: 'iReal Pro hooks',
        blurb:
          'useIrealParse, useIrealSerialize, useIrealRender.',
        source: refIrealHooksSource,
      },
      {
        slug: 'reference/ireal-helpers',
        title: 'iReal Pro AST helpers',
        blurb:
          'irealChord*ToString, irealCanonicalSymbolText, irealIs*.',
        source: refIrealHelpersSource,
      },
      {
        slug: 'reference/version',
        title: 'version()',
        blurb: 'Runtime version of the installed @chordsketch/react release.',
        source: refVersionSource,
      },
    ],
  },
];

/** Look up the {@link DocPage} for a given hash slug, or `null` if unknown. */
export function findPage(slug: string): DocPage | null {
  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
      if (page.slug === slug) return page;
    }
  }
  return null;
}

/** Build a flat list of every page in declaration order. */
export function allPages(): DocPage[] {
  const all: DocPage[] = [];
  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
      all.push(page);
    }
  }
  return all;
}
