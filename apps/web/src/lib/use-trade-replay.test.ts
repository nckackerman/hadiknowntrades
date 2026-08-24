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
});
