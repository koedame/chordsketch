import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// `docs/sdk/tasks/embed-react.md` promises that its recipes work when
// pasted into a fresh app. Nothing compiled them, so they drifted from
// the package: Recipe 1 seeded `<ChordProEditor>` through a prop it
// ignores, and Recipe 7 read `.message` off the `string[]` that
// `useChordproAst` returns for `warnings`, so a paste failed `tsc`.
// These tests compile every `tsx` fence on that page against the
// package source, so a rename or a type change that breaks a recipe
// fails here instead of in a reader's editor.

const here = dirname(fileURLToPath(import.meta.url));
const RECIPES_PATH = resolve(here, '../../../docs/sdk/tasks/embed-react.md');
const TSCONFIG_PATH = resolve(here, '../tsconfig.json');
const PACKAGE_ENTRY = resolve(here, '../src/index.ts');
const VIRTUAL_ROOT = resolve(here, '../.recipes');

interface Recipe {
  /** Virtual path the fence is compiled at. */
  path: string;
  source: string;
}

/**
 * Every `tsx` fence on the page. A fence whose first line is a
 * `// some/path.tsx` comment is placed at that path, so the Next.js
 * recipe's `page.tsx` can import its sibling `./sheet`.
 */
function extractRecipes(markdown: string): Recipe[] {
  const out: Recipe[] = [];
  const fence = /```tsx\n([\s\S]*?)```/g;
  for (const [, source] of markdown.matchAll(fence)) {
    const named = /^\/\/ (\S+\.tsx)\n/.exec(source);
    const path = resolve(VIRTUAL_ROOT, named ? named[1] : `recipe-${out.length + 1}.tsx`);
    out.push({ path, source });
  }
  return out;
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(TSCONFIG_PATH));
  return {
    ...parsed.options,
    noEmit: true,
    paths: {
      ...parsed.options.paths,
      // Resolve the package name the way a consumer writes it, but to
      // the working tree rather than a published build.
      '@chordsketch/react': [PACKAGE_ENTRY],
    },
  };
}

function diagnose(recipes: Recipe[]): string[] {
  const options = loadCompilerOptions();
  const files = new Map(recipes.map((r) => [r.path, r.source]));
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (name) => files.get(name) ?? readFile(name);
  host.fileExists = (name) => files.has(name) || fileExists(name);
  const directoryExists = host.directoryExists?.bind(host) ?? ts.sys.directoryExists;
  host.directoryExists = (name) =>
    [...files.keys()].some((f) => f.startsWith(`${name}/`)) || directoryExists(name);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const text = files.get(name);
    return text !== undefined
      ? ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.TSX)
      : getSourceFile(name, languageVersion, onError, shouldCreate);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return recipes.flatMap((r) =>
    ts
      .getPreEmitDiagnostics(program, program.getSourceFile(r.path))
      .map((d) => {
        const where =
          d.file && d.start !== undefined
            ? `${d.file.fileName.replace(`${VIRTUAL_ROOT}/`, '')}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
            : r.path;
        return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
      }),
  );
}

describe('embed-react.md recipes', () => {
  const recipes = extractRecipes(readFileSync(RECIPES_PATH, 'utf8'));

  test('when the page is read, every recipe has a tsx fence to compile', () => {
    // Ten recipes, and the Next.js one is two files.
    expect(recipes.length).toBeGreaterThanOrEqual(11);
  });

  test('when every tsx fence is compiled against the package source, none reports a type error', () => {
    expect(diagnose(recipes)).toEqual([]);
  });

  // Negative controls: the check above is only worth something if a
  // broken paste actually fails it. Each reintroduces a bug the page
  // shipped with.
  test.each([
    [
      'reads `.message` off a warning string',
      '{w}',
      '{w.message}',
      /Property 'message' does not exist on type 'string'/,
    ],
    [
      'seeds <ChordProEditor> through `defaultValue`',
      '<ChordProEditor defaultSource=',
      '<ChordProEditor defaultValue=',
      /Property 'defaultValue' does not exist/,
    ],
  ])('when a recipe %s, the compile reports it', (_, from, to, expected) => {
    const broken = recipes.map((r) =>
      r.source.includes(from) ? { ...r, source: r.source.replace(from, to) } : r,
    );
    expect(broken.some((r, i) => r.source !== recipes[i].source)).toBe(true);
    expect(diagnose(broken).join('\n')).toMatch(expected);
  });
});
