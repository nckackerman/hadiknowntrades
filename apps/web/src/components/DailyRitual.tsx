"use client";

// The Daily Ritual (issue #133, condensed by issue #186): a single-line
// shareable-recap disclosure -- locked until Beat the Bench has been
// played today, unlocked to the same recap content this file always
// rendered once it has.
//
// **The always-visible "Today, so far" status rail is gone** (the
// header, the "N of 3 done" counter, and the <ol> of rail items). It
// mostly repeated information the two game cards already render
// themselves -- BeatTheBench.tsx's CompactCard already says "Not played
// yet today"; CallBoard.tsx's CallBoardSummaryRow already says "N of 3
// called this week" -- so that status now lives as a small corner badge
// on each card instead, built from lib/daily-ritual.ts's own
// `STEP_STYLES`, promoted there for exactly this reuse. See
// docs/design/daily-hub-condensed-2026-08 for the design reference this
// issue implements.
//
// **Placement follows issue #122's standing decision**, like the two
// mechanics it summarises: a self-contained section mounted as a direct
// child of ResultsPage's column, above ResultsPanel's own fetch gate, so
// a slow or failing /api/results leaves the ritual intact. It takes only
// the already-computed headline figure (plus the range/mode that figure
// belongs to) -- never a `PrecomputedResult` -- so there is nothing here
// to recompute and nothing to drift from the page's own number.
//
// All state is read, never mirrored: see lib/use-daily-ritual.ts.

import { useId, useMemo, useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import {
  RECAP_LOCKED_DETAIL,
  RECAP_LOCKED_HEADLINE,
  RECAP_UNLOCKED_HEADLINE,
  STEP_STYLES,
  buildRecapText,
  isRecapUnlocked,
} from "@/lib/daily-ritual";
import { copyText } from "@/lib/copy-text";
import type { HeadlineFigure } from "@/lib/headline-figure";
import type { Mode } from "@/lib/mode";
import { useDailyRitual } from "@/lib/use-daily-ritual";

interface DailyRitualProps {
  /** The active preset range, or `null` in custom start-date anchor mode. */
  range: PresetRange | null;
  mode: Mode;
  /** What the results page is headlining right now, or `null` while the result hasn't loaded (see lib/headline-figure.ts). */
  headline: HeadlineFigure | null;
}

export function DailyRitual({ range, mode, headline }: DailyRitualProps) {
  const headingId = useId();
  const { snapshot } = useDailyRitual({ range, mode, headline });

  const recap = useMemo(() => buildRecapText(snapshot), [snapshot]);
  const unlocked = isRecapUnlocked(snapshot);

  return (
    <section aria-labelledby={headingId}>
      {/* A stable, sr-only landmark heading -- mirroring CallBoard.tsx's
          own `<h2 id="call-board-heading">` (issue #164): this section's
          identity/testability shouldn't depend on which of the two
          summary lines below happens to be showing. Deliberately new
          text, not "Today, so far" relocated to sr-only -- that string
          no longer exists anywhere in this component's rendered output,
          per this issue's own acceptance criteria. */}
      <h2 id={headingId} className="sr-only">
        Today&apos;s ritual
      </h2>

      <details className="surface-card rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
          <span className="flex items-center gap-2">
            {/* Reuses STEP_STYLES.done for the unlocked glyph -- the
                identical filled-gold-circle treatment the two game
                cards' own corner badges use for exactly the same
                "earned" state, per globals.css's --accent-reward
                decision record (issue #121). The locked glyph has no
                equivalent in STEP_STYLES (that vocabulary has nothing
                to say about "not started yet" beyond "render nothing",
                which doesn't fit a summary line that always needs
                *something* to show), so it's a small outlined circle
                defined here instead. */}
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                unlocked
                  ? STEP_STYLES.done.colorClassName
                  : "border border-[var(--gridline)] text-[var(--text-muted)]"
              }`}
            >
              {unlocked ? STEP_STYLES.done.glyph : "🔒"}
            </span>
            <span
              className={`text-sm ${
                unlocked
                  ? "font-semibold text-[var(--text-primary)]"
                  : "font-medium text-[var(--text-muted)]"
              }`}
            >
              {unlocked ? RECAP_UNLOCKED_HEADLINE : RECAP_LOCKED_HEADLINE}
            </span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-xs text-[var(--text-muted)]">
            ▸
          </span>
        </summary>

        <div className="flex flex-col gap-3 px-4 pb-4">
          {unlocked && recap !== null ? (
            <RecapPanel recap={recap} />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">{RECAP_LOCKED_DETAIL}</p>
          )}
        </div>
      </details>
    </section>
  );
}

/**
 * The unlocked recap: the real text, a copy button, and -- always, not only
 * after a failure -- the text itself in a read-only textarea.
 *
 * The textarea is the manual-select fallback *and* the honest preview: a
 * recap you're about to hand someone shouldn't be invisible until it's on
 * your clipboard, and a browser that refuses the Clipboard API (a
 * non-secure context, a denied permission, an embedded webview) then needs
 * no separate escape hatch to appear -- the thing to select is already on
 * screen, and the failure message just says so.
 */
function RecapPanel({ recap }: { recap: string }) {
  const labelId = useId();
  // **The copied text, not a bare "copied" flag.** A confirmation is about
  // one exact recap, so it must not outlive it: replaying Beat the Bench or
  // changing a Call Board pick rewrites `recap`, and a stale "Copied" stamp
  // would then claim a recap is on the clipboard while a different one is
  // on screen. Comparing the stored text against the current one during
  // render drops the stamp exactly when the text changes, with no effect to
  // keep in sync (and no `react-hooks/set-state-in-effect` cascade).
  const [copyResult, setCopyResult] = useState<{ text: string; ok: boolean } | null>(null);
  const copyState =
    copyResult === null || copyResult.text !== recap ? "idle" : copyResult.ok ? "copied" : "failed";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={labelId} className="text-sm font-medium text-[var(--text-primary)]">
          Today&apos;s recap
        </h3>
        <p className="text-xs text-[var(--text-muted)]">
          Plain text, ready to paste. No spoilers for anyone else&apos;s session.
        </p>
      </div>

      {/* A <pre>, not a <textarea>, and that is a real fix rather than a
          preference: a textarea has to be given a row count, and at 390px
          every recap line wraps, so a count derived from the text's own
          newlines clipped the last line mid-word behind an inner scrollbar
          (seen at 390px, not theorised). This sizes to its content at every
          width and can't clip. `select-all` keeps it a genuine manual
          fallback -- one click selects the whole recap, which is more than
          a textarea's drag-select offered anyway. */}
      <pre
        aria-labelledby={labelId}
        data-testid="daily-recap-text"
        className="w-full select-all rounded-md border border-[var(--gridline)] bg-[var(--surface-2)] px-3 py-2 font-numeric text-xs leading-relaxed break-words whitespace-pre-wrap text-[var(--text-secondary)]"
      >
        {recap}
      </pre>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void copyText(recap).then((ok) => setCopyResult({ text: recap, ok }));
          }}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--accent-selection)] px-4 text-sm font-semibold text-white"
        >
          Copy recap
        </button>
        {/* Always mounted, never conditionally rendered alongside the thing
            it announces -- the same live-region idiom issue #67 established
            and issue #129's board status region follows. */}
        <p
          role="status"
          aria-live="polite"
          className={`text-sm ${copyState === "failed" ? "text-[var(--status-critical)]" : "text-[var(--accent-reward)]"}`}
        >
          {copyState === "copied"
            ? "Copied to your clipboard."
            : copyState === "failed"
              ? "Your browser wouldn't let us reach the clipboard -- select the text above and copy it yourself."
              : ""}
        </p>
      </div>
    </div>
  );
}
