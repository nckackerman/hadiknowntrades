import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortfolioPoint } from "./portfolio-series";
import { createRafPump } from "./raf-pump.test-util";
import { stubPrefersReducedMotion } from "./stub-prefers-reduced-motion.test-util";
import { useTradeReplay, type ReplayPacing } from "./use-trade-replay";

// The rewind intro beat (issue #97) is 700ms -- with performance.now()
// pinned to 1000 throughout this file's tests (see each test's own
// vi.spyOn(performance, "now") call), any raf.tick(now) with `now >=
// 1700` completes it in a single tick, auto-advancing phase straight to
// "playing" with `frame` still exactly the untouched initial frame (the
// rewind never touches `frame`, only its own tween state feeding
// `displayDate`) -- see
// use-trade-replay.ts's own doc comment on why one tick is enough here,
// unlike the multi-segment playing effect below it.
const REWIND_COMPLETE_NOW = 1700;

/**
 * A single-trade window fixture: start flat at $20, an "open" event
 * (no value change), a mid-trade flat vertex, a "close" event that
 * doubles the balance to $40 (a real, easy-to-check 100% return), then a
 * trailing flat point at the window's end -- exactly the shape
 * derivePortfolioSeries's own appendTradeSteps produces for one trade
 * (see portfolio-series.ts's header comment).
 */
const ONE_TRADE_POINTS: PortfolioPoint[] = [
  { date: "2024-01-01", value: 20, event: null },
  {
    date: "2024-01-02",
    value: 20,
    event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
  },
  { date: "2024-01-05", value: 20, event: null },
  {
    date: "2024-01-05",
    value: 40,
    event: { type: "close", direction: "long", ticker: "AAPL", price: 200 },
  },
  { date: "2024-01-06", value: 40, event: null },
];

describe("useTradeReplay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // stubPrefersReducedMotion (the "rewinding phase" describe block
    // below) uses vi.stubGlobal, which vi.restoreAllMocks() alone
    // doesn't undo -- matching every other file in this app that uses
    // this stub (e.g. TradeReplay.test.tsx's own afterEach).
    vi.unstubAllGlobals();
  });

  it("starts idle, showing only the window's own opening point", () => {
    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    expect(result.current.phase).toBe("idle");
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.frame.activeEvent).toBeNull();
  });

  it("walks every point in order, pausing on each real trade event and tweening the balance between them, with displayDate advancing alongside revealedCount throughout (issue #107)", () => {
    // phaseStart is captured once via performance.now() when the effect
    // first runs -- pinning it to a fixed value lets every subsequent
    // pumped `now` argument encode an exact elapsed-time offset, the
    // same "pin performance.now(), control `now` directly" approach
    // use-count-up.test.ts's own "settles... for a non-positive
    // duration" test uses.
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
    // play() now enters "rewinding" first (issue #97), not "playing"
    // directly -- see REWIND_COMPLETE_NOW's own doc comment above for
    // why one tick is enough to complete it deterministically here.
    expect(result.current.phase).toBe("rewinding");
    raf.tick(REWIND_COMPLETE_NOW);
    expect(result.current.phase).toBe("playing");

    // Mid-tween toward the "open" event (t=0): still showing only the
    // start point, balance untouched. displayDate (issue #107) tracks
    // whichever point is currently revealed, not the tween's own
    // in-flight target -- still the window's own opening date here,
    // matching revealedCount === 1.
    raf.tick(1000);
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.displayDate).toBe("Jan 1, 2024");

    // Arrives at the "open" event (t=1, 300ms elapsed) -- reveals that
    // point and pauses on its callout. No value change (opening a
    // position doesn't move the balance). displayDate lands on the
    // open event's own real date in this same tick, no tween of its
    // own -- "landing on each trade's real event date at the moment its
    // callout shows," per the issue's own acceptance criterion.
    raf.tick(1300);
    expect(result.current.frame.revealedCount).toBe(2);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.frame.activeEvent?.event.type).toBe("open");
    expect(result.current.frame.activeEvent?.event.ticker).toBe("AAPL");
    expect(result.current.frame.activeEvent?.tradeReturn).toBeNull();
    expect(result.current.displayDate).toBe("Jan 2, 2024");

    // Still within the 600ms pause on the open event -- nothing changes,
    // displayDate included.
    raf.tick(1500);
    expect(result.current.frame.activeEvent?.event.type).toBe("open");
    expect(result.current.displayDate).toBe("Jan 2, 2024");

    // Pause elapses (600ms) and the mid-trade flat vertex (no event) is
    // reached in the same tick -- no pause for a plain point. displayDate
    // still advances to this point's own real date even though it
    // carries no trade event of its own.
    raf.tick(1900);
    raf.tick(2200);
    expect(result.current.frame.revealedCount).toBe(3);
    expect(result.current.frame.activeEvent).toBeNull();
    expect(result.current.displayDate).toBe("Jan 5, 2024");

    // Arrives at the "close" event -- the one point where the balance
    // actually jumps ($20 -> $40, a real 100% return), with a computed
    // tradeReturn matching the open price this hook found by scanning
    // backward. The close event shares its date with the prior flat
    // vertex here (both "2024-01-05"), so displayDate reads the same
    // text either side of this tick -- expected, not a bug: it's still
    // correctly tracking the real, currently-revealed point's own date.
    raf.tick(2500);
    expect(result.current.frame.revealedCount).toBe(4);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent?.event.type).toBe("close");
    expect(result.current.frame.activeEvent?.tradeReturn?.returnFraction).toBeCloseTo(1);
    expect(result.current.frame.activeEvent?.tradeReturn?.isGain).toBe(true);
    expect(result.current.phase).toBe("playing");
    expect(result.current.displayDate).toBe("Jan 5, 2024");

    // Pause elapses, the trailing end point (no event) is reached, and
    // playback finishes -- lands on exactly the same final state a
    // non-animated page load would show. This fixture's trailing point
    // carries no event, so its own arrival and the natural-completion
    // transition to "done" land in the same synchronous tick with
    // nothing in between to assert on -- the "natural completion resets
    // activeEvent to null..." test below (a fixture whose *last* point
    // is itself a close event) covers the case where the final point's
    // own displayDate genuinely is observable mid-playback, still
    // "playing", before the completion tick after it. displayDate
    // returns to null once "done" (per its own doc comment, only
    // "rewinding"/"playing" populate it).
    raf.tick(3100);
    raf.tick(3400);
    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(ONE_TRADE_POINTS.length);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent).toBeNull();
    expect(result.current.displayDate).toBeNull();
    expect(raf.hasQueuedFrame()).toBe(false);
  });

  it("skipToEnd lands on the exact same final state as a non-animated page load, at any point during rewinding or playback (issue #97)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
    // Mid-rewind, well before the end -- issue #97's own acceptance
    // criterion is that Skip to end works identically whether triggered
    // during this phase or during trade playback, so this test
    // deliberately leaves phase at "rewinding" (not completing it via
    // REWIND_COMPLETE_NOW first) to exercise exactly that case; the
    // sibling "walks every point..." test above already exercises
    // skipToEnd from mid-"playing" indirectly via its own use of
    // skipToEnd in other tests below.
    expect(result.current.phase).toBe("rewinding");
    raf.tick(1000);

    act(() => {
      result.current.skipToEnd();
    });

    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(ONE_TRADE_POINTS.length);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent).toBeNull();
    expect(result.current.displayDate).toBeNull();

    // The stale in-flight frame from before skipToEnd must not clobber
    // this final state once it (would have) fired.
    raf.tick(2000);
    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(ONE_TRADE_POINTS.length);
  });

  it("play() after done (the Replay affordance) restarts from the very beginning", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
    act(() => {
      result.current.skipToEnd();
    });
    expect(result.current.phase).toBe("done");

    act(() => {
      result.current.play();
    });

    // Re-enters "rewinding" first (issue #97), same as the very first
    // play() call -- "Replay" restarts the whole beat, not just the
    // trade walk. `frame` itself is already reset to the initial frame
    // regardless of phase (play() sets it before choosing which phase
    // to enter), so those assertions hold immediately.
    expect(result.current.phase).toBe("rewinding");
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.frame.activeEvent).toBeNull();

    raf.tick(REWIND_COMPLETE_NOW);
    expect(result.current.phase).toBe("playing");

    raf.tick(1300);
    expect(result.current.frame.activeEvent?.event.type).toBe("open");
  });

  it("play() is a no-op for fewer than two points (nothing to walk through)", () => {
    createRafPump();
    const single: PortfolioPoint[] = [{ date: "2024-01-01", value: 20, event: null }];
    const { result } = renderHook(() => useTradeReplay(single));

    act(() => {
      result.current.play();
    });

    expect(result.current.phase).toBe("idle");
  });

  it("treats a mid-flight `points` reference change as a fresh mount, not a silent rebuild (code review, issue #96 follow-up)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result, rerender } = renderHook(
      (points: readonly PortfolioPoint[]) => useTradeReplay(points),
      { initialProps: ONE_TRADE_POINTS as readonly PortfolioPoint[] },
    );

    act(() => {
      result.current.play();
    });
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat (issue #97), landing on "playing"
    raf.tick(1000);
    raf.tick(1300); // paused on the open event -- well into a real mid-flight walk

    expect(result.current.phase).toBe("playing");
    expect(result.current.frame.revealedCount).toBe(2);

    // Stands in for a live starting-capital edit or ModeToggle switch --
    // both recompute ResultsPanel's own `points` memo to a brand-new
    // array reference without ever unmounting TradeReplay.
    const RESCALED_POINTS: PortfolioPoint[] = ONE_TRADE_POINTS.map((p) => ({
      ...p,
      value: p.value * 2,
    }));

    act(() => {
      rerender(RESCALED_POINTS);
    });

    // Resets to idle against the *new* points rather than continuing a
    // stale mid-flight walk through data that no longer matches what's
    // on screen -- which would otherwise snap revealedCount/currentValue
    // backward and re-narrate an already-shown trade with no indication
    // anything reset.
    expect(result.current.phase).toBe("idle");
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(RESCALED_POINTS[0]!.value);
    expect(result.current.frame.activeEvent).toBeNull();

    // The old points' in-flight RAF loop doesn't resume and clobber this
    // reset once it (would have) fired.
    expect(raf.hasQueuedFrame()).toBe(false);
  });

  it("treats a mid-*rewind* `points` reference change the same defensive way a mid-playback change is handled (issue #97)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result, rerender } = renderHook(
      (points: readonly PortfolioPoint[]) => useTradeReplay(points),
      { initialProps: ONE_TRADE_POINTS as readonly PortfolioPoint[] },
    );

    act(() => {
      result.current.play();
    });
    raf.tick(1000); // mid-rewind, well before it completes
    expect(result.current.phase).toBe("rewinding");
    expect(result.current.displayDate).not.toBeNull();

    const RESCALED_POINTS: PortfolioPoint[] = ONE_TRADE_POINTS.map((p) => ({
      ...p,
      value: p.value * 2,
    }));

    act(() => {
      rerender(RESCALED_POINTS);
    });

    // Same reset use-trade-replay.ts's own [points]-keyed
    // useResetWhenChanged call already gives a mid-*playing* change --
    // it fires for any phase !== "idle", "rewinding" included, so this
    // needed no separate code path, only this test to confirm it.
    expect(result.current.phase).toBe("idle");
    expect(result.current.displayDate).toBeNull();
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(RESCALED_POINTS[0]!.value);
    expect(result.current.frame.activeEvent).toBeNull();

    // The old points' in-flight rewind loop doesn't resume and clobber
    // this reset once it (would have) fired.
    expect(raf.hasQueuedFrame()).toBe(false);
  });

  it("contains (rather than silently freezing on) a corrupted stored price mid-playback -- logs and skips to the final state", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const raf = createRafPump();

    // Identical shape to ONE_TRADE_POINTS, except the close event's own
    // price is invalid (non-positive) -- computeTradeReturn's
    // InvalidTradePriceError throws exactly here (see trade-math.ts),
    // inside this hook's own RAF callback rather than during a render.
    const CORRUPT_POINTS: PortfolioPoint[] = [
      { date: "2024-01-01", value: 20, event: null },
      {
        date: "2024-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "BAD", price: 100 },
      },
      { date: "2024-01-05", value: 20, event: null },
      {
        date: "2024-01-05",
        value: 40,
        event: { type: "close", direction: "long", ticker: "BAD", price: 0 },
      },
      { date: "2024-01-06", value: 40, event: null },
    ];

    const { result } = renderHook(() => useTradeReplay(CORRUPT_POINTS));

    act(() => {
      result.current.play();
    });
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat (issue #97), landing on "playing"
    raf.tick(1000); // tween toward the open event
    raf.tick(1300); // arrives at the open event, pauses
    raf.tick(1900); // pause elapses, advances through the flat vertex (no event)
    raf.tick(2200); // tween toward the close event
    raf.tick(2500); // arrives at the close event -- computeTradeReturn throws here

    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(CORRUPT_POINTS.length);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent).toBeNull();
    // displayDate must also be null here, not just after skipToEnd/
    // natural completion (code review follow-up, issue #97 -- this
    // defensive catch is one of this hook's three setPhase("done") call
    // sites, and displayDate's own doc comment promises "null in
    // idle/done").
    expect(result.current.displayDate).toBeNull();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(raf.hasQueuedFrame()).toBe(false);
  });

  it("natural completion resets activeEvent to null even when the last trade's close is the window's own final point (code review, issue #96 follow-up)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    // Mirrors what derivePortfolioSeries produces when a trade's own
    // closeDate equals the window's endDate -- it appends no trailing
    // flat point in that case (see its own `if (!last || last.date !==
    // endDate)` guard), so the close event is literally the array's
    // last entry, with nothing after it to "fall through" to.
    const NO_TRAILING_POINT: PortfolioPoint[] = [
      { date: "2024-01-01", value: 20, event: null },
      {
        date: "2024-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
      },
      { date: "2024-01-05", value: 20, event: null },
      {
        date: "2024-01-05",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 200 },
      },
    ];

    const { result } = renderHook(() => useTradeReplay(NO_TRAILING_POINT));

    act(() => {
      result.current.play();
    });
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat (issue #97), landing on "playing"
    raf.tick(1000);
    raf.tick(1300); // pauses on the open event
    raf.tick(1900); // pause elapses, flat vertex reached (no pause)
    raf.tick(2200); // tween toward the close event
    raf.tick(2500); // pauses on the close event -- activeEvent set here

    // The close event is this fixture's own *last* point, so this is
    // the one case where the final point's displayDate is genuinely
    // observable while phase is still "playing" (issue #107) -- unlike
    // a fixture with a trailing no-event point, where the last
    // point's own arrival and the natural-completion transition happen
    // in the same synchronous tick with nothing in between to assert.
    expect(result.current.frame.revealedCount).toBe(NO_TRAILING_POINT.length);
    expect(result.current.phase).toBe("playing");
    expect(result.current.displayDate).toBe("Jan 5, 2024");

    raf.tick(3100); // pause elapses -- no more segments, natural completion

    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(NO_TRAILING_POINT.length);
    expect(result.current.frame.currentValue).toBe(40);
    // The real regression this test guards: without resetting the
    // frame on natural completion, this would still be the close
    // event's own ReplayEvent, left over from the tick(2500) pause.
    expect(result.current.frame.activeEvent).toBeNull();
    // displayDate also returns to null once "done" -- see its own doc
    // comment (only "rewinding"/"playing" populate it).
    expect(result.current.displayDate).toBeNull();
  });

  it("play() while already rewinding is a no-op -- same hook-level API contract as the already-playing case below (issue #97)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
    raf.tick(1000); // mid-rewind, well before it completes
    expect(result.current.phase).toBe("rewinding");
    const displayDateBeforeSecondPlay = result.current.displayDate;

    act(() => {
      result.current.play();
    });

    // Still rewinding, undisturbed -- not reset back to the very start
    // of a fresh rewind.
    expect(result.current.phase).toBe("rewinding");
    expect(result.current.displayDate).toBe(displayDateBeforeSecondPlay);

    // The original rewind keeps advancing normally afterward.
    raf.tick(REWIND_COMPLETE_NOW);
    expect(result.current.phase).toBe("playing");
  });

  it("play() while already playing is a no-op -- not reachable via the shipped UI (the button that calls play() is hidden while playing), but a real hook-level API contract (code review, issue #96 follow-up round four)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat (issue #97), landing on "playing"
    raf.tick(1000);
    raf.tick(1300); // paused on the open event, well into the walk
    expect(result.current.frame.revealedCount).toBe(2);

    // Calling play() again while already "playing" must not disturb the
    // in-flight walk. Simplified in round four from an earlier `runId`-
    // based "force a restart from the beginning" fix down to a plain
    // `phase === "playing"` guard inside play() itself, once it was
    // noticed every reachable call site only ever calls play() from
    // "idle"/"done", never "playing" -- a no-op is also the more literal
    // reading of "idempotent," which is what the original round-two fix
    // was actually named for.
    act(() => {
      result.current.play();
    });

    expect(result.current.phase).toBe("playing");
    expect(result.current.frame.revealedCount).toBe(2);
    expect(result.current.frame.activeEvent?.event.type).toBe("open");

    // The original walk keeps advancing normally afterward -- the no-op
    // play() call didn't tear down or otherwise disturb the running RAF
    // loop.
    raf.tick(1900);
    raf.tick(2200);
    expect(result.current.frame.revealedCount).toBe(3);
    expect(result.current.frame.activeEvent).toBeNull();
  });

  it("completedRuns is bumped exactly once per genuine completion (skipToEnd and natural completion), not on play() itself", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));
    expect(result.current.completedRuns).toBe(0);

    act(() => {
      result.current.play();
    });
    expect(result.current.completedRuns).toBe(0);

    act(() => {
      result.current.skipToEnd();
    });
    expect(result.current.completedRuns).toBe(1);

    // Replaying and letting it walk all the way to a natural completion
    // (rather than skipToEnd again) bumps it a second time -- confirms
    // this hook's own `completedRuns` counter is bumped at every one of
    // its three `setPhase("done")` call sites, not just skipToEnd's.
    act(() => {
      result.current.play();
    });
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat (issue #97), landing on "playing"
    raf.tick(1000);
    raf.tick(1300); // pauses on the open event
    raf.tick(1900); // pause elapses, flat vertex reached
    raf.tick(2200); // tween toward the close event
    raf.tick(2500); // pauses on the close event
    raf.tick(3100); // pause elapses, trailing flat point reached
    raf.tick(3400); // tween settles -- natural completion
    expect(result.current.phase).toBe("done");
    expect(result.current.completedRuns).toBe(2);
  });

  describe("pacing parameter (issue #105)", () => {
    it("defaults preserved when omitted -- every existing test above already exercises this implicitly (300ms/600ms/700ms), confirmed explicitly here too", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();

      const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

      act(() => {
        result.current.play();
      });
      raf.tick(699); // 1ms short of the default 700ms rewindMs -- not yet complete
      expect(result.current.phase).toBe("rewinding");
      raf.tick(1700); // 700ms elapsed -- completes on schedule
      expect(result.current.phase).toBe("playing");
    });

    it("a custom pacing object's values actually drive the RAF timing, not the module's own defaults", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();
      const pacing: ReplayPacing = { transitionMs: 100, eventPauseMs: 50, rewindMs: 200 };

      const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS, pacing));

      act(() => {
        result.current.play();
      });
      expect(result.current.phase).toBe("rewinding");

      // The default rewindMs (700ms) would still be mid-rewind here --
      // this custom 200ms value completes well before that.
      raf.tick(1100); // 100ms elapsed -- not yet complete under this custom rewindMs
      expect(result.current.phase).toBe("rewinding");
      raf.tick(1200); // 200ms elapsed -- completes
      expect(result.current.phase).toBe("playing");

      // transitionMs=100 (not the default 300ms) drives the first
      // segment's tween toward the "open" event.
      raf.tick(1050); // 50ms elapsed -- still tweening under this custom transitionMs
      expect(result.current.frame.revealedCount).toBe(1);
      raf.tick(1100); // 100ms elapsed -- reaches & pauses on the open event
      expect(result.current.frame.revealedCount).toBe(2);
      expect(result.current.frame.activeEvent?.event.type).toBe("open");

      // eventPauseMs=50 (not the default 600ms) governs this pause.
      raf.tick(1140); // 40ms elapsed since the pause began -- still paused
      expect(result.current.frame.activeEvent?.event.type).toBe("open");
      raf.tick(1150); // 50ms elapsed -- pause elapses, advances toward the next point
      raf.tick(1250); // the next segment's own 100ms tween completes -- the flat vertex (no event), revealed with no further pause
      expect(result.current.frame.revealedCount).toBe(3);
      expect(result.current.frame.activeEvent).toBeNull();
    });
  });

  describe("datetime-labeled (chained-intraday) points -- issue #105", () => {
    // Mirrors deriveWholeRangeIntradaySeries's own point shape (issue
    // #91/#105): datetime-labeled ("YYYY-MM-DDTHH:MM:SS"), spanning more
    // than one calendar day.
    const DATETIME_POINTS: PortfolioPoint[] = [
      { date: "2025-08-21T09:30:00", value: 20, event: null },
      {
        date: "2025-08-21T10:30:00",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
      },
      { date: "2025-08-21T11:30:00", value: 20, event: null },
      {
        date: "2025-08-21T11:30:00",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 200 },
      },
      { date: "2025-08-22T09:30:00", value: 40, event: null },
    ];

    it("the rewind tween's own target date formats correctly against a datetime-labeled point, not 'Invalid Date' (real bug, found while implementing issue #105)", () => {
      // The old `Date.parse(`${points[0]!.date}T00:00:00Z`)` produced a
      // malformed double-`T` string against a datetime-labeled point
      // ("2025-08-21T09:30:00T00:00:00Z"), which Date.parse silently
      // resolves to NaN -- the rewind's own tween target would be NaN,
      // and every formatted value from that point on reads "Invalid
      // Date" for the whole rewind beat.
      vi.spyOn(performance, "now").mockReturnValue(1000);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-08-25T00:00:00Z"));
      const raf = createRafPump();

      const { result } = renderHook(() => useTradeReplay(DATETIME_POINTS));

      act(() => {
        result.current.play();
      });
      raf.tick(1000); // t=0, tweening from "now"
      expect(result.current.displayDate).not.toBe("Invalid Date");
      raf.tick(1690); // t close to 1 -- would already show NaN under the old bug
      expect(result.current.displayDate).not.toBe("Invalid Date");
      raf.tick(1700); // completes the rewind, landing on the series' own real start datetime
      expect(result.current.phase).toBe("playing");
    });

    it("the playing-phase readout formats a datetime-labeled point with its own date, not just a bare time -- and not 'Invalid Date' (real bug, same class as the rewind fix above, found while implementing issue #105)", () => {
      // The old bare `formatDate(points[index]!.date)` call unconditionally
      // did the exact same malformed-double-`T` `Date.parse` the rewind
      // fix above avoids -- the identical bug for the whole rest of
      // forward playback, not just the rewind beat.
      vi.spyOn(performance, "now").mockReturnValue(1000);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-08-25T00:00:00Z"));
      const raf = createRafPump();

      const { result } = renderHook(() => useTradeReplay(DATETIME_POINTS));

      act(() => {
        result.current.play();
      });
      raf.tick(1700); // completes the rewind, landing on "playing"
      expect(result.current.phase).toBe("playing");
      // Lands on the series' own first point's real datetime, formatted
      // with the date included (chained-intraday points always
      // disambiguate their own day, per formatDateTime's own doc
      // comment) -- "Aug 21, 9:30 AM", not "Invalid Date".
      expect(result.current.displayDate).toBe("Aug 21, 9:30 AM");

      raf.tick(1000); // tween toward the "open" event
      raf.tick(1300); // arrives at the "open" event, pauses
      expect(result.current.frame.activeEvent?.event.type).toBe("open");
      expect(result.current.displayDate).toBe("Aug 21, 10:30 AM");
    });
  });

  describe("rewinding phase (issue #97)", () => {
    it("play() enters 'rewinding' before 'playing', ticking a backward date readout that lands on the result's real start date", () => {
      // performance.now() drives elapsed-time math (pinned to 1000, as
      // every other test in this file pins it); Date.now() is the
      // separate, real-wall-clock value the rewind's own readout tweens
      // *from* -- pinned independently here so the readout's start
      // value is deterministic too.
      vi.spyOn(performance, "now").mockReturnValue(1000);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2024-06-15T00:00:00Z"));
      const raf = createRafPump();

      const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

      act(() => {
        result.current.play();
      });
      expect(result.current.phase).toBe("rewinding");
      // frame is untouched by the rewind -- still exactly the initial
      // frame play() itself set before choosing which phase to enter.
      expect(result.current.frame.revealedCount).toBe(1);
      expect(result.current.frame.currentValue).toBe(20);
      // No tick has fired yet -- the readout hasn't rendered its first
      // value.
      expect(result.current.displayDate).toBeNull();

      // t=0: the readout starts at "now" (the mocked Date.now() above).
      raf.tick(1000);
      expect(result.current.displayDate).toBe("Jun 15, 2024");
      expect(result.current.phase).toBe("rewinding");

      // t=1 (700ms elapsed, REWIND_COMPLETE_NOW): auto-advances to
      // "playing" on its own, with no further action needed from a
      // caller. `displayDate` doesn't drop to null here (issue #107
      // extended the readout through "playing" too) -- it switches from
      // the rewind's own tweened value to the real revealed point's own
      // date instead, with no visible gap: `frame` is still untouched
      // (revealedCount 1, the window's own opening point), so this
      // lands on that same point's real date, `points[0].date` --
      // exactly the value the rewind was ticking *toward* in the first
      // place, so the readout reads as continuous across this exact
      // tick, not as a value disappearing and a different one
      // appearing.
      raf.tick(REWIND_COMPLETE_NOW);
      expect(result.current.displayDate).toBe("Jan 1, 2024");
      expect(result.current.phase).toBe("playing");
    });

    it("displayDate returns to null on natural completion, not just skipToEnd -- a stale value must not survive into a fresh Replay (code review follow-up, real bug -- originally about rewindDate, still applies to its displayDate successor)", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2024-06-15T00:00:00Z"));
      const raf = createRafPump();

      const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

      act(() => {
        result.current.play();
      });
      raf.tick(1000); // mid-rewind -- displayDate is genuinely non-null here
      expect(result.current.displayDate).not.toBeNull();
      raf.tick(REWIND_COMPLETE_NOW); // completes the rewind, landing on "playing"

      // Walk all the way to a *natural* completion (not skipToEnd, which
      // already clears the rewind's own internal tween state correctly)
      // -- the real gap this test guards: the "advance past the last
      // segment" branch used to only call setPhase("done"), leaving that
      // internal state holding the previous run's own target date all
      // through "done" (back when this field was still `rewindDate`,
      // directly exposing that state rather than deriving `displayDate`
      // fresh -- see that field's own doc comment for the current
      // shape).
      raf.tick(1300); // pauses on the open event
      raf.tick(1900); // pause elapses, flat vertex reached
      raf.tick(2200); // tween toward the close event
      raf.tick(2500); // pauses on the close event
      raf.tick(3100); // pause elapses, trailing flat point reached
      raf.tick(3400); // tween settles -- natural completion
      expect(result.current.phase).toBe("done");
      expect(result.current.displayDate).toBeNull();

      // Replay must not flash the previous run's own stale target date
      // for even one frame before the first new tick corrects it --
      // displayDate should already be null the instant "rewinding" is
      // (re-)entered, not just once the next tick fires.
      act(() => {
        result.current.play();
      });
      expect(result.current.phase).toBe("rewinding");
      expect(result.current.displayDate).toBeNull();
    });

    it("prefers-reduced-motion skips the rewind entirely -- play() lands straight on 'playing', matching pre-#97 behavior", () => {
      stubPrefersReducedMotion(true);
      // The very first available frame settles any real tween (mirrors
      // use-count-up.test.ts's own reduced-motion test) -- here, no
      // frame should even be scheduled for a "rewinding" phase that's
      // never entered.
      const raf = createRafPump();

      const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

      act(() => {
        result.current.play();
      });

      expect(result.current.phase).toBe("playing");
      // The rewinding effect's own body never ran (phase skipped
      // straight past "rewinding"), so its own tween state never fed
      // `displayDate` -- but the playing-phase readout (issue #107)
      // doesn't come from that state at all, it's derived straight from
      // `frame`/`points`, so it's already populated even before the
      // playing effect's own first tick fires: `frame` is still the
      // initial frame `play()` itself set (revealedCount 1), so this is
      // the window's own opening point's real date.
      expect(result.current.displayDate).toBe("Jan 1, 2024");
      // Still one real queued frame, from the playing effect.
      expect(raf.hasQueuedFrame()).toBe(true);
    });
  });

  describe("chunk segment mode (issue #118, docs/plans/issue-106-plan.md)", () => {
    // Day 1: one trade (AAPL, 100 -> 150, a real 50% gain). Day 2: no
    // trades. Day 3: one trade (MSFT, 100 -> 120, a real 20% gain).
    // Fewer days than NUM_CHUNKS (30), so every day maps to its own
    // chunk (1M's own common shape) -- each single-trade day is a
    // one-day/one-trade degenerate chunk, falling through to the real,
    // shared ReplayEvent shape (not a ChunkSummary).
    const CHUNK_POINTS: PortfolioPoint[] = [
      { date: "2025-01-01T09:30:00", value: 20, event: null },
      {
        date: "2025-01-01T09:30:00",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
      },
      { date: "2025-01-01T10:30:00", value: 20, event: null },
      {
        date: "2025-01-01T10:30:00",
        value: 30,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 150 },
      },
      { date: "2025-01-02T12:00:00", value: 30, event: null },
      { date: "2025-01-03T09:30:00", value: 30, event: null },
      {
        date: "2025-01-03T09:30:00",
        value: 30,
        event: { type: "open", direction: "long", ticker: "MSFT", price: 100 },
      },
      { date: "2025-01-03T10:00:00", value: 30, event: null },
      {
        date: "2025-01-03T10:00:00",
        value: 36,
        event: { type: "close", direction: "long", ticker: "MSFT", price: 120 },
      },
    ];

    it("walks day by day: a one-day/one-trade chunk lands on the real ReplayEvent (not a ChunkSummary), a no-trade chunk advances with zero pause", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();
      const pacing: ReplayPacing = { transitionMs: 100, eventPauseMs: 50, rewindMs: 200 };

      const { result } = renderHook(() => useTradeReplay(CHUNK_POINTS, pacing, "chunk"));

      act(() => {
        result.current.play();
      });
      raf.tick(1200); // completes the 200ms rewind, landing on "playing"

      // Chunk 1 (day 1, one trade): 100ms transition lands on the AAPL
      // close -- the real ReplayEvent shape, exactly like point mode.
      raf.tick(1100);
      expect(result.current.frame.revealedCount).toBe(4); // points[0..3], day 1's own last point
      expect(result.current.frame.activeEvent?.event.ticker).toBe("AAPL");
      expect(result.current.frame.activeEvent?.tradeReturn?.returnFraction).toBeCloseTo(0.5);
      expect(result.current.frame.activeChunk).toBeNull();

      raf.tick(1150); // the 50ms pause elapses -- advances toward chunk 2 (day 2, no trade)
      raf.tick(1250); // chunk 2's own 100ms transition completes -- no landing, so no pause: falls straight through, starting chunk 3's own tween in the same tick
      expect(result.current.frame.revealedCount).toBe(5); // points[0..4], day 2's own (only) point -- landed with no pause
      expect(result.current.frame.activeEvent).toBeNull();
      expect(result.current.frame.activeChunk).toBeNull();

      raf.tick(1350); // chunk 3's own 100ms transition completes -- lands on the MSFT close
      expect(result.current.frame.revealedCount).toBe(9); // every point revealed
      expect(result.current.frame.currentValue).toBe(36);
      expect(result.current.frame.activeEvent?.event.ticker).toBe("MSFT");
      expect(result.current.frame.activeChunk).toBeNull();
      expect(result.current.phase).toBe("playing");

      raf.tick(1400); // the 50ms pause elapses -- no more chunks, natural completion
      expect(result.current.phase).toBe("done");
      expect(result.current.frame.activeEvent).toBeNull();
      expect(raf.hasQueuedFrame()).toBe(false);
    });

    it("a genuine multi-trade chunk (more than one trade in one day) produces a ChunkSummary, not a ReplayEvent", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();
      const pacing: ReplayPacing = { transitionMs: 100, eventPauseMs: 50, rewindMs: 100 };

      // One day, two trades -- dayGroups.length === 1 but trades.length
      // === 2, so this does *not* qualify for the one-day/one-trade
      // degenerate case.
      const TWO_TRADE_DAY: PortfolioPoint[] = [
        { date: "2025-02-01T09:30:00", value: 20, event: null },
        {
          date: "2025-02-01T09:30:00",
          value: 20,
          event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
        },
        { date: "2025-02-01T10:00:00", value: 20, event: null },
        {
          date: "2025-02-01T10:00:00",
          value: 24,
          event: { type: "close", direction: "long", ticker: "AAPL", price: 120 },
        },
        {
          date: "2025-02-01T10:15:00",
          value: 24,
          event: { type: "open", direction: "long", ticker: "MSFT", price: 200 },
        },
        { date: "2025-02-01T10:45:00", value: 24, event: null },
        {
          date: "2025-02-01T10:45:00",
          value: 21.6,
          event: { type: "close", direction: "long", ticker: "MSFT", price: 180 },
        },
      ];

      const { result } = renderHook(() => useTradeReplay(TWO_TRADE_DAY, pacing, "chunk"));

      act(() => {
        result.current.play();
      });
      raf.tick(1100); // completes the 100ms rewind, landing on "playing"
      raf.tick(1100); // the single chunk's own 100ms transition completes -- lands on the two-trade day

      expect(result.current.frame.revealedCount).toBe(TWO_TRADE_DAY.length);
      expect(result.current.frame.activeEvent).toBeNull();
      expect(result.current.frame.activeChunk).toEqual({
        startDate: "2025-02-01",
        endDate: "2025-02-01",
        tradeCount: 2,
        startValue: 20,
        endValue: 21.6,
      });
    });

    it("a close event with no matching prior open (a defensive, malformed-data case) still pauses and narrates, rather than being silently dropped (code review finding, fixed)", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();
      const pacing: ReplayPacing = { transitionMs: 100, eventPauseMs: 50, rewindMs: 100 };

      // A single day whose only event is a "close" with no preceding
      // "open" anywhere in the series -- deriveWholeRangeIntradaySeries
      // never actually produces this shape (every real trade's open
      // always precedes its own close), but buildPointSegments' own
      // defensive path already handles it for point mode (the close
      // still pauses, with tradeReturn: null) -- chunk mode's own
      // day-grouping walk must match that, not silently exclude the
      // trade from `trades`/`tradeCount` and skip the pause entirely.
      const ORPHAN_CLOSE_POINTS: PortfolioPoint[] = [
        { date: "2025-01-01T09:30:00", value: 20, event: null },
        {
          date: "2025-01-01T10:00:00",
          value: 20,
          event: { type: "close", direction: "long", ticker: "ORPHAN", price: 100 },
        },
      ];

      const { result } = renderHook(() => useTradeReplay(ORPHAN_CLOSE_POINTS, pacing, "chunk"));

      act(() => {
        result.current.play();
      });
      raf.tick(1100); // completes the 100ms rewind, landing on "playing"
      raf.tick(1100); // the single chunk's own 100ms transition completes

      // Without the fix, group.trades would never gain this trade at
      // all (lastOpenPrice stays null for the whole walk), so
      // buildChunkLanding would see trades.length === 0 and never
      // pause -- the close event would be completely invisible in
      // chunk mode. With the fix, it's the one-day/one-trade degenerate
      // case: the real ReplayEvent shape, tradeReturn null (no open
      // price to compute a return from), same as point mode's own
      // identical defensive case would produce.
      expect(result.current.frame.activeEvent?.event.type).toBe("close");
      expect(result.current.frame.activeEvent?.event.ticker).toBe("ORPHAN");
      expect(result.current.frame.activeEvent?.tradeReturn).toBeNull();
      expect(result.current.frame.activeChunk).toBeNull();
    });

    it("caps chunk count at NUM_CHUNKS (30) regardless of how many real trading days the range spans", () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();
      const pacing: ReplayPacing = { transitionMs: 10, eventPauseMs: 10, rewindMs: 10 };

      // 90 days, each with exactly one trade -- every chunk lands (no
      // ambiguity from a no-trade chunk's own "same tick, two
      // transitions" fast-forward, see buildChunkSegments' own doc
      // comment), so counting distinct landings directly measures how
      // many chunks the walk actually produced. 90 divides evenly by
      // NUM_CHUNKS (30) -- chunkSize = ceil(90/30) = 3 exactly, so this
      // produces exactly 30 chunks, not a value that happens to coincide
      // with a different cap too (unlike a day count whose own
      // chunkSize rounds up to the same value under more than one
      // candidate cap).
      const points: PortfolioPoint[] = [];
      let value = 20;
      for (let day = 0; day < 90; day++) {
        const iso = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
        points.push({ date: `${iso}T09:30:00`, value, event: null });
        points.push({
          date: `${iso}T09:30:00`,
          value,
          event: { type: "open", direction: "long", ticker: "T", price: 100 },
        });
        points.push({ date: `${iso}T10:00:00`, value, event: null });
        value = value * 1.01;
        points.push({
          date: `${iso}T10:00:00`,
          value,
          event: { type: "close", direction: "long", ticker: "T", price: 101 },
        });
      }

      const { result } = renderHook(() => useTradeReplay(points, pacing, "chunk"));

      act(() => {
        result.current.play();
      });
      raf.tick(1010); // completes the 10ms rewind, landing on "playing"

      let pauses = 0;
      // Every chunk in this fixture lands (each day has its own trade),
      // so `activeEvent`/`activeChunk` stay non-null across consecutive
      // landings with no intervening null frame to detect a rising edge
      // from -- tracked by object *identity* instead (`tick()` builds a
      // fresh landing object every time, see use-trade-replay.ts's own
      // `SegmentLanding` union), so a genuinely new landing is "this
      // field is non-null and isn't the same object as last observed."
      let lastEvent: unknown = null;
      let lastChunk: unknown = null;
      let now = 1000;
      // Walk forward in fixed 10ms increments (matching both
      // transitionMs and eventPauseMs) until playback naturally
      // completes, counting each distinct landing -- a generous
      // iteration cap guards against an infinite loop if this ever
      // regresses.
      for (let i = 0; i < 500 && result.current.phase === "playing"; i++) {
        now += 10;
        raf.tick(now);
        const { activeEvent, activeChunk } = result.current.frame;
        if (
          (activeEvent !== null && activeEvent !== lastEvent) ||
          (activeChunk !== null && activeChunk !== lastChunk)
        ) {
          pauses += 1;
        }
        lastEvent = activeEvent;
        lastChunk = activeChunk;
      }

      expect(result.current.phase).toBe("done");
      // 90 day-groups, capped to 30 chunks -> chunkSize = ceil(90/30) =
      // 3 -> exactly 30 chunks, every one containing >= 1 trade (this
      // fixture gives every day a trade) -- 30 pauses, not 90, proving
      // the cap actually reduces the number of reveal steps, not just
      // the pacing constants.
      expect(pauses).toBe(30);
    });
  });
});
