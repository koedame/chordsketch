/**
 * Pure helpers extracted from `preview.tsx` for the WebView preview panel.
 *
 * Kept in a dedicated module so they can be unit-tested with plain Node
 * (`--experimental-transform-types`) without involving the React entry,
 * `createRoot`, or the WebView-only `acquireVsCodeApi` global. The
 * sibling `preview-helpers.ts` does the same for the extension-host
 * side; this is the WebView counterpart.
 *
 * Every function here is **pure** — no side effects, no reliance on the
 * `vscode` / `window` / `document` globals — so the test harness can
 * drive them with synthetic inputs and verify behaviour.
 */

/** Persisted panel state saved and restored via the VS Code WebView API. */
export interface PanelState {
  /** Semitone transposition offset; clamped to [-11, +11]. */
  transpose?: number;
  /**
   * URI string of the source document this panel is previewing.
   *
   * Written on first run so that VS Code's `WebviewPanelSerializer` can look
   * up the document when restoring the panel after a restart. See
   * `registerPreviewSerializer` in `../src/preview.ts`.
   */
  documentUri?: string;
}

/** Message types received from the extension host. */
export type ExtToWebview =
  | { type: 'update'; text: string }
  | { type: 'transpose'; delta: 1 | -1 };

/**
 * Type guard for messages received from the extension host.
 *
 * Validates the shape of `event.data` before field access so that unknown
 * or malformed messages are silently ignored rather than causing TypeErrors.
 */
export function isExtToWebview(raw: unknown): raw is ExtToWebview {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (r['type'] === 'update') {
    return typeof r['text'] === 'string';
  }
  if (r['type'] === 'transpose') {
    return r['delta'] === 1 || r['delta'] === -1;
  }
  return false;
}

/**
 * Formats a thrown value into a readable error message.
 *
 * Prefers `.message` from Error instances to avoid `[object Object]` on
 * structured JsError objects with line/col info.
 */
export function formatError(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

/** Clamps `n` into the inclusive `[lo, hi]` range. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Returns a validated copy of the persisted WebView state.
 *
 * The caller supplies `raw` (typically the result of
 * `vscode.getState()`); this function narrows that `unknown` value to a
 * well-typed `PanelState` with each field individually validated, so a
 * corrupted or forward-incompatible stored value cannot bypass type-level
 * checks.
 *
 * Invalid individual fields are silently dropped — they re-resolve to the
 * caller's default (`0` for transpose).
 * Callers that need to surface a "corrupt state was dropped" signal to the
 * user should use [`safeGetStateWithDiagnostics`] instead.
 */
export function safeGetState(raw: unknown): PanelState {
  const obj = isPlainObject(raw) ? raw : null;
  const result: PanelState = {};
  if (typeof obj?.['transpose'] === 'number' && Number.isFinite(obj['transpose'])) {
    result.transpose = clamp(obj['transpose'] as number, -11, 11);
  }
  if (typeof obj?.['documentUri'] === 'string' && (obj['documentUri'] as string).length > 0) {
    result.documentUri = obj['documentUri'] as string;
  }
  return result;
}

/**
 * Variant of [`safeGetState`] that also reports whether the input was
 * non-null but contributed zero validated fields — i.e. a corrupt
 * persisted state. The caller uses the `corrupt` flag to decide whether
 * to post a notification to the extension host.
 *
 * `raw === null` / `raw === undefined` is treated as "no prior state"
 * (not corrupt) so first-run mounts do not generate false-positive
 * warnings.
 */
export function safeGetStateWithDiagnostics(
  raw: unknown,
): { state: PanelState; corrupt: boolean } {
  const state = safeGetState(raw);
  const present = raw !== null && raw !== undefined;
  const empty = state.transpose === undefined && state.documentUri === undefined;
  return { state, corrupt: present && empty };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
