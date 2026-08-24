import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortfolioPoint } from "./portfolio-series";
import { createRafPump } from "./raf-pump.test-util";
import { useTradeReplay } from "./use-trade-replay";

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
  });

  it("starts idle, showing only the window's own opening point", () => {
    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    expect(result.current.phase).toBe("idle");
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.frame.activeEvent).toBeNull();
  });

  it("walks every point in order, pausing on each real trade event and tweening the balance between them", () => {
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
    expect(result.current.phase).toBe("playing");

    // Mid-tween toward the "open" event (t=0): still showing only the
    // start point, balance untouched.
    raf.tick(1000);
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(20);

    // Arrives at the "open" event (t=1, 300ms elapsed) -- reveals that
    // point and pauses on its callout. No value change (opening a
    // position doesn't move the balance).
    raf.tick(1300);
    expect(result.current.frame.revealedCount).toBe(2);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.frame.activeEvent?.event.type).toBe("open");
    expect(result.current.frame.activeEvent?.event.ticker).toBe("AAPL");
    expect(result.current.frame.activeEvent?.tradeReturn).toBeNull();

    // Still within the 600ms pause on the open event -- nothing changes.
    raf.tick(1500);
    expect(result.current.frame.activeEvent?.event.type).toBe("open");

    // Pause elapses (600ms) and the mid-trade flat vertex (no event) is
    // reached in the same tick -- no pause for a plain point.
    raf.tick(1900);
    raf.tick(2200);
    expect(result.current.frame.revealedCount).toBe(3);
    expect(result.current.frame.activeEvent).toBeNull();

    // Arrives at the "close" event -- the one point where the balance
    // actually jumps ($20 -> $40, a real 100% return), with a computed
    // tradeReturn matching the open price this hook found by scanning
    // backward.
    raf.tick(2500);
    expect(result.current.frame.revealedCount).toBe(4);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent?.event.type).toBe("close");
    expect(result.current.frame.activeEvent?.tradeReturn?.returnFraction).toBeCloseTo(1);
    expect(result.current.frame.activeEvent?.tradeReturn?.isGain).toBe(true);
    expect(result.current.phase).toBe("playing");

    // Pause elapses, the trailing end point (no event) is reached, and
    // playback finishes -- lands on exactly the same final state a
    // non-animated page load would show.
    raf.tick(3100);
    raf.tick(3400);
    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(ONE_TRADE_POINTS.length);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent).toBeNull();
    expect(raf.hasQueuedFrame()).toBe(false);
  });

  it("skipToEnd lands on the exact same final state as a non-animated page load, at any point during playback", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
    raf.tick(1000); // mid-tween, well before the end

    act(() => {
      result.current.skipToEnd();
    });

    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(ONE_TRADE_POINTS.length);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent).toBeNull();

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

    expect(result.current.phase).toBe("playing");
    expect(result.current.frame.revealedCount).toBe(1);
    expect(result.current.frame.currentValue).toBe(20);
    expect(result.current.frame.activeEvent).toBeNull();

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
    raf.tick(1000); // tween toward the open event
    raf.tick(1300); // arrives at the open event, pauses
    raf.tick(1900); // pause elapses, advances through the flat vertex (no event)
    raf.tick(2200); // tween toward the close event
    raf.tick(2500); // arrives at the close event -- computeTradeReturn throws here

    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(CORRUPT_POINTS.length);
    expect(result.current.frame.currentValue).toBe(40);
    expect(result.current.frame.activeEvent).toBeNull();
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
    raf.tick(1000);
    raf.tick(1300); // pauses on the open event
    raf.tick(1900); // pause elapses, flat vertex reached (no pause)
    raf.tick(2200); // tween toward the close event
    raf.tick(2500); // pauses on the close event -- activeEvent set here
    raf.tick(3100); // pause elapses -- no more segments, natural completion

    expect(result.current.phase).toBe("done");
    expect(result.current.frame.revealedCount).toBe(NO_TRAILING_POINT.length);
    expect(result.current.frame.currentValue).toBe(40);
    // The real regression this test guards: without resetting the
    // frame on natural completion, this would still be the close
    // event's own ReplayEvent, left over from the tick(2500) pause.
    expect(result.current.frame.activeEvent).toBeNull();
  });

  it("play() while already playing is a no-op -- not reachable via the shipped UI (the button that calls play() is hidden while playing), but a real hook-level API contract (code review, issue #96 follow-up round four)", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();

    const { result } = renderHook(() => useTradeReplay(ONE_TRADE_POINTS));

    act(() => {
      result.current.play();
    });
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
});
