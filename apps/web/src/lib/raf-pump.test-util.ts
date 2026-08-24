import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Deterministically drives a `requestAnimationFrame`-based effect one
 * frame at a time, for a hook/component whose loop schedules more than
 * one frame across its lifetime (use-trade-replay.ts, issue #96) --
 * `use-count-up.ts`'s own single-tween test (use-count-up.test.ts) gets
 * away with a plain `mockImplementation((cb) => { cb(now); return 1; })`
 * that fires immediately, since a lone tween only ever needs one
 * resolved frame either way (mid-flight, or settled). A multi-segment
 * state machine can't reuse that trick as-is: each arrival resets its
 * own internal `phaseStart` to whatever `now` the mock just supplied,
 * so an auto-firing mock that always hands back the same fixed `now`
 * would compute `elapsed = now - phaseStart = 0` for every segment
 * after the first, hanging in the same "not there yet" branch forever
 * (an infinite synchronous `requestAnimationFrame` recursion, not just
 * a slow test).
 *
 * This pump instead only *queues* the latest scheduled callback,
 * leaving it unfired until the test explicitly calls `tick(now)` with
 * its own chosen elapsed-time value -- the same "control `now` directly,
 * pin `performance.now()` separately" approach as use-count-up.test.ts's
 * own tests, generalized to more than one frame.
 */
export function createRafPump() {
  let queued: FrameRequestCallback | null = null;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    queued = cb;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    queued = null;
  });
  return {
    /** Fires the currently queued frame (if any) with the given `now`, wrapped in `act` since it drives React state updates from outside React's own event handling. */
    tick(now: number) {
      const cb = queued;
      queued = null;
      act(() => {
        cb?.(now);
      });
    },
    /** Whether a frame is currently scheduled and waiting for the next `tick`. */
    hasQueuedFrame() {
      return queued !== null;
    },
  };
}
