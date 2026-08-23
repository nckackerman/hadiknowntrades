// Long-only vs. long+short display mode (issue #13) -- which of a
// result's two computed variants (WindowResult/IntradayDayResult's own
// long-only fields, or their sibling `longShort` field, both computed by
// the pipeline every run -- see packages/core's results-schema.ts) is
// currently shown. Owned as URL state (`?mode=`) by ResultsPage.tsx, the
// same pattern `?range=`/`?day=` already use there -- see this file's own
// header note in ResultsPage.tsx for why this is shareable/bookmarkable
// content state rather than a personal display preference like starting
// capital (use-starting-capital.ts, a localStorage-persisted value).

export const MODES = ["long", "long-short"] as const;

export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = "long";

/**
 * Human-readable label per mode -- the single shared copy `ModeToggle.tsx`'s
 * pill buttons and `ResultsPanel.tsx`'s reveal aria-live announcement
 * (issue #67) both read, so the two surfaces can't drift on how a mode
 * is named. `ModeToggle.tsx` used to keep its own private copy of this
 * exact map before issue #67 needed the same labels for its own copy
 * (found in code review) -- extracted here rather than letting a second
 * component grow a second copy.
 */
export const MODE_LABELS: Record<Mode, string> = {
  long: "Long only",
  "long-short": "Long + short",
};

/**
 * Case-insensitively matches a raw query-string value against MODES, or
 * returns null if it doesn't match either -- mirrors results-api.ts's own
 * `parseRange`. A missing or unrecognized `?mode=` falls back to
 * `DEFAULT_MODE` (long-only) at the call site, so an existing shared link
 * with no `mode` param keeps showing exactly what it showed before this
 * mode toggle existed.
 */
export function parseMode(raw: string | null): Mode | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return (MODES as readonly string[]).includes(lower) ? (lower as Mode) : null;
}
