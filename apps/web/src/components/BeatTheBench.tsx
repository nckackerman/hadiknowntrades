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
// design pass).** This section renders a compact "Can you do better?"
// tile (`CompactCard`) that stays mounted and visible at all times --
// clicking it toggles a panel open/closed directly beneath it, holding
// the exact same chooser/playback/settlement experience this file always
// rendered. The tile itself never changes shape or title when the panel
// opens; only its bottom corners square off to flush against the panel,
// exactly mirroring The Call Board's own `<details>`/`<summary>` (the
// summary you clicked stays put, and clicking it again closes the
// board). An earlier version of this file instead swapped the whole tile
// out for a differently-styled header (a smaller icon, a shortened
// title, a separate "Collapse" text link) once expanded -- fixed after
// direct user feedback that it read as a different component once
// opened, unlike the other three daily-hub games.
//
// Unlike The Call Board, the *panel* is still a plain `useState`
// boolean, not a native `<details>`: its content is a stateful game
// (fetches, a running playback interval), and collapsing deliberately
// *unmounts* it -- via the same `expanded === false` check that hides
// `BeatTheBenchFrame` -- rather than merely hiding it the way a closed
// `<details>` would (which keeps its children mounted, `display:
// none`'d, with any interval still silently ticking underneath). The
// tile (`CompactCard`), by contrast, is unconditionally mounted now,
// same as `<summary>` always is. Collapsing also resets `mode` back to
// `null`, so re-expanding always starts from the mode chooser rather
// than resuming stale mid-game state. `useTodaysCloseSession` is still
// called unconditionally at the top of this component regardless of
// panel state (so the fetch-on-mount behaviour this file's own
// Judgment-calls section already documents is untouched), and the
// Mystery Day zero-request-before-settlement rule above is completely
// orthogonal to whether the panel is open -- it depends only on
// `settled`, never on this `expanded` flag.
//
// **Issue #186's condensation**: `CompactCard` gained a small corner
// status badge (`done` once today's session has been played, nothing
// otherwise -- see its own doc comment) built from
// `lib/daily-ritual.ts`'s own `STEP_STYLES`, shared with The Call
// Board's identical badge. This replaced what used to be a separate,
// always-visible "Today, so far" status rail above every mechanic
// (`DailyRitual.tsx`) -- itself removed outright in a later pass, once
// the recap disclosure it fed was also removed (see apps/web/CLAUDE.md's
// own "'Today's recap' removed outright" section).
//
// **Bullet Time (issue #224)**: right before one of a session's real big
// price swings, playback drops into slow motion, and the player has to
// commit -- "Ride it out" or "Step aside" -- before the swing resolves.
// See `lib/bullet-time.ts` for the whole scheduling/phase/resolution
// engine (a genuine sibling to `lib/beat-the-bench.ts`, not a change to
// it -- settlement math is completely untouched) and apps/web/CLAUDE.md's
// own "Beat the Bench: Bullet Time" section for the design decisions and
// the real thresholds they're validated against.

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
  type PlaybackSpeed,
  type Position,
  type Settlement as SessionSettlement,
} from "@/lib/beat-the-bench";
import { biggestMissedMove, missedMoveSentence, topUpMoves } from "@/lib/beat-the-bench-moves";
import {
  BULLET_TIME_BADGE_LINGER_BARS,
  BULLET_TIME_DECISION_WINDOW_MS,
  bulletTimeCallSentence,
  bulletTimeStatusAt,
  bulletTimeTallyLine,
  bulletTimeTickIntervalMs,
  evaluateBulletTimeCall,
  resolvedBulletTimeCalls,
  scheduleBulletTimeEvents,
  type BulletTimeEvent,
} from "@/lib/bullet-time";
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
import { localDateKey, recordGameTileOpened } from "@/lib/game-tile-order-storage";
import { formatHeroCurrency, formatSessionPercent } from "@/lib/format-currency";
import { useReducedMotionAfterMount } from "@/lib/use-reduced-motion-after-mount";
import { useMysteryReveal, useMysterySession } from "@/lib/use-mystery-session";
import { useTodaysCloseSession } from "@/lib/use-todays-close-session";
import { BeatTheBenchChart } from "@/components/BeatTheBenchChart";
import { GamePanelHeader } from "@/components/GamePanelHeader";

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

/** The tile's own icon (🎯), named once so `CompactCard` and `BeatTheBenchFrame`'s panel header can't drift apart -- mirrors CallBoard.tsx's identical `CTA_ICON` constant. */
const BENCH_ICON = "🎯";

/** The mechanic's name, named once so the sr-only landmark `<h2>` and the panel's own visible `<GamePanelHeader>` heading can't drift apart -- mirrors TheOrder.tsx's `TITLE`/TheLineup.tsx's `TILE_TITLE`. */
const BENCH_TITLE = "Beat the Bench";

/**
 * Connecting the expanded panel back to the tile that opened it (issue
 * #195, now matching The Call Board's full treatment): the same darkest
 * gradient stop the tile fills with, reused for the panel's 4px top
 * border, its icon-plate wash, and (see `CompactCard`, below) the tile's
 * own squared-off bottom corners while the panel beneath it is open.
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
  // before that issue; it only decides whether the panel below the tile
  // renders yet.
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<ChosenMode>(null);
  // Bumped to ask for *another* random day. It rides in the mystery
  // fetch's URL (see useMysterySession) because the shared fetch state
  // machine refetches on URL change and nothing else.
  const [pick, setPick] = useState(0);

  const todaysCloseState = useTodaysCloseSession();
  const mysteryState = useMysterySession(mode === "mystery" ? pick : null);
  const todaysClose = playableTodaysClose(todaysCloseState);

  // Toggles the panel open/closed -- the tile above it (see `CompactCard`)
  // is clickable in both directions, exactly like The Call Board's own
  // `<summary>`. Resetting `mode` only on the close transition (rather
  // than leaving it set for a future re-expand) keeps re-expanding always
  // land on the mode chooser, never resumed mid-game state a viewer might
  // not recognize. A plain closure read of `expanded`, not
  // `setExpanded`'s own functional-updater form -- this is a synchronous
  // onClick handler with `expanded` already correct in scope, so there's
  // no batched/stale-state risk a functional updater would guard
  // against, and calling `setMode` as a side effect *inside* an updater
  // would violate React's "updaters must be pure" contract (Strict
  // Mode's dev-only double-invoke exists specifically to catch this).
  function handleToggle() {
    if (expanded) setMode(null);
    setExpanded(!expanded);
  }

  // A pure function of already-resolved state (mode/todaysClose/
  // mysteryState/pick/reducedMotion) -- safe to call only when the panel
  // is actually open, below. Kept as one function rather than the
  // 7-way early-return ladder this replaced (one per mode/loading/error
  // combination, each separately re-wrapping `BeatTheBenchFrame`) so the
  // frame markup exists in exactly one place.
  function renderGameContent(): ReactNode {
    if (mode === null) {
      return (
        <ModeChooser
          todaysClose={todaysClose}
          todaysCloseLoading={todaysCloseState === null || todaysCloseState.status === "loading"}
          reducedMotion={reducedMotion}
          onChoose={setMode}
        />
      );
    }

    if (mode === "todays-close") {
      const session = todaysClose;
      if (session === null) return null;
      return (
        // Keyed on the session's own date so a fresh trading day starts a
        // genuinely fresh game (state, stored-record read and all)
        // rather than carrying yesterday's bar index into today's bars.
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
      );
    }

    if (mysteryState === null || mysteryState.status === "loading") {
      return <p className="text-sm text-[var(--text-muted)]">Picking a day out of the hat…</p>;
    }

    if (mysteryState.status === "error" || !isPlayableSession(mysteryState.data.session)) {
      return (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            There&apos;s no mystery session to play right now. The pool is published by the nightly
            run, shortly after the close.
          </p>
          <BackToModesButton onBack={() => setMode(null)} />
        </>
      );
    }

    const mystery = mysteryState.data;
    return (
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
    );
  }

  // Not `headingId` itself -- that already names the sr-only landmark
  // `<h2>` below. A second, derived id for the panel `<div>` so the tile
  // button's own `aria-controls` has a real target to point at, the
  // relationship CallBoard/TheOrder/TheLineup get for free from native
  // `<details>`/`<summary>` (see CompactCard's own doc comment on why
  // this game hand-rolls the toggle instead).
  const panelId = `${headingId}-panel`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      {/* A stable, sr-only landmark name -- decoupled from the tile's own
          visible marketing copy, mirroring CallBoard.tsx's identical
          `<h2 id="call-board-heading" className="sr-only">` above its own
          `<details>`. */}
      <h2 id={headingId} className="sr-only">
        {BENCH_TITLE}
      </h2>
      <CompactCard
        todaysCloseDate={todaysClose?.date ?? null}
        expanded={expanded}
        onToggle={handleToggle}
        panelId={panelId}
      />
      {expanded && <BeatTheBenchFrame panelId={panelId}>{renderGameContent()}</BeatTheBenchFrame>}
    </section>
  );
}

/**
 * The expanded panel -- The Call Board's own dark `surface-card`-less
 * wrapper shape (`bg-[var(--surface-1)]`, not the tile's own gradient),
 * connected back to the tile above it via issue #195's two devices,
 * fully matching The Call Board's own treatment now that the tile stays
 * mounted above this panel rather than unmounting: a 4px
 * `CONNECTOR_ACCENT`-colored top border (replacing the top edge of the
 * otherwise-unchanged `border-[var(--gridline)]` on the other three
 * sides), and flush corners (`rounded-t-none`) against the tile's own
 * squared-off bottom (see `CompactCard`, below). No "Collapse" control
 * of its own -- the tile above, always visible and always clickable (see
 * `BeatTheBench`'s own `handleToggle`), is what closes this again,
 * exactly like The Call Board's `<summary>`.
 *
 * `data-bench-expanded` (issue #178) is what the 2-up grid wrapping this
 * card and The Call Board keys its own `:has()` selector off of, to
 * collapse itself to one column whenever either game's full content is
 * showing, without lifting `expanded` state up into the parent. CallBoard
 * needs no equivalent marker -- its own expanded state is already a
 * native `<details open>`, directly selectable on its own. Placed here
 * (not on the tile) since this panel is exactly what's conditionally
 * mounted.
 */
function BeatTheBenchFrame({ panelId, children }: { panelId: string; children?: ReactNode }) {
  return (
    <div
      id={panelId}
      data-bench-expanded="true"
      data-testid="beat-the-bench-panel"
      className="flex flex-col gap-4 rounded-t-none rounded-b-2xl border-x border-b border-t-4 border-[var(--gridline)] bg-[var(--surface-1)] px-4 pt-4 pb-5"
      style={{ borderTopColor: CONNECTOR_ACCENT }}
    >
      <GamePanelHeader icon={BENCH_ICON} accentColor={CONNECTOR_ACCENT} title={BENCH_TITLE} />
      <p className="text-sm text-[var(--text-secondary)]">
        One real trading session, replayed close by close. You start with{" "}
        {formatHeroCurrency(STARTING_CAPITAL)}, already in the market -- exactly where the bench
        starts. Ride it out and you finish exactly where it does; step aside before a dip and you
        finish ahead.
      </p>
      {children}
    </div>
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
 * already documents as "fetched on mount, always". This same button is
 * the toggle in both directions -- clicking it again while expanded
 * collapses `BeatTheBenchFrame`'s panel, unmounting it (not merely
 * hiding it), which is what actually stops the game's own running
 * interval -- matching The Call Board's own always-clickable `<summary>`
 * behavior, just via a plain boolean toggle instead of a native
 * disclosure element. Unlike the panel, this button/tile itself never
 * unmounts.
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
  todaysCloseDate,
  expanded,
  onToggle,
  panelId,
}: {
  todaysCloseDate: string | null;
  expanded: boolean;
  onToggle: () => void;
  /** The panel `<div>`'s own id (only actually rendered while `expanded`) -- wired to `aria-controls` below so a screen-reader user gets the same toggle-controls-region relationship CallBoard/TheOrder/TheLineup get for free from native `<details>`/`<summary>`. */
  panelId: string;
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

  // The pre-existing hover-lift, present while collapsed; suppressed
  // while the panel below is open, matching CallBoard.tsx's own
  // `group-open:hover:translate-y-0 group-open:hover:scale-100` (issue
  // #195) -- swapped outright here rather than layered via a CSS
  // variant, since `expanded` is already real React state with no need
  // for CallBoard's own group-open indirection.
  const liftClasses = expanded
    ? "hover:translate-y-0 hover:scale-100"
    : "hover:-translate-y-0.5 hover:scale-[1.015]";

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={panelId}
      style={{
        backgroundImage: BENCH_TILE_GRADIENT,
        color: "#241a08",
      }}
      // rounded-b-none once expanded (issue #195): flush against
      // BeatTheBenchFrame's own rounded-t-none panel directly below,
      // reading as one tile unfolding rather than two stacked cards --
      // see that component's own doc comment.
      className={`relative flex w-full flex-col gap-4 rounded-2xl px-[1.15rem] py-[1.1rem] text-left shadow-[0_8px_22px_rgba(232,163,61,0.35),0_6px_18px_rgba(0,0,0,0.35)] transition-transform duration-150 ease-out ${liftClasses} active:translate-y-0 active:scale-[0.99] ${expanded ? "rounded-b-none" : ""}`}
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
            {BENCH_ICON}
          </span>
        </span>
        <span className="font-display text-[1.0625rem] font-extrabold tracking-[-0.01em] leading-[1.15]">
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
 * that's collapsed by default -- same numbers, different sentence shape.
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

  // Bullet Time (issue #224): scheduled once, up front, from the full
  // known bar array -- this is a replay of a real closed session, so the
  // whole thing is already known and there's nothing to predict live.
  // `bulletTimeEvents` never changes across this component's own
  // lifetime (it's a pure function of `bars`, which is fixed for the
  // whole session), so `biStatus` is a cheap, fully derived read every
  // render, not separate state to keep in sync with `barIndex`.
  const bulletTimeEvents = useMemo(() => scheduleBulletTimeEvents(bars), [bars]);
  const biStatus = bulletTimeStatusAt(bulletTimeEvents, barIndex);
  // Playback pauses unconditionally while deciding, regardless of the
  // player's own `paused` state -- a decision has to actually be made
  // (or the window has to run out) before bars advance again.
  const deciding = biStatus.phase === "deciding";
  // The one thing a lingering "Called it"/"Not this time" badge needs:
  // the most recently resolved event still inside its own linger
  // window, and the call it actually resolved to (computed at its own
  // `swing.toIndex`, not "now" -- see BULLET_TIME_BADGE_LINGER_BARS'
  // own doc comment for why a bar count, not a timer). `undefined` once
  // `settled` -- without this, an event resolving in the last few bars
  // of a session would leave the badge visibly stuck on screen forever
  // once `barIndex` stops advancing at settlement, duplicating the exact
  // information `FinalSettlement`'s own tally line already states for
  // good.
  const recentlyResolvedEvent = settled
    ? undefined
    : bulletTimeEvents.find(
        (event) =>
          barIndex >= event.swing.toIndex &&
          barIndex - event.swing.toIndex <= BULLET_TIME_BADGE_LINGER_BARS,
      );
  const recentlyResolvedCall =
    recentlyResolvedEvent === undefined
      ? null
      : evaluateBulletTimeCall(
          positionAfterBar(moves, recentlyResolvedEvent.swing.toIndex),
          recentlyResolvedEvent.swing,
        );
  // Computed once, reused by both the visible badge and the aria-live
  // announcement below, rather than each independently re-checking the
  // same compound null/undefined condition and calling
  // bulletTimeCallSentence a second time for byte-identical output.
  const recentlyResolvedSentence =
    recentlyResolvedEvent !== undefined && recentlyResolvedCall !== null
      ? bulletTimeCallSentence(recentlyResolvedCall, recentlyResolvedEvent.swing)
      : null;

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
  // by the *real* date, so every reader shares one consistent
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
    // Also records this settlement into issue #196's cross-day tile-order
    // history -- deliberately keyed by the *viewer's own local calendar
    // day* (localDateKey(new Date())), not `recordDate` (the session's
    // own trading date, which can be a prior Friday on a weekend). The
    // tile-order ranking asks "which tile does this browser tend to open
    // first on its own day," not anything about a trading calendar -- see
    // game-tile-order-storage.ts's own header comment.
    recordGameTileOpened("beat-the-bench", localDateKey(new Date()));
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
  // spacing would drift by however long the render took. `deciding` is
  // in the dep array for the same reason `atEnd` is -- it flips the
  // interval off (a forced pause, regardless of the player's own
  // `paused`) and back on again exactly at the two bars that matter
  // (entering/leaving the decision window), not on every tick.
  const atEnd = settled;
  const effectiveTickMs = bulletTimeTickIntervalMs(biStatus.phase, speed, reducedMotion);
  useEffect(() => {
    if (paused || atEnd || deciding) return;
    const id = window.setInterval(() => {
      setBarIndex((current) => Math.min(current + 1, lastIndex));
    }, effectiveTickMs);
    return () => {
      window.clearInterval(id);
    };
  }, [paused, atEnd, deciding, effectiveTickMs, lastIndex]);

  // The decision window's own auto-lock: unanswered, it advances past
  // the swing's own start bar on its own after BULLET_TIME_DECISION_WINDOW_MS
  // -- a real, honest no-op (matches this app's "no fees, no slippage"
  // copy), never a penalty, since no move is recorded here. Only set up
  // while genuinely deciding, and never under reduced motion -- issue
  // #224's own scope calls for an explicit tap there, not an animated
  // countdown that silently resolves itself (see `bulletTimeTickIntervalMs`'s
  // own reduced-motion fallback and `BulletTimeDecisionPanel`'s own
  // `!reducedMotion` guard on the countdown bar -- all three sites
  // enforce the same "no timer, no slow motion, under reduced motion"
  // rule, so a future change to any one of them should check the other
  // two too).
  //
  // **`PlaybackControls`' own "Step forward one bar" is a second,
  // equally valid way to reach this same no-op, deliberately, for every
  // player regardless of motion preference** -- it already just
  // advances `barIndex` unconditionally with no move recorded, so
  // clicking it during `deciding` behaves identically to the timer
  // running out. Not a bypass of the mechanic: "no decision" is a real,
  // honest, always-available outcome per this app's own established
  // "Step is a complete way to play" guarantee (see `beat-the-bench.ts`'s
  // own header comment) -- it was never meant to be reachable only via
  // waiting out a timer.
  useEffect(() => {
    if (!deciding || reducedMotion) return;
    const id = window.setTimeout(() => {
      setBarIndex((current) => Math.min(current + 1, lastIndex));
    }, BULLET_TIME_DECISION_WINDOW_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [deciding, reducedMotion, lastIndex]);

  // The decision window's two explicit choices -- absolute stances, not
  // a toggle: "Ride it out" ensures the player ends up holding (a move
  // is only recorded if they're currently in cash), "Step aside" ensures
  // they end up in cash (a move only if currently holding). Either way,
  // making a choice is what advances past the deciding bar; the
  // resulting position -- explicit or auto-locked -- is all
  // evaluateBulletTimeCall ever looks at.
  function commitBulletTimeChoice(target: Position) {
    if (position !== target) setMoves((current) => [...current, barIndex]);
    setBarIndex((current) => Math.min(current + 1, lastIndex));
  }
  function handleRideItOut() {
    commitBulletTimeChoice("holding");
  }
  function handleStepAside() {
    commitBulletTimeChoice("cash");
  }

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

      {/* Bullet Time's approach/catch-up cue -- a plain line of text
          above the readouts, not an on-chart element (see
          BeatTheBenchChart's own note on why it draws no in-SVG time
          labels; the same "too small to read, and it'd overprint the
          chart's own live dot" reasoning applies to any new on-chart
          element). The decision window itself replaces the readouts
          entirely, below -- there's no "Big swing incoming" banner text
          duplicated in both places. */}
      {biStatus.phase === "approaching" && (
        <p className="text-sm font-medium text-[var(--text-secondary)]">Big swing incoming…</p>
      )}
      {biStatus.phase === "catchup" && (
        <p className="text-sm font-medium text-[var(--text-secondary)]">Catching up…</p>
      )}
      {recentlyResolvedSentence !== null && (
        <p
          className={`text-sm font-medium ${
            recentlyResolvedCall === "correct"
              ? "text-[var(--accent-reward)]"
              : "text-[var(--text-secondary)]"
          }`}
        >
          {recentlyResolvedCall === "correct" && <span aria-hidden="true">★ </span>}
          {recentlyResolvedSentence}
        </p>
      )}

      {/* The live readouts and the trade control belong to a session in
          progress. Once it settles they're replaced by the settlement
          card below rather than left on screen greyed out: they'd
          otherwise restate the same two balances a second time, one
          rounded pair of figures directly above another. */}
      {!settled && deciding && (
        <BulletTimeDecisionPanel
          eventIndex={biStatus.eventIndex}
          reducedMotion={reducedMotion}
          onRideItOut={handleRideItOut}
          onStepAside={handleStepAside}
        />
      )}
      {!settled && !deciding && (
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
          bulletTimeEvents={bulletTimeEvents}
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
          would make the page unusable with a screen reader. Bullet
          Time's own deciding prompt and live resolution are announced
          too, the same "a discrete moment, not a per-frame value" rule
          the rest of this region already follows. */}
      <p role="status" aria-live="polite" className="sr-only">
        {settled
          ? `Session over. ${outcomeHeadline(settlement)}. You finished at ${formatHeroCurrency(settlement.playerBalance)}, the bench at ${formatHeroCurrency(settlement.benchmarkBalance)}.`
          : deciding
            ? "Big swing incoming. Choose Ride it out or Step aside."
            : recentlyResolvedSentence !== null
              ? recentlyResolvedSentence
              : position === "holding"
                ? "In the market."
                : "In cash."}
      </p>
    </div>
  );
}

/**
 * Bullet Time's decision window -- replaces the live readouts and the
 * ordinary toggle entirely while it's open (see `SessionGame`'s own
 * `!deciding` gate), rather than sitting alongside them: this is the one
 * moment the mechanic asks for an actual, absolute stance, not a
 * relative flip.
 *
 * **Button copy is "Ride it out"/"Step aside," not the ordinary
 * toggle's "Sell, go to cash"/"Buy back in" (issue #224's own explicit
 * choice, decided here).** The existing toggle labels are phrased
 * relative to whatever the player currently holds -- exactly right for
 * a single, always-available flip, but wrong here: Bullet Time wants two
 * *absolute* choices always on screen together, so a player who isn't
 * sure what they're currently holding can still commit unambiguously,
 * and clicking the choice that happens to already match their position
 * is still a real, explicit call (see `SessionGame`'s own
 * `handleRideItOut`/`handleStepAside`) rather than a dead button. The
 * design review's own mockup used this exact framing.
 *
 * The countdown bar is the one piece gated on `!reducedMotion` -- see
 * `.bullet-time-countdown-bar`'s own doc comment in globals.css for why
 * it's a plain CSS animation rather than the design review's own SVG
 * ring sketch, and this file's own top note for why reduced motion drops
 * it (and the auto-lock timer behind it) entirely in favour of a plain,
 * un-timed prompt.
 */
function BulletTimeDecisionPanel({
  eventIndex,
  reducedMotion,
  onRideItOut,
  onStepAside,
}: {
  /** The current event's own index within its session's schedule -- keyed onto the countdown bar below so a fresh decision window always gets a fresh DOM node, guaranteeing its CSS animation restarts from full even if this panel component itself ever stayed mounted across two different events. */
  eventIndex: number;
  reducedMotion: boolean;
  onRideItOut: () => void;
  onStepAside: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--gridline)] bg-[var(--surface-2)] px-4 py-4">
      <p className="font-display text-base font-semibold text-[var(--text-primary)]">
        Big swing incoming
      </p>
      <p className="text-sm text-[var(--text-secondary)]">
        Stay in the market, or step out before it moves.
      </p>
      {!reducedMotion && (
        <div
          aria-hidden="true"
          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-1)]"
        >
          <div
            key={eventIndex}
            className="bullet-time-countdown-bar h-full rounded-full bg-[var(--accent-selection)]"
            style={{ animationDuration: `${BULLET_TIME_DECISION_WINDOW_MS}ms` }}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRideItOut}
          className={`${CONTROL_CLASS} bg-[var(--accent-selection)] text-white`}
        >
          Ride it out
        </button>
        <button
          type="button"
          onClick={onStepAside}
          className={`${CONTROL_CLASS} bg-[var(--surface-1)] text-[var(--text-primary)]`}
        >
          Step aside
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {reducedMotion
          ? "Step forward if you'd rather not choose -- it locks you into whatever you're already holding, no penalty."
          : "No choice locks you into whatever you're already holding -- no fees, no penalty."}
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
 * loss or a tie stamp stays in plain text. Bullet Time's own tally line
 * (issue #224) is a deliberate exception: it earns the same treatment
 * whenever every call landed correctly (see the tally paragraph below),
 * the identical "you earned this" reasoning applied to a different
 * figure.
 */
function FinalSettlement({
  session,
  settlement,
  moveBarIndexes,
  bulletTimeEvents,
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
  bulletTimeEvents: readonly BulletTimeEvent[];
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

  // Every event's own call is resolvable unconditionally here -- by the
  // time a session has settled, every scheduled event's own
  // `swing.toIndex` is already behind `barIndex` (see
  // `resolvedBulletTimeCalls`'s own doc comment). `[]` for a session
  // that never scheduled one renders no tally line at all, not a
  // misleading "0 of 0" -- see `bulletTimeTallyLine`.
  const bulletTimeResults = useMemo(
    () => resolvedBulletTimeCalls(bulletTimeEvents, moveBarIndexes),
    [bulletTimeEvents, moveBarIndexes],
  );
  const bulletTimeTally = bulletTimeTallyLine(bulletTimeResults);

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

      {bulletTimeTally !== null && (
        <p
          className={`font-numeric text-sm tabular-nums ${
            bulletTimeResults.every((result) => result === "correct")
              ? "font-semibold text-[var(--accent-reward)]"
              : "text-[var(--text-secondary)]"
          }`}
        >
          {bulletTimeTally}
        </p>
      )}

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
