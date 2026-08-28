"use client";

// Beat the Bench (issues #131, #132): a playable, real-time ticking-chart
// buy/sell game against this app's own SPY benchmark.
//
// **Placement and ownership follow issue #122's standing decision** (see
// apps/web/CLAUDE.md's "Page structure"): this is a self-contained
// *section*, mounted as a direct child of ResultsPage's column, not a
// route and not a branch inside ResultsPanel. It takes no
// PrecomputedResult/range/mode/selectedDay props -- the game is not a
// function of the hindsight result, and staying independent of it is
// what lets the daily ritual stay playable while /api/results is slow or
// failing (a routinely-hit state locally, and a real operational one).
//
// **The voice is this app's, not the mechanic's source.** Beat the
// Couch, which this mechanic is adapted from, taunts the player. Every
// string here is written in narrate-trades.ts's register instead --
// wistful, earnest, second person, never mocking. See
// `outcomeHeadline`/`outcomeDetail` in lib/beat-the-bench.ts for the
// settlement copy and the reasoning behind "along for the ride".
//
// Two modes, and they are the *same* game (issue #132):
//
//   - **Today's Close** replays the most recently closed session, and
//     says which day it is up front.
//   - **Mystery Day** replays a random session from the published pool
//     and does not. Its real date exists in exactly one place on the
//     server (issue #127's `results/mystery-index.json`) and reaches the
//     client only through a request this component does not make until
//     the session has genuinely settled -- see `SessionGame`'s own note.
//
// Both play through the identical `beat-the-bench.ts` engine, unchanged:
// the mystery half is a different *payload*, not a different mechanic.
// Weekly/monthly modes remain backlog.
//
// **Collapsed by default (issue #163), and collapsible again (a later
// design pass).** This section used to render the mode chooser (and,
// once a mode was picked, the game itself) the moment it mounted -- a
// full, always-rendered game rather than an immediate call-to-action. It
// now renders a compact "Can you do better?" card (`CompactCard`, an
// icon, the exact mockup copy, and a status line built from
// `beat-the-bench-storage.ts`'s existing read) until that card is
// clicked, at which point it expands *in place* to the exact same
// chooser/playback/settlement experience this file always rendered --
// unchanged in substance, per issue #163's own scope. A "Collapse" control
// in `BeatTheBenchFrame`'s own header (present at every expanded state --
// the mode chooser, mid-game, settlement) flips it back, mirroring how
// The Call Board's own `<details>`/`<summary>` stays clickable and
// collapsible after opening. Unlike The Call Board, this stays a plain
// `useState` toggle rather than a native `<details>`: the content behind
// it is a stateful game (fetches, a running playback interval), and
// collapsing deliberately *unmounts* it -- via the same `expanded ===
// false` branch that renders `CompactCard` -- rather than merely hiding
// it the way a closed `<details>` would (which keeps its children
// mounted, `display: none`'d, with any interval still silently ticking
// underneath). Collapsing also resets `mode` back to `null`, so
// re-expanding always starts from the mode chooser rather than resuming
// stale mid-game state. This is purely a presentational/mounting change:
// `useTodaysCloseSession` is still called unconditionally at the top of
// this component regardless of collapsed state (so the fetch-on-mount
// behaviour this file's own Judgment-calls section already documents is
// untouched), and the Mystery Day zero-request-before-settlement rule
// above is completely orthogonal to whether the card is collapsed or
// expanded -- it depends only on `settled`, never on this `expanded`
// flag.
//
// **Issue #186's condensation**: `CompactCard` gained a small corner
// status badge (`done` once today's session has been played, nothing
// otherwise -- see its own doc comment) built from
// `lib/daily-ritual.ts`'s own `STEP_STYLES`, shared with The Call
// Board's identical badge. This replaces what used to be a separate,
// always-visible "Today, so far" status rail above every mechanic
// (`DailyRitual.tsx`) -- see that file's own doc comment.

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import type { SessionBar } from "@hadiknowntrades/core";

import {
  balanceAtBar,
  DEFAULT_SPEED,
  gapPhrase,
  isPlayableSession,
  outcomeDetail,
  outcomeHeadline,
  PLAYBACK_SPEEDS,
  positionAfterBar,
  positionsThroughBar,
  sessionDurationMs,
  settleSession,
  STARTING_CAPITAL,
  tickIntervalMs,
  type PlaybackSpeed,
  type Settlement as SessionSettlement,
} from "@/lib/beat-the-bench";
import { biggestMissedMove, missedMoveSentence, topUpMoves } from "@/lib/beat-the-bench-moves";
import {
  comparePercentile,
  mulberry32,
  percentilePhrase,
  seedFromBars,
} from "@/lib/beat-the-bench-percentile";
import {
  readPlayedSession,
  savePlayedSession,
  type BeatTheBenchMode,
  type PlayedSession,
} from "@/lib/beat-the-bench-storage";
import { STATUS_BADGE_CLASSNAME, STEP_STYLES } from "@/lib/daily-ritual";
import { formatDate, formatTime } from "@/lib/format-date";
import { formatHeroCurrency, formatSessionPercent } from "@/lib/format-currency";
import { useReducedMotionAfterMount } from "@/lib/use-reduced-motion-after-mount";
import { useMysteryReveal, useMysterySession } from "@/lib/use-mystery-session";
import { useTodaysCloseSession } from "@/lib/use-todays-close-session";
import { BeatTheBenchChart } from "@/components/BeatTheBenchChart";

/** Every control in the playback row shares this: >= 44px in both directions at any width (`min-h-11`/`min-w-11` are 44px), per issue #131's touch-target criterion. The row wraps rather than shrinking these. */
const CONTROL_CLASS =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--gridline)] px-3 text-sm font-medium";

/**
 * The compact tile's own gradient stops (issue #176), named as constants
 * rather than left as literals inline in `CompactCard`'s own `style`
 * prop -- so `CONNECTOR_ACCENT` below (issue #195's expanded-panel
 * connector) can read the real darkest stop directly instead of a
 * hand-copied second literal that could drift from it. Safe to build the
 * gradient string *from* these constants (unlike CallBoard.tsx's own
 * `CARD_CLASSNAME`, a Tailwind bracket-value class): this gradient was
 * already a plain inline `style` string, not a Tailwind utility, so
 * there's no build-time content-scanner constraint here.
 */
const BENCH_TILE_GRADIENT_STOPS = ["#f0b658", "#e8a33d", "#d88f28"] as const;
const BENCH_TILE_GRADIENT = `linear-gradient(155deg, ${BENCH_TILE_GRADIENT_STOPS[0]} 0%, ${BENCH_TILE_GRADIENT_STOPS[1]} 55%, ${BENCH_TILE_GRADIENT_STOPS[2]} 100%)`;

/**
 * Connecting the expanded frame back to the tile that opened it (issue
 * #195): the same darkest gradient stop the collapsed tile fills with,
 * reused for the expanded panel's own 4px top border and icon-plate
 * wash. Beat the Bench's tile fully unmounts on expand (see
 * `BeatTheBench`'s own top-of-file note -- a plain `useState` toggle,
 * not a `<details>`), so unlike CallBoard.tsx there's no flush-seam
 * device to add here -- just the border + icon plate, applied to
 * `BeatTheBenchFrame`'s own root below.
 */
const CONNECTOR_ACCENT = BENCH_TILE_GRADIENT_STOPS[2];

/**
 * One session the game can actually be played on, whichever mode
 * produced it -- the shape `SessionGame` works from, so the mechanic
 * itself has no idea which mode it is running.
 *
 * `date` is the whole difference between the two modes. Today's Close
 * carries its real date; Mystery Day carries `null` and an opaque
 * `sessionId` instead, and there is nothing in its `bars` to reconstruct
 * a date from either (issue #127's payloads are labelled by time of day
 * only, enforced at write time by a scan of the serialized object).
 */
interface PlayableSession {
  mode: BeatTheBenchMode;
  ticker: string;
  barIntervalMinutes: number;
  bars: readonly SessionBar[];
  /** The real trading date, when the mode publishes it up front. `null` for Mystery Day, until settlement. */
  date: string | null;
  /** The opaque pool slot this session came from -- Mystery Day only. What the reveal is asked for, at settlement and not before. */
  sessionId: string | null;
  /** The pool manifest's run stamp at the moment this session was picked -- Mystery Day only. Compared against the reveal's own stamp to catch a pool rotation mid-play. */
  poolGeneratedAt: string | null;
}

type ChosenMode = BeatTheBenchMode | null;

/** The one shared derivation of "is there a playable Today's Close session, and what is it" -- used by the compact card (its status line needs the session's own date), the mode chooser, and the game itself. Hoisted so all three read the identical check rather than each re-deriving it (a real duplication this file carried before issue #163). */
function playableTodaysClose(state: ReturnType<typeof useTodaysCloseSession>): {
  ticker: string;
  date: string;
  barIntervalMinutes: number;
  bars: readonly SessionBar[];
} | null {
  return state !== null && state.status === "success" && isPlayableSession(state.data)
    ? state.data
    : null;
}

export function BeatTheBench() {
  const headingId = useId();
  const reducedMotion = useReducedMotionAfterMount();

  // Collapsed by default (issue #163) -- see this file's own top-of-file
  // note. Nothing below this flag's declaration changed in substance from
  // before that issue; it only decides whether any of it renders yet.
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<ChosenMode>(null);
  // Bumped to ask for *another* random day. It rides in the mystery
  // fetch's URL (see useMysterySession) because the shared fetch state
  // machine refetches on URL change and nothing else.
  const [pick, setPick] = useState(0);

  const todaysCloseState = useTodaysCloseSession();
  const mysteryState = useMysterySession(mode === "mystery" ? pick : null);
  const todaysClose = playableTodaysClose(todaysCloseState);

  // Collapses the whole section back to the compact card -- see this
  // file's own top-of-file note on why this unmounts (via the `expanded
  // === false` branch below) rather than merely hiding, unlike The Call
  // Board's own collapse. Resetting `mode` here (rather than leaving it
  // set for a future re-expand) keeps re-expanding always land on the
  // mode chooser, never resumed mid-game state a viewer might not
  // recognize.
  function handleCollapse() {
    setExpanded(false);
    setMode(null);
  }

  if (!expanded) {
    return (
      <CompactCard
        headingId={headingId}
        todaysCloseDate={todaysClose?.date ?? null}
        onExpand={() => setExpanded(true)}
      />
    );
  }

  if (mode === null) {
    return (
      <BeatTheBenchFrame headingId={headingId} onCollapse={handleCollapse}>
        <ModeChooser
          todaysClose={todaysClose}
          todaysCloseLoading={todaysCloseState === null || todaysCloseState.status === "loading"}
          reducedMotion={reducedMotion}
          onChoose={setMode}
        />
      </BeatTheBenchFrame>
    );
  }

  if (mode === "todays-close") {
    const session = todaysClose;
    if (session === null) {
      return <BeatTheBenchFrame headingId={headingId} onCollapse={handleCollapse} />;
    }
    return (
      <BeatTheBenchFrame headingId={headingId} onCollapse={handleCollapse}>
        {/* Keyed on the session's own date so a fresh trading day starts a
            genuinely fresh game (state, stored-record read and all) rather
            than carrying yesterday's bar index into today's bars. */}
        <SessionGame
          key={`todays-close-${session.date}`}
          session={{
            mode: "todays-close",
            ticker: session.ticker,
            barIntervalMinutes: session.barIntervalMinutes,
            bars: session.bars,
            date: session.date,
            sessionId: null,
            poolGeneratedAt: null,
          }}
          reducedMotion={reducedMotion}
          onBack={() => setMode(null)}
        />
      </BeatTheBenchFrame>
    );
  }

  if (mysteryState === null || mysteryState.status === "loading") {
    return (
      <BeatTheBenchFrame headingId={headingId} onCollapse={handleCollapse}>
        <p className="text-sm text-[var(--text-muted)]">Picking a day out of the hat…</p>
      </BeatTheBenchFrame>
    );
  }

  if (mysteryState.status === "error" || !isPlayableSession(mysteryState.data.session)) {
    return (
      <BeatTheBenchFrame headingId={headingId} onCollapse={handleCollapse}>
        <p className="text-sm text-[var(--text-secondary)]">
          There&apos;s no mystery session to play right now. The pool is published by the nightly
          run, shortly after the close.
        </p>
        <BackToModesButton onBack={() => setMode(null)} />
      </BeatTheBenchFrame>
    );
  }

  const mystery = mysteryState.data;
  return (
    <BeatTheBenchFrame headingId={headingId} onCollapse={handleCollapse}>
      <SessionGame
        // Keyed on the pick counter as well as the slot id, so "play
        // another" always starts a genuinely fresh game -- including in
        // the case where the server happens to re-pick the same slot.
        key={`mystery-${pick}-${mystery.session.sessionId}`}
        session={{
          mode: "mystery",
          ticker: mystery.session.ticker,
          barIntervalMinutes: mystery.session.barIntervalMinutes,
          bars: mystery.session.bars,
          date: null,
          sessionId: mystery.session.sessionId,
          poolGeneratedAt: mystery.poolGeneratedAt,
        }}
        reducedMotion={reducedMotion}
        onBack={() => setMode(null)}
        onAnother={() => setPick((current) => current + 1)}
      />
    </BeatTheBenchFrame>
  );
}

function BeatTheBenchFrame({
  headingId,
  onCollapse,
  children,
}: {
  headingId: string;
  onCollapse: () => void;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      // Only ever rendered once BeatTheBench's own `expanded` flag is
      // true (issue #163) -- this marker attribute exists purely so the
      // 2-up grid wrapping both game cards (issue #178, ResultsPage.tsx)
      // can detect "this tile is showing its full real game, not the
      // compact CTA card" via a plain CSS `:has()` selector, without
      // lifting `expanded` state up into the parent. CallBoard needs no
      // equivalent marker -- its own expanded state is already a native
      // `<details open>`, directly selectable on its own.
      data-bench-expanded="true"
      // Connecting this expanded panel back to the tile that opened it
      // (issue #195, device #1): a 4px CONNECTOR_ACCENT-colored top
      // border, replacing the uniform 1px border on that one edge --
      // `border-x border-b` keeps the original `border-[var(--gridline)]`
      // color/width on the other three sides unchanged (review finding
      // #5), while `border-t-4` plus the inline `borderTopColor` below
      // override just the top edge. `rounded-lg` is kept on every
      // corner, including the top -- unlike CallBoard.tsx's own flush-
      // seam treatment, there's no tile left mounted above this panel to
      // flush against (see this file's own top-of-file note: the
      // compact tile fully unmounts on expand), so a fully-rounded panel
      // is the correct shape here, not a bug.
      className="surface-card flex flex-col gap-4 rounded-lg border-x border-b border-t-4 border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-4"
      style={{ borderTopColor: CONNECTOR_ACCENT }}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          {/* Icon plate + heading (issue #195, device #2): grouped into
              one sub-row so the pre-existing two-child `justify-between`
              layout (heading, "Collapse" button) is preserved -- this
              whole div is now the first child, the Collapse button stays
              the second (review finding #4). The icon echoes the
              collapsed tile's own 🎯, tinted with a ~15% wash of the
              same CONNECTOR_ACCENT the top border above uses. */}
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base"
              style={{ backgroundColor: `${CONNECTOR_ACCENT}26` }}
            >
              🎯
            </span>
            {/* font-display, matching CallBoard's and DailyRitual's own
                section headings (and this file's own settlement headline
                below) -- issue #121's type roles put headings on
                --font-display. It resolves to the same Geist Sans the body
                already inherits today, so this is a same-pixels consistency
                fix, not a visual change; it stops being a no-op the moment
                --font-display is ever pointed at a real display face. */}
            <h2
              id={headingId}
              className="font-display text-lg font-semibold text-[var(--text-primary)]"
            >
              Beat the Bench
            </h2>
          </div>
          {/* Collapses back to the compact card -- present at every
              expanded state (the mode chooser, mid-game, settlement),
              mirroring The Call Board's own always-clickable, collapsible
              `<summary>`. See this file's own top-of-file note on why
              this is a plain button rather than a native `<details>`.
              min-h-11/min-w-11 (44px) matches this app's own established
              touch-target floor (CONTROL_CLASS, below) even though this
              reads visually smaller than a bordered control. */}
          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ▾ Collapse
          </button>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          One real trading session, replayed close by close. You start with{" "}
          {formatHeroCurrency(STARTING_CAPITAL)}, already in the market -- exactly where the bench
          starts. Ride it out and you finish exactly where it does; step aside before a dip and you
          finish ahead.
        </p>
      </div>
      {children}
    </section>
  );
}

/**
 * The default, collapsed view (issue #163, restyled to a bold
 * NYT-Games-style tile by issue #176): an icon, the mockup's exact copy
 * ("Can you do better?" / "Play today's real session against the market,
 * live."), and a status line reusing `beat-the-bench-storage.ts`'s
 * existing `readPlayedSession` read -- the same read `ModeChooser`'s own
 * recap paragraph already does, not a new storage mechanism. Clicking the
 * whole card is what expands this section into the exact mode-chooser/
 * game/settlement experience this file always rendered -- see
 * `BeatTheBench`'s own top-level `expanded` flag.
 *
 * Deliberately a plain `<button>`, not a native `<details>`: unlike this
 * app's other expand-in-place disclosures ("More options," "View chart
 * data as a table"), the content behind this click is a stateful game
 * (fetches, playback intervals) this file's own Judgment-calls section
 * already documents as "fetched on mount, always". Expanding mounts
 * `BeatTheBenchFrame`, whose own header carries a "Collapse" control that
 * unmounts it again, back to this same card -- so the section is
 * clickable and collapsible either direction, matching The Call Board's
 * own `<details>`/`<summary>` behavior, just via a plain boolean toggle
 * instead of a native disclosure element (an unmount, not a `display:
 * none`, is what actually stops the game's own running interval once
 * collapsed).
 *
 * **Issue #176's restyle**: a thin-left-border-accent card became a
 * solid-fill amber gradient tile (`linear-gradient(155deg, #f0b658 0%,
 * #e8a33d 55%, #d88f28 100%)`, dark `#241a08` text), matching the design
 * mockup's `.game-tile.bench` (`docs/design/gamified-hero-2026-08/
 * mockup-gamified-hero.html`) as closely as this card's own layout
 * constraint allows -- see the deviation note below. The gradient/text
 * colors are hardcoded literals, not `--accent-reward`/other app tokens:
 * the mockup itself hardcodes these exact values rather than referencing
 * any CSS custom property, and this restyle is deliberately matching that
 * specific design, not inventing a new token-backed amber. Set via inline
 * `style` (not a Tailwind arbitrary-value class) for reliability -- a
 * gradient background-image is easy to get subtly wrong through Tailwind's
 * bracket-value parsing (space-to-underscore escaping, gradient- vs.
 * color-detection heuristics), and there is no test/reuse reason here that
 * needs it to be a class instead.
 *
 * **Contrast, computed (not eyeballed) against all three gradient stops**
 * (the WCAG relative-luminance formula, the same bar issue #123's
 * `--status-good`/`--status-critical` rebalance held itself to): `#241a08`
 * on `#f0b658` is 9.41:1, on `#e8a33d` is 7.94:1, and on the darkest stop
 * `#d88f28` -- the worst case, since a fixed dark foreground contrasts
 * least against a background's own lightest end -- is still 6.43:1,
 * comfortably clearing the 4.5:1 AA floor (and the 7:1 AAA floor for two
 * of the three stops).
 *
 * **Deliberate deviation from the mockup: no `aspect-ratio: 1 / 0.82`
 * (near-square) sizing.** The mockup's tile is designed for a future 2-up
 * grid (issue #176's own Out of scope explicitly defers that layout) --
 * forcing that aspect ratio onto today's still full-width, stacked
 * placement would stretch the tile to several hundred pixels tall at this
 * app's real `max-w-3xl` content width, which reads as broken, not bold.
 * The tile keeps the mockup's padding/radius/shadow/hover-lift and its
 * icon-title-subtitle-status layout, sized by its own content instead.
 *
 * **The corner status badge (issue #186)**: `done` once today's session
 * has been played, nothing rendered otherwise -- matching
 * `STEP_STYLES.todo`'s own established "render nothing" convention for
 * this pass (a recent win/loss/tie history strip, like The Call Board's
 * own, needs a new persisted-history storage mechanism this codebase
 * doesn't have yet -- see that issue's own Background section -- so
 * there's no "partial" state to show here, only done/todo). `relative`
 * on the button itself is what gives the badge's `absolute` positioning
 * (STATUS_BADGE_CLASSNAME) something to anchor to at the tile's own
 * corner, not the padded content inside it.
 *
 * **Icon plate + colored ambient glow (issue #188)**: the emoji now sits
 * inside a soft circular translucent plate (`bg-white/[0.16]`, the design
 * reference's own `.tile-icon-plate` value, sized to this app's own 44px
 * touch-target constant) with a small drop-shadow lift, and the tile's own
 * outer `shadow-[...]` gained a second, amber-tinted layer
 * (`rgba(232,163,61,0.35)`, this app's own `--accent-reward` value) ahead of
 * the pre-existing plain black drop shadow -- both layers render together in
 * one `box-shadow`, not a replacement of the original. Purely additive:
 * no gradient/layout/badge change from #176/#186.
 */
function CompactCard({
  headingId,
  todaysCloseDate,
  onExpand,
}: {
  headingId: string;
  todaysCloseDate: string | null;
  onExpand: () => void;
}) {
  const [playedRecord, setPlayedRecord] = useState<PlayedSession | null>(null);

  // Deferred to a post-mount microtask, never read synchronously during
  // render: this section renders on the server (issue #122 mounts it at
  // the ResultsPage level), so a synchronous storage read here would make
  // the hydration render disagree with the server's -- the identical
  // shape `ModeChooser`'s own read (below) already uses.
  useEffect(() => {
    if (todaysCloseDate === null) return;
    queueMicrotask(() => setPlayedRecord(readPlayedSession(todaysCloseDate, "todays-close")));
  }, [todaysCloseDate]);

  return (
    <section aria-label="Beat the Bench">
      <button
        type="button"
        onClick={onExpand}
        style={{
          backgroundImage: BENCH_TILE_GRADIENT,
          color: "#241a08",
        }}
        className="relative flex w-full flex-col gap-4 rounded-2xl px-[1.15rem] py-[1.1rem] text-left shadow-[0_8px_22px_rgba(232,163,61,0.35),0_6px_18px_rgba(0,0,0,0.35)] transition-transform duration-150 ease-out hover:-translate-y-0.5 hover:scale-[1.015] active:translate-y-0 active:scale-[0.99]"
      >
        {playedRecord !== null && (
          // aria-hidden: the compact status line below already conveys
          // this same "played" fact in full, readable text -- this badge
          // is a purely visual at-a-glance duplicate of it.
          <span
            aria-hidden="true"
            className={`${STATUS_BADGE_CLASSNAME} ${STEP_STYLES.done.colorClassName}`}
          >
            {STEP_STYLES.done.glyph}
          </span>
        )}
        <div className="flex flex-col gap-1">
          {/* Icon plate (issue #188): a soft circular translucent backdrop
              behind the emoji, matching the design reference's own
              `.tile-icon-plate` -- 2.75rem (44px, this app's own established
              touch-target size, CONTROL_CLASS above) housing the existing
              1.75rem emoji, with the same subtle drop-shadow the reference
              gives the icon itself for a little lift off the plate. */}
          <span
            aria-hidden="true"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.16]"
          >
            <span className="text-[1.75rem] leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
              🎯
            </span>
          </span>
          <span
            id={headingId}
            className="font-display text-[1.0625rem] font-extrabold tracking-[-0.01em] leading-[1.15]"
          >
            Can you do better?
          </span>
          <span className="text-xs font-medium opacity-85">
            Play today&apos;s real session against the market, live.
          </span>
        </div>
        <span className="font-numeric self-start rounded-full bg-black/[14%] px-[0.55rem] py-[0.2rem] text-[0.6875rem] font-bold">
          {compactStatusLine(playedRecord)}
        </span>
      </button>
    </section>
  );
}

/**
 * The compact card's status line -- reuses `beat-the-bench-storage.ts`'s
 * existing read (issue #163's own scope), never a second storage
 * mechanism.
 *
 * Mirrors `gapPhrase`'s own thresholds (above) rather than calling it:
 * that function writes a full settlement-card sentence ("0.13% behind
 * the bench."), and this needs a short standalone line for a card
 * that's collapsed by default -- the same "same numbers, different
 * sentence shape" precedent `lib/daily-ritual.ts`'s `benchGapClause`
 * already establishes for this identical figure.
 */
function compactStatusLine(record: PlayedSession | null): string {
  if (record === null) return "Not played yet today";
  const { playerBalance, benchmarkBalance } = record;
  if (playerBalance === benchmarkBalance) return "Level with the bench today";
  const gap = playerBalance / benchmarkBalance - 1;
  const direction = gap > 0 ? "ahead of" : "behind";
  const magnitude = Math.abs(gap);
  const magnitudeText =
    magnitude < 0.00005 ? "Less than 0.01%" : `${(magnitude * 100).toFixed(2)}%`;
  return `${magnitudeText} ${direction} the bench today`;
}

/**
 * The two mode cards.
 *
 * Issue #131 deliberately built its single-card chooser as a *list* of
 * mode cards so that this issue would add a card rather than a layout;
 * that held, and this is the same list with a second entry.
 *
 * **The Mystery Day card names no date, and cannot.** Nothing is fetched
 * for that mode until it is chosen (see `useMysterySession`), so at this
 * point the client has no pool data at all -- there is no date here to
 * accidentally render, not merely one that is being withheld.
 */
function ModeChooser({
  todaysClose,
  todaysCloseLoading,
  reducedMotion,
  onChoose,
}: {
  todaysClose: { ticker: string; date: string; bars: readonly SessionBar[] } | null;
  todaysCloseLoading: boolean;
  reducedMotion: boolean;
  onChoose: (mode: BeatTheBenchMode) => void;
}) {
  const [playedRecord, setPlayedRecord] = useState<PlayedSession | null>(null);
  const todaysCloseDate = todaysClose?.date ?? null;

  // Read after mount, never during render: this component renders on the
  // server (issue #122 mounts this section at the ResultsPage level), so
  // a synchronous storage read here would make the hydration render
  // disagree with the server's. Same deferred-correction shape
  // use-hydrated-local-storage-state.ts uses.
  useEffect(() => {
    if (todaysCloseDate === null) return;
    queueMicrotask(() => setPlayedRecord(readPlayedSession(todaysCloseDate, "todays-close")));
  }, [todaysCloseDate]);

  return (
    <div className="flex flex-col gap-3">
      {playedRecord !== null && (
        <p className="text-sm text-[var(--text-secondary)]">
          You&apos;ve played today&apos;s close:{" "}
          <span
            className={
              playedRecord.outcome === "win"
                ? "font-semibold text-[var(--accent-reward)]"
                : "font-semibold text-[var(--text-primary)]"
            }
          >
            {outcomeHeadline(settlementFromRecord(playedRecord))}
          </span>
          , finishing at {formatHeroCurrency(playedRecord.playerBalance)} against the bench&apos;s{" "}
          {formatHeroCurrency(playedRecord.benchmarkBalance)}.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        <li>
          {todaysClose === null ? (
            <p className="text-sm text-[var(--text-muted)]">
              {todaysCloseLoading
                ? "Looking up the latest session…"
                : "There's no session to play right now. A day's bars are published by the nightly run, shortly after the close."}
            </p>
          ) : (
            <ModeCard
              title={playedRecord === null ? "Play today's close" : "Play today's close again"}
              detail={`${todaysClose.ticker} · ${formatDate(todaysClose.date)} · ${todaysClose.bars.length} bars · about ${Math.round(sessionDurationMs(todaysClose.bars.length, 1) / 1000)} seconds at normal speed`}
              onClick={() => onChoose("todays-close")}
            />
          )}
        </li>
        <li>
          <ModeCard
            title="Play a mystery day"
            detail="A real session from the last couple of months -- you won't be told which one until you've finished it."
            onClick={() => onChoose("mystery")}
          />
        </li>
      </ul>

      {reducedMotion && (
        <p className="text-sm text-[var(--text-muted)]">
          You prefer reduced motion, so the session will start paused. Step through it a bar at a
          time, or press play whenever you&apos;d like.
        </p>
      )}
    </div>
  );
}

function ModeCard({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full flex-col items-start gap-1 rounded-md border border-[var(--gridline)] bg-[var(--surface-2)] px-4 py-3 text-left"
    >
      <span className="text-base font-semibold text-[var(--text-primary)]">{title}</span>
      <span className="text-sm text-[var(--text-muted)]">{detail}</span>
    </button>
  );
}

/** Rebuilds the `Settlement` shape from a stored record, so the chooser's recap can reuse `outcomeHeadline` rather than storing a second copy of the copy. */
function settlementFromRecord(record: PlayedSession): SessionSettlement {
  return {
    startingCapital: STARTING_CAPITAL,
    playerBalance: record.playerBalance,
    benchmarkBalance: record.benchmarkBalance,
    playerReturnFraction: record.playerBalance / STARTING_CAPITAL - 1,
    benchmarkReturnFraction: record.benchmarkBalance / STARTING_CAPITAL - 1,
    moves: record.moves,
    outcome: record.outcome,
  };
}

function BackToModesButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className={`${CONTROL_CLASS} self-start bg-[var(--surface-1)] text-[var(--text-primary)]`}
    >
      Pick a different mode
    </button>
  );
}

/**
 * The game itself -- identical for both modes.
 *
 * **The one place mode matters is the reveal, and it is a request that
 * does not happen** (issue #132's central rule). `useMysteryReveal` is
 * handed `null` for as long as the session is unsettled, and the shared
 * fetch state machine makes no request at all for a `null` URL -- so
 * before settlement there is no date in the DOM, no date in this
 * component's state, no date in a fetch cache, and no request for one in
 * the network log. Not "hidden": absent.
 */
function SessionGame({
  session,
  reducedMotion,
  onBack,
  onAnother,
}: {
  session: PlayableSession;
  reducedMotion: boolean;
  onBack: () => void;
  onAnother?: () => void;
}) {
  const bars = session.bars;
  const lastIndex = bars.length - 1;

  const [barIndex, setBarIndex] = useState(0);
  const [moves, setMoves] = useState<number[]>([]);
  const [speed, setSpeed] = useState<PlaybackSpeed>(DEFAULT_SPEED);
  // Reduced motion doesn't remove the mechanic here -- it changes how it
  // starts. Playback begins paused so nothing moves until the viewer asks
  // it to, and "Step forward one bar" (always present, for everyone) is a
  // complete way to play the session start to finish. Safe to read from
  // the prop in a `useState` initializer, unlike issue #131's version:
  // this component now mounts in response to the viewer picking a mode,
  // long after the parent's own post-mount preference read has landed.
  const [paused, setPaused] = useState(reducedMotion);

  // Whether the session has finished is *derived*, not a third phase to
  // keep in sync: playback simply runs out of bars. Nothing has to
  // transition anything, so there's no window in which the bar index and
  // the phase disagree.
  const settled = barIndex >= lastIndex;
  const settlement = settleSession(bars, moves, STARTING_CAPITAL);
  const position = positionAfterBar(moves, barIndex);

  // THE rule (issue #132): `null` until the session has actually settled,
  // which means no request for the id -> date index until then.
  const revealState = useMysteryReveal(settled ? session.sessionId : null);
  const reveal = revealState !== null && revealState.status === "success" ? revealState.data : null;
  // Slots are re-permuted every pipeline run, so an id picked before a
  // rotation resolves to a different day afterwards. Comparing the two
  // run stamps is what turns that into "we can't say which day this was"
  // instead of a confident reveal of the wrong one.
  const poolRotated =
    reveal !== null &&
    session.poolGeneratedAt !== null &&
    reveal.generatedAt !== session.poolGeneratedAt;
  const revealedDate = reveal !== null && !poolRotated ? reveal.date : null;

  // The date this session's stored record is keyed by. Today's Close has
  // it from the start; Mystery Day only once the reveal lands, so its
  // record is written at that moment rather than at settlement -- keyed
  // by the *real* date, so issue #133's status rail reads one consistent
  // `hikt:beat-the-bench:{date}:{mode}` shape for both modes rather than
  // one keyed by an opaque slot id that means something different after
  // the next pipeline run.
  const recordDate = session.date ?? revealedDate;

  useEffect(() => {
    if (!settled || recordDate === null) return;
    savePlayedSession(recordDate, session.mode, {
      played: true,
      outcome: settlement.outcome,
      playerBalance: settlement.playerBalance,
      benchmarkBalance: settlement.benchmarkBalance,
      moves: settlement.moves,
    });
    // Keyed on the primitives that define this settlement, not on a
    // freshly-built object (a new identity every render, which would
    // rewrite storage on every one).
  }, [
    settled,
    recordDate,
    session.mode,
    settlement.outcome,
    settlement.playerBalance,
    settlement.benchmarkBalance,
    settlement.moves,
  ]);

  // Advance one bar per tick. `atEnd` (not `barIndex`) is in the dep
  // array on purpose: depending on the index itself would tear down and
  // rebuild the interval on every single tick, so each tick's real
  // spacing would drift by however long the render took.
  const atEnd = settled;
  useEffect(() => {
    if (paused || atEnd) return;
    const id = window.setInterval(() => {
      setBarIndex((current) => Math.min(current + 1, lastIndex));
    }, tickIntervalMs(speed));
    return () => {
      window.clearInterval(id);
    };
  }, [paused, atEnd, speed, lastIndex]);

  // Replays this same session from its opening bar. Not a mount-time
  // concern: choosing a mode is what starts a session, so this component
  // only ever exists mid-game.
  function replaySession() {
    setBarIndex(0);
    setMoves([]);
    setSpeed(DEFAULT_SPEED);
    setPaused(reducedMotion);
  }

  const currentBar = bars[barIndex]!;
  const playerBalance = balanceAtBar(bars, moves, STARTING_CAPITAL, barIndex);
  const benchBalance = balanceAtBar(bars, [], STARTING_CAPITAL, barIndex);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-[var(--text-secondary)]">
          {/* Mystery Day names the ticker and nothing else -- there is no
              date on the client to name at this point. */}
          {session.date === null
            ? `${session.ticker}, a mystery session`
            : `${session.ticker}, ${formatDate(session.date)}`}
        </p>
        {/* The chart itself draws no time labels -- see
            BeatTheBenchChart's own note on why. This is the session's
            revealed span, in plain HTML, legible at every width. */}
        <p className="font-numeric text-sm tabular-nums text-[var(--text-muted)]">
          {barIndex === 0
            ? formatTime(currentBar.time)
            : `${formatTime(bars[0]!.time)} → ${formatTime(currentBar.time)}`}{" "}
          · bar {barIndex + 1} of {bars.length}
        </p>
      </div>

      <BeatTheBenchChart
        bars={bars}
        revealedIndex={barIndex}
        positions={positionsThroughBar(moves, barIndex)}
      />

      {/* The live readouts and the trade control belong to a session in
          progress. Once it settles they're replaced by the settlement
          card below rather than left on screen greyed out: they'd
          otherwise restate the same two balances a second time, one
          rounded pair of figures directly above another. */}
      {!settled && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Readout label={`${session.ticker} price`} value={`$${currentBar.close.toFixed(2)}`} />
            <Readout
              label={position === "holding" ? "You (in the market)" : "You (in cash)"}
              value={formatHeroCurrency(playerBalance)}
              emphasis
            />
            <Readout label="The bench" value={formatHeroCurrency(benchBalance)} />
          </div>

          {/* One toggle, flipping label and color, rather than two
              persistent buttons -- there is only ever one move
              available, and a pair of buttons would leave one of them
              permanently dead. */}
          <button
            type="button"
            onClick={() => setMoves((current) => [...current, barIndex])}
            className={`min-h-11 rounded-md px-4 text-base font-semibold ${
              position === "holding"
                ? "border border-[var(--gridline)] bg-[var(--surface-2)] text-[var(--text-primary)]"
                : "bg-[var(--accent-selection)] text-white"
            }`}
          >
            {position === "holding" ? "Sell, go to cash" : "Buy back in"}
          </button>
        </>
      )}

      {settled ? (
        <FinalSettlement
          session={session}
          settlement={settlement}
          moveBarIndexes={moves}
          revealPending={revealState === null ? false : revealState.status === "loading"}
          revealedDate={revealedDate}
          poolRotated={poolRotated}
          onPlayAgain={replaySession}
          onAnother={onAnother}
          onBack={onBack}
        />
      ) : (
        <PlaybackControls
          paused={paused}
          speed={speed}
          reducedMotion={reducedMotion}
          onTogglePause={() => setPaused((current) => !current)}
          onStep={() => {
            setPaused(true);
            setBarIndex((current) => Math.min(current + 1, lastIndex));
          }}
          onSpeed={setSpeed}
          onBack={onBack}
        />
      )}

      {/* Position changes and the final settlement are announced; the
          per-bar tick deliberately is not -- announcing 78 price changes
          would make the page unusable with a screen reader. */}
      <p role="status" aria-live="polite" className="sr-only">
        {settled
          ? `Session over. ${outcomeHeadline(settlement)}. You finished at ${formatHeroCurrency(settlement.playerBalance)}, the bench at ${formatHeroCurrency(settlement.benchmarkBalance)}.`
          : position === "holding"
            ? "In the market."
            : "In cash."}
      </p>
    </div>
  );
}

/**
 * The playback row -- and the way back out of a session in progress.
 *
 * That last part is not decoration: before it existed, "Pick a different
 * mode" only appeared once a session had settled, so a player who started
 * a 78-bar session by mistake had no way out short of reloading the page.
 * Found by a real browser walking the UI, not by reading it (Playwright
 * sat waiting 23 seconds for a control that simply wasn't rendered yet).
 */
function PlaybackControls({
  paused,
  speed,
  reducedMotion,
  onTogglePause,
  onStep,
  onSpeed,
  onBack,
}: {
  paused: boolean;
  speed: PlaybackSpeed;
  reducedMotion: boolean;
  onTogglePause: () => void;
  onStep: () => void;
  onSpeed: (next: PlaybackSpeed) => void;
  onBack: () => void;
}) {
  const speedGroupId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onTogglePause}
          className={`${CONTROL_CLASS} bg-[var(--surface-2)] text-[var(--text-primary)]`}
        >
          {paused ? "Play" : "Pause"}
        </button>
        <button
          type="button"
          onClick={onStep}
          aria-label="Step forward one bar"
          className={`${CONTROL_CLASS} bg-[var(--surface-2)] text-[var(--text-primary)]`}
        >
          Step
        </button>
        <span id={speedGroupId} className="text-sm text-[var(--text-muted)]">
          Speed
        </span>
        {/* A wrapping row of five fixed settings, each its own >=44px
            target -- the row breaks onto a second line at narrow widths
            rather than shrinking any of them. */}
        <div role="group" aria-labelledby={speedGroupId} className="flex flex-wrap gap-2">
          {PLAYBACK_SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onSpeed(option)}
              aria-pressed={option === speed}
              className={`${CONTROL_CLASS} font-numeric tabular-nums ${
                option === speed
                  ? "bg-[var(--accent-selection)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--text-secondary)]"
              }`}
            >
              {option}x
            </button>
          ))}
        </div>
      </div>
      {reducedMotion && paused && (
        <p className="text-sm text-[var(--text-muted)]">
          Paused for reduced motion. Step is a complete way to play -- one bar per press, all the
          way to the close.
        </p>
      )}
      <BackToModesButton onBack={onBack} />
    </div>
  );
}

/**
 * Final Settlement: the win/loss/tie stamp against the bench, both sides'
 * final dollars and percent, and (issue #132) the two pieces of analysis
 * that only make sense once the whole session is known -- what the day's
 * biggest moves actually were and whether the player was in the market
 * for them, and where they landed against a field of randomly-timed
 * traders.
 *
 * The *gap* gets its own sentence because a single session moves a
 * fraction of a percent -- both balances routinely round to the same
 * dollars-and-cents figure even when one genuinely won, and printing two
 * identical-looking numbers under a "you beat the bench" stamp would
 * read as a bug (see `gapPhrase`).
 *
 * Gold (`--accent-reward`, issue #121) appears here and nowhere else in
 * this section, and only on a win -- it means "you earned this", so a
 * loss or a tie stamp stays in plain text.
 */
function FinalSettlement({
  session,
  settlement,
  moveBarIndexes,
  revealPending,
  revealedDate,
  poolRotated,
  onPlayAgain,
  onAnother,
  onBack,
}: {
  session: PlayableSession;
  settlement: SessionSettlement;
  moveBarIndexes: readonly number[];
  revealPending: boolean;
  revealedDate: string | null;
  poolRotated: boolean;
  onPlayAgain: () => void;
  onAnother?: () => void;
  onBack: () => void;
}) {
  const bars = session.bars;

  const topMoves = useMemo(
    () => topUpMoves(bars, moveBarIndexes, STARTING_CAPITAL),
    [bars, moveBarIndexes],
  );
  const missed = biggestMissedMove(topMoves);

  // Seeded from the session's own price path, never from the clock or
  // `Math.random()` -- so the number a player is reading can't move under
  // them on a re-render, and so the whole simulation is reproducible.
  // (Seeding from a *date* would also be wrong here: Mystery Day doesn't
  // have one on the client at this point, and mustn't.)
  const percentile = useMemo(
    () =>
      comparePercentile(bars, moveBarIndexes, STARTING_CAPITAL, {
        random: mulberry32(seedFromBars(bars)),
      }),
    [bars, moveBarIndexes],
  );

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--gridline)] bg-[var(--surface-2)] px-4 py-4">
      <p
        className={`font-display text-xl font-semibold ${
          settlement.outcome === "win"
            ? "text-[var(--accent-reward)]"
            : "text-[var(--text-primary)]"
        }`}
      >
        {outcomeHeadline(settlement)}
      </p>
      <p className="font-numeric text-sm tabular-nums text-[var(--text-secondary)]">
        {gapPhrase(settlement)}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Readout
          label="You"
          value={`${formatHeroCurrency(settlement.playerBalance)} (${formatSessionPercent(settlement.playerReturnFraction)})`}
          emphasis
        />
        <Readout
          label="The bench"
          value={`${formatHeroCurrency(settlement.benchmarkBalance)} (${formatSessionPercent(settlement.benchmarkReturnFraction)})`}
        />
      </div>
      <p className="text-sm text-[var(--text-secondary)]">{outcomeDetail(settlement)}</p>

      <BestMovesPanel topMoves={topMoves} missedSentence={missedMoveSentence(missed)} />

      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--text-secondary)]">{percentilePhrase(percentile)}</p>
        <p className="text-sm text-[var(--text-muted)]">
          That field is {percentile.trials} simulated traders who flipped in and out of this exact
          session at random moments -- a control group for timing, not a model of how anyone really
          trades. Their middling result was {formatHeroCurrency(percentile.medianBalance)}.
        </p>
      </div>

      <p className="text-sm text-[var(--text-muted)]">
        <SessionProvenance
          session={session}
          revealPending={revealPending}
          revealedDate={revealedDate}
          poolRotated={poolRotated}
        />{" "}
        No fees, no slippage -- every move settles at the price on screen.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onPlayAgain}
          className={`${CONTROL_CLASS} bg-[var(--surface-1)] text-[var(--text-primary)]`}
        >
          Play it again
        </button>
        {onAnother && (
          <button
            type="button"
            onClick={onAnother}
            className={`${CONTROL_CLASS} bg-[var(--surface-1)] text-[var(--text-primary)]`}
          >
            Another mystery day
          </button>
        )}
        <BackToModesButton onBack={onBack} />
      </div>
    </div>
  );
}

/**
 * Which real session this was.
 *
 * For Mystery Day this is the *only* place a date ever appears, and only
 * after the reveal request has come back -- a request `SessionGame` does
 * not make until the session has settled. The pool-rotation branch is not
 * hypothetical politeness: slots are re-permuted on every pipeline run,
 * so a player who left a settled session open across a nightly run would
 * otherwise be shown a confidently wrong day.
 */
function SessionProvenance({
  session,
  revealPending,
  revealedDate,
  poolRotated,
}: {
  session: PlayableSession;
  revealPending: boolean;
  revealedDate: string | null;
  poolRotated: boolean;
}) {
  const source = `${session.ticker}'s real ${session.barIntervalMinutes}-minute closes`;
  if (session.date !== null) return <>{`${source} from ${formatDate(session.date)}.`}</>;
  if (revealedDate !== null) return <>{`That was ${source} from ${formatDate(revealedDate)}.`}</>;
  if (revealPending) return <>{`${source}. Looking up which day that was…`}</>;
  if (poolRotated) {
    return (
      <>{`${source}. The pool rotated while you were playing, so which day this was can no longer be looked up.`}</>
    );
  }
  return <>{`${source}. Which day that was couldn't be looked up just now.`}</>;
}

/**
 * The session's biggest moves, and whether the player was on them.
 *
 * **The dollar figures are an approximation and the copy says so
 * outright.** Each one is what that move would have added to a
 * buy-and-hold position of this size -- see `benchmarkDollarsFor`'s own
 * methodology comment (`beat-the-bench-moves.ts`) for exactly what is
 * computed. It is deliberately *not* a re-simulation of this player's
 * own session with one decision changed, and the figures are deliberately
 * not summed into a single "what your mistakes cost you" total, because
 * they would each have compounded into each other.
 */
function BestMovesPanel({
  topMoves,
  missedSentence,
}: {
  topMoves: ReturnType<typeof topUpMoves>;
  missedSentence: string;
}) {
  if (topMoves.length === 0) {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        The session never put together a run worth catching -- it only ever went down.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-[var(--text-primary)]">
        The session&apos;s biggest runs
      </p>
      <ul className="flex flex-col gap-1">
        {topMoves.map((move) => (
          <li
            key={`${move.fromIndex}-${move.toIndex}`}
            className="font-numeric text-sm tabular-nums text-[var(--text-secondary)]"
          >
            {formatTime(move.fromTime)} → {formatTime(move.toTime)},{" "}
            {formatSessionPercent(move.returnFraction)} ({formatHeroCurrency(move.benchmarkDollars)}
            ){" · "}
            <span
              className={move.playerHeld ? "text-[var(--status-good)]" : "text-[var(--text-muted)]"}
            >
              {move.playerHeld ? "you were in" : "you were in cash"}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-[var(--text-secondary)]">{missedSentence}</p>
      <p className="text-sm text-[var(--text-muted)]">
        Those dollar figures are an approximation: each is roughly what that run would have added to
        a buy-and-hold position of this size, not a replay of your own session with one decision
        changed. They don&apos;t add up into a single total, because each one would have compounded
        into the next.
      </p>
    </div>
  );
}

function Readout({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      <span
        className={`font-numeric tabular-nums ${
          emphasis
            ? "text-lg font-semibold text-[var(--text-primary)]"
            : "text-lg text-[var(--text-secondary)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
