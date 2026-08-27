"use client";

// Beat the Bench (issue #131): a playable, real-time ticking-chart
// buy/sell game against this app's own SPY benchmark, Today's Close mode.
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
// Out of scope here, by the issue: Mystery Day and the best-moves/
// percentile settlement narrative (both issue #132), and weekly/monthly
// modes (backlog). The chooser is deliberately built as a list of mode
// cards with one card in it, so #132 adds a card rather than a layout.

import { useEffect, useId, useState } from "react";

import type { TodaysCloseSession } from "@hadiknowntrades/core";

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
import {
  readPlayedSession,
  savePlayedSession,
  type PlayedSession,
} from "@/lib/beat-the-bench-storage";
import { formatDate, formatTime } from "@/lib/format-date";
import { formatHeroCurrency, formatSessionPercent } from "@/lib/format-currency";
import { useReducedMotionAfterMount } from "@/lib/use-reduced-motion-after-mount";
import { useTodaysCloseSession } from "@/lib/use-todays-close-session";
import { BeatTheBenchChart } from "@/components/BeatTheBenchChart";

const MODE = "todays-close" as const;

/** Every control in the playback row shares this: >= 44px in both directions at any width (`min-h-11`/`min-w-11` are 44px), per issue #131's touch-target criterion. The row wraps rather than shrinking these. */
const CONTROL_CLASS =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--gridline)] px-3 text-sm font-medium";

export function BeatTheBench() {
  const state = useTodaysCloseSession();
  const headingId = useId();

  if (state === null || state.status === "loading") {
    return (
      <BeatTheBenchFrame headingId={headingId}>
        <p className="text-sm text-[var(--text-muted)]">Looking up the latest session…</p>
      </BeatTheBenchFrame>
    );
  }

  if (state.status === "error" || !isPlayableSession(state.data)) {
    return (
      <BeatTheBenchFrame headingId={headingId}>
        <p className="text-sm text-[var(--text-secondary)]">
          There&apos;s no session to play right now. A day&apos;s bars are published by the nightly
          run, shortly after the close.
        </p>
      </BeatTheBenchFrame>
    );
  }

  return (
    <BeatTheBenchFrame headingId={headingId}>
      {/* Keyed on the session's own date so a fresh trading day starts a
          genuinely fresh game (state, stored-record read and all) rather
          than carrying yesterday's bar index into today's bars. */}
      <SessionGame key={state.data.date} session={state.data} />
    </BeatTheBenchFrame>
  );
}

function BeatTheBenchFrame({
  headingId,
  children,
}: {
  headingId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="surface-card flex flex-col gap-4 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-4"
    >
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="text-lg font-semibold text-[var(--text-primary)]">
          Beat the Bench
        </h2>
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

function SessionGame({ session }: { session: TodaysCloseSession }) {
  const bars = session.bars;
  const lastIndex = bars.length - 1;
  const reducedMotion = useReducedMotionAfterMount();

  const [playing, setPlaying] = useState(false);
  const [barIndex, setBarIndex] = useState(0);
  const [moves, setMoves] = useState<number[]>([]);
  const [speed, setSpeed] = useState<PlaybackSpeed>(DEFAULT_SPEED);
  const [paused, setPaused] = useState(false);
  const [playedRecord, setPlayedRecord] = useState<PlayedSession | null>(null);

  // Whether the session has finished is *derived*, not a third phase to
  // keep in sync: playback simply runs out of bars. Nothing has to
  // transition anything, so there's no window in which the bar index and
  // the phase disagree.
  const settled = playing && barIndex >= lastIndex;
  const settlement = settleSession(bars, moves, STARTING_CAPITAL);
  const position = positionAfterBar(moves, barIndex);

  // Read after mount, never during render: this component renders on the
  // server (issue #122 mounts it at the ResultsPage level), so a
  // synchronous storage read here would make the hydration render
  // disagree with the server's. Same deferred-correction shape
  // use-hydrated-local-storage-state.ts uses.
  useEffect(() => {
    queueMicrotask(() => setPlayedRecord(readPlayedSession(session.date, MODE)));
  }, [session.date]);

  // Advance one bar per tick. `atEnd` (not `barIndex`) is in the dep
  // array on purpose: depending on the index itself would tear down and
  // rebuild the interval on every single tick, so each tick's real
  // spacing would drift by however long the render took.
  const atEnd = barIndex >= lastIndex;
  useEffect(() => {
    if (!playing || paused || atEnd) return;
    const id = window.setInterval(() => {
      setBarIndex((current) => Math.min(current + 1, lastIndex));
    }, tickIntervalMs(speed));
    return () => {
      window.clearInterval(id);
    };
  }, [playing, paused, atEnd, speed, lastIndex]);

  // Persist "played this session, and how it came out" the moment it
  // settles -- the `hikt:beat-the-bench:{date}:{mode}` entry issue #133's
  // status rail reads. Writing fails silently if storage is unavailable
  // (see local-storage.ts); the game itself is unaffected either way.
  useEffect(() => {
    if (!settled) return;
    const record: PlayedSession = {
      played: true,
      outcome: settlement.outcome,
      playerBalance: settlement.playerBalance,
      benchmarkBalance: settlement.benchmarkBalance,
      moves: settlement.moves,
    };
    savePlayedSession(session.date, MODE, record);
    queueMicrotask(() => setPlayedRecord(record));
    // Keyed on the primitives that define this settlement, not on the
    // freshly-built `settlement`/`record` objects (a new identity every
    // render, which would rewrite storage on every one).
  }, [
    settled,
    session.date,
    settlement.outcome,
    settlement.playerBalance,
    settlement.benchmarkBalance,
    settlement.moves,
  ]);

  function startSession() {
    setBarIndex(0);
    setMoves([]);
    setSpeed(DEFAULT_SPEED);
    // Reduced motion doesn't remove the mechanic here -- it changes how
    // it starts. Playback begins paused so nothing moves until the
    // viewer asks it to, and "Step forward one bar" (always present, for
    // everyone) is a complete way to play the session start to finish.
    setPaused(reducedMotion);
    setPlaying(true);
  }

  if (!playing) {
    return (
      <SessionChooser
        session={session}
        playedRecord={playedRecord}
        onStart={startSession}
        reducedMotion={reducedMotion}
      />
    );
  }

  const currentBar = bars[barIndex]!;
  const playerBalance = balanceAtBar(bars, moves, STARTING_CAPITAL, barIndex);
  const benchBalance = balanceAtBar(bars, [], STARTING_CAPITAL, barIndex);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-[var(--text-secondary)]">
          {session.ticker}, {formatDate(session.date)}
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
        <FinalSettlement session={session} settlement={settlement} onPlayAgain={startSession} />
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

function SessionChooser({
  session,
  playedRecord,
  onStart,
  reducedMotion,
}: {
  session: TodaysCloseSession;
  playedRecord: PlayedSession | null;
  onStart: () => void;
  reducedMotion: boolean;
}) {
  const seconds = Math.round(sessionDurationMs(session.bars.length, 1) / 1000);
  return (
    <div className="flex flex-col gap-3">
      {playedRecord !== null && (
        <p className="text-sm text-[var(--text-secondary)]">
          You&apos;ve played this one:{" "}
          <span
            className={
              playedRecord.outcome === "win"
                ? "font-semibold text-[var(--accent-reward)]"
                : "font-semibold text-[var(--text-primary)]"
            }
          >
            {outcomeHeadline({
              startingCapital: STARTING_CAPITAL,
              playerBalance: playedRecord.playerBalance,
              benchmarkBalance: playedRecord.benchmarkBalance,
              playerReturnFraction: playedRecord.playerBalance / STARTING_CAPITAL - 1,
              benchmarkReturnFraction: playedRecord.benchmarkBalance / STARTING_CAPITAL - 1,
              moves: playedRecord.moves,
              outcome: playedRecord.outcome,
            })}
          </span>
          , finishing at {formatHeroCurrency(playedRecord.playerBalance)} against the bench&apos;s{" "}
          {formatHeroCurrency(playedRecord.benchmarkBalance)}.
        </p>
      )}
      <button
        type="button"
        onClick={onStart}
        className="flex min-h-11 flex-col items-start gap-1 rounded-md border border-[var(--gridline)] bg-[var(--surface-2)] px-4 py-3 text-left"
      >
        <span className="text-base font-semibold text-[var(--text-primary)]">
          {playedRecord === null ? "Play today's close" : "Play it again"}
        </span>
        <span className="font-numeric text-sm tabular-nums text-[var(--text-muted)]">
          {session.ticker} · {formatDate(session.date)} · {session.bars.length} bars · about{" "}
          {seconds} seconds at normal speed
        </span>
      </button>
      {reducedMotion && (
        <p className="text-sm text-[var(--text-muted)]">
          You prefer reduced motion, so the session will start paused. Step through it a bar at a
          time, or press play whenever you&apos;d like.
        </p>
      )}
    </div>
  );
}

function PlaybackControls({
  paused,
  speed,
  reducedMotion,
  onTogglePause,
  onStep,
  onSpeed,
}: {
  paused: boolean;
  speed: PlaybackSpeed;
  reducedMotion: boolean;
  onTogglePause: () => void;
  onStep: () => void;
  onSpeed: (next: PlaybackSpeed) => void;
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
    </div>
  );
}

/**
 * Final Settlement: the win/loss/tie stamp against the bench, and both
 * sides' final dollars and percent.
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
  onPlayAgain,
}: {
  session: TodaysCloseSession;
  settlement: SessionSettlement;
  onPlayAgain: () => void;
}) {
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
      <p className="text-sm text-[var(--text-muted)]">
        {session.ticker}&apos;s real {session.barIntervalMinutes}-minute closes from{" "}
        {formatDate(session.date)}. No fees, no slippage -- every move settles at the price on
        screen.
      </p>
      <button
        type="button"
        onClick={onPlayAgain}
        className={`${CONTROL_CLASS} self-start bg-[var(--surface-1)] text-[var(--text-primary)]`}
      >
        Play it again
      </button>
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
