"use client";

// The Daily Ritual (issue #133): a "today, so far" status rail over the
// day's three beats, and the plain-text recap a finished day can be copied
// out as.
//
// **Placement follows issue #122's standing decision**, like the two
// mechanics it summarises: a self-contained section mounted as a direct
// child of ResultsPage's column, above ResultsPanel's own fetch gate, so a
// slow or failing /api/results leaves the ritual intact. It takes only the
// already-computed headline figure (plus the range/mode that figure belongs
// to) -- never a `PrecomputedResult` -- so there is nothing here to
// recompute and nothing to drift from the page's own number.
//
// All state is read, never mirrored: see lib/use-daily-ritual.ts.

import { useId, useMemo, useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import {
  RECAP_LOCKED_DETAIL,
  RECAP_LOCKED_HEADLINE,
  benchRecapClause,
  buildRecapText,
  callsState,
  isRecapUnlocked,
  stepsDone,
  type RitualStepState,
} from "@/lib/daily-ritual";
import { copyText } from "@/lib/copy-text";
import type { HeadlineFigure } from "@/lib/headline-figure";
import type { Mode } from "@/lib/mode";
import { useDailyRitual } from "@/lib/use-daily-ritual";

/**
 * The rail's three states, each with a **glyph as well as a colour**.
 *
 * WCAG 1.4.1: done/partial/not-yet must be tellable apart without relying
 * on hue, and a border colour alone doesn't do it (the same rule issue
 * #129's history strip already follows for its four outcomes -- see
 * `OUTCOME_STYLES` there). Every rail item therefore carries the glyph, a
 * word for its state, and the colour, not just the last of those.
 */
const STEP_STYLES: Record<RitualStepState, { glyph: string; colorClassName: string }> = {
  // Gold is --accent-reward's documented job (globals.css, issue #121):
  // earned state only. A finished step of the day's ritual is exactly that.
  done: { glyph: "✓", colorClassName: "text-[var(--accent-reward)]" },
  partial: { glyph: "◐", colorClassName: "text-[var(--text-secondary)]" },
  todo: { glyph: "○", colorClassName: "text-[var(--text-muted)]" },
};

interface DailyRitualProps {
  /** The active preset range, or `null` in custom start-date anchor mode. */
  range: PresetRange | null;
  mode: Mode;
  /** What the results page is headlining right now, or `null` while the result hasn't loaded (see lib/headline-figure.ts). */
  headline: HeadlineFigure | null;
}

export function DailyRitual({ range, mode, headline }: DailyRitualProps) {
  const headingId = useId();
  const { snapshot, hydrated } = useDailyRitual({ range, mode, headline });

  const recap = useMemo(() => buildRecapText(snapshot), [snapshot]);
  const unlocked = isRecapUnlocked(snapshot);

  const callsStepState = callsState(snapshot.calls);
  const benchStepState: RitualStepState = snapshot.bench === null ? "todo" : "done";

  return (
    <section
      aria-labelledby={headingId}
      className="surface-card flex flex-col gap-5 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id={headingId}
          className="font-display text-lg font-semibold text-[var(--text-primary)]"
        >
          Today, so far
        </h2>
        {/* The count is deliberately never "0 of 3": the reveal is already
            behind you the moment you arrive (see DailyRitualSnapshot's
            heroSeen doc comment for why that's the point, not a bug). */}
        <p className="font-numeric text-sm tabular-nums text-[var(--text-muted)]">
          {hydrated ? `${stepsDone(snapshot)} of 3 done` : " "}
        </p>
      </header>

      <ol className="flex flex-col gap-2">
        <RailItem
          state="done"
          label="The reveal"
          detail="You've seen what hindsight would have made."
        />
        <RailItem
          state={benchStepState}
          label="Beat the Bench"
          detail={
            snapshot.bench === null
              ? "Not played yet today."
              : `Played -- ${benchRecapClause(snapshot.bench.session)}.`
          }
        />
        <RailItem
          state={callsStepState}
          label="The Call Board"
          detail={`${snapshot.calls.filled} of ${snapshot.calls.total} upcoming sessions called.`}
        />
      </ol>

      {unlocked && recap !== null ? (
        <RecapPanel recap={recap} />
      ) : (
        <div className="flex flex-col gap-1 rounded-md border border-dashed border-[var(--gridline)] bg-[var(--surface-2)] px-4 py-4">
          <p className="text-sm font-medium text-[var(--text-primary)]">{RECAP_LOCKED_HEADLINE}</p>
          <p className="text-sm text-[var(--text-muted)]">{RECAP_LOCKED_DETAIL}</p>
        </div>
      )}
    </section>
  );
}

function RailItem({
  state,
  label,
  detail,
}: {
  state: RitualStepState;
  label: string;
  detail: string;
}) {
  const style = STEP_STYLES[state];
  return (
    <li className="flex items-start gap-3">
      {/* aria-hidden because the visible text below already carries the
          whole meaning -- the glyph is the *sighted* reader's non-colour
          cue, not a second thing to announce. */}
      <span
        aria-hidden="true"
        data-step-state={state}
        className={`flex min-h-6 min-w-6 items-center justify-center rounded-full border border-current text-xs leading-none ${style.colorClassName}`}
      >
        {style.glyph}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
        <span className="text-sm text-[var(--text-secondary)]">{detail}</span>
      </span>
    </li>
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
