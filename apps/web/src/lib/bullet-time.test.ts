import { describe, expect, it } from "vitest";

import {
  BULLET_TIME_LEAD_BARS,
  BULLET_TIME_MAX_EVENTS,
  BULLET_TIME_MIN_TRIGGER_GAP_BARS,
  bulletTimeCallSentence,
  bulletTimeStatusAt,
  bulletTimeTallyLine,
  bulletTimeTickIntervalMs,
  evaluateBulletTimeCall,
  resolvedBulletTimeCalls,
  scheduleBulletTimeEvents,
  type BulletTimeEvent,
} from "./bullet-time";
import { tickIntervalMs } from "./beat-the-bench";
import {
  SPY_DOWN_SESSION_BARS,
  SPY_UP_SESSION_BARS,
} from "@/test-fixtures/spy-trending-session-bars";
import { SPY_SESSION_BARS } from "@/test-fixtures/spy-session-bars";
import type { SessionBar } from "@hadiknowntrades/core";

/**
 * A synthetic 31-bar session with one clean, well-separated up-swing
 * (bar 2 -> 7, +10.04%) and one clean down-swing (bar 16 -> 26, -10.13%,
 * per `MAX_MOVE_SPAN_FRACTION`'s own span cap -- the trough is at bar 26,
 * but the cap only lets a "from" as early as bar 16 reach it in one run;
 * confirmed against the real implementation, not hand-derived, since
 * `findBestRuns`' own span-cap/tie-break interaction is exactly the kind
 * of thing worth checking against the real function rather than assumed).
 * The leading noise (bars 0-1) exists so the up-run's own true low (bar
 * 2) is the unambiguous best start, not tied with an earlier flat bar --
 * a tie would otherwise resolve to the *earliest* tied index (bar 0),
 * which has no room for `BULLET_TIME_LEAD_BARS` before it. The 15-bar
 * plateau between the two swings (not the 9 an earlier version of this
 * fixture used) is deliberately wide: with only 9, the down-swing's own
 * *window* (triggerIndex through its own toIndex) came within
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS` of the up-swing's own window even
 * though their *trigger points* were comfortably far apart -- exactly
 * the real overlap bug `scheduleBulletTimeEvents`' own inline comment
 * documents, caught by this fixture itself once the fix landed. Widened
 * so this fixture keeps testing "two real, well-separated events," not
 * the overlap case (which has its own dedicated test, below).
 */
function barsWithTwoCleanSwings(): SessionBar[] {
  const values = [
    101,
    100.5,
    99.6, // 0-2: noise, then the up-run's own true low
    101,
    103,
    105,
    107,
    109.6, // 3-7: a clean +10.04% up-run from bar 2
    ...Array<number>(15).fill(109.6), // 8-22: flat plateau
    107,
    104,
    101,
    98.5, // 23-26: a clean down-run into a trough
    ...Array<number>(4).fill(98.5), // 27-30: flat tail
  ];
  // Real HH:MM:SS, rolling the hour over past minute 59 -- a naive
  // `09:${30 + i * 5}` string (tried first, then caught live via the
  // debug-route screenshot pass below) produces "09:70:00" past bar 6,
  // which formatTime silently renders as "Invalid Date".
  return values.map((close, i) => {
    const totalMinutes = 9 * 60 + 30 + i * 5;
    return {
      time: `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}:00`,
      close,
    };
  });
}

/** A session with no move anywhere near big enough to qualify -- every step is a fraction of a basis point. */
function barelyMovingBars(): SessionBar[] {
  const bars: SessionBar[] = [];
  let price = 100;
  for (let i = 0; i < 20; i += 1) {
    price += i % 2 === 0 ? 0.001 : -0.001;
    bars.push({
      time: `${9 + Math.floor(i / 12)}:${String(30 + (i % 12) * 5).padStart(2, "0")}:00`,
      close: price,
    });
  }
  return bars;
}

describe("scheduleBulletTimeEvents", () => {
  it("schedules an event ahead of a real up-swing, with a trigger a few bars before its own start", () => {
    const bars = barsWithTwoCleanSwings();
    const events = scheduleBulletTimeEvents(bars);
    expect(events.length).toBeGreaterThan(0);
    const upEvent = events.find((event) => event.swing.returnFraction > 0);
    expect(upEvent).toBeDefined();
    expect(upEvent!.swing.fromIndex).toBe(2);
    expect(upEvent!.triggerIndex).toBe(2 - BULLET_TIME_LEAD_BARS);
  });

  it("schedules an event ahead of a real down-swing too -- direction-agnostic, unlike topUpMoves", () => {
    const bars = barsWithTwoCleanSwings();
    const events = scheduleBulletTimeEvents(bars);
    const downEvent = events.find((event) => event.swing.returnFraction < 0);
    expect(downEvent).toBeDefined();
    expect(downEvent!.swing.fromIndex).toBe(16);
  });

  it("schedules both, in chronological order, when a session has two real qualifying swings far enough apart", () => {
    const events = scheduleBulletTimeEvents(barsWithTwoCleanSwings());
    expect(events).toHaveLength(2);
    expect(events[0]!.triggerIndex).toBeLessThan(events[1]!.triggerIndex);
    expect(events[0]!.swing.returnFraction).toBeGreaterThan(0);
    expect(events[1]!.swing.returnFraction).toBeLessThan(0);
  });

  it("schedules nothing at all for a session with nothing large enough to qualify -- a real, valid outcome", () => {
    expect(scheduleBulletTimeEvents(barelyMovingBars())).toEqual([]);
  });

  it("schedules nothing for a session too short to contain a swing", () => {
    expect(scheduleBulletTimeEvents([{ time: "09:30:00", close: 100 }])).toEqual([]);
  });

  it("never schedules more than BULLET_TIME_MAX_EVENTS, even against a real, noisy session with many qualifying candidates", () => {
    const events = scheduleBulletTimeEvents(SPY_UP_SESSION_BARS);
    expect(events.length).toBeLessThanOrEqual(BULLET_TIME_MAX_EVENTS);
  });

  it("never schedules two events whose whole active windows come within BULLET_TIME_MIN_TRIGGER_GAP_BARS of each other -- not just their trigger points", () => {
    // Checking only trigger-to-trigger distance is not enough on its own
    // (see the adversarial fixture below for a concrete counter-example)
    // -- this checks the real invariant that matters: no two events'
    // whole windows (triggerIndex through swing.toIndex) come within
    // the gap of each other.
    for (const bars of [SPY_UP_SESSION_BARS, SPY_DOWN_SESSION_BARS, SPY_SESSION_BARS]) {
      const events = scheduleBulletTimeEvents(bars);
      for (let i = 1; i < events.length; i += 1) {
        const previous = events[i - 1]!;
        const current = events[i]!;
        expect(current.triggerIndex - previous.swing.toIndex).toBeGreaterThanOrEqual(
          BULLET_TIME_MIN_TRIGGER_GAP_BARS,
        );
      }
    }
  });

  it("never schedules a second event whose own window would overlap an already-scheduled event's own still-active window, even when their trigger points alone are far enough apart", () => {
    // A real counter-example (found in code review): an up-swing spanning
    // bars 2->9 (triggerIndex 0) directly followed by a down-swing
    // starting exactly where it ends, bars 9->17 (triggerIndex 7). The
    // two trigger points are 7 bars apart -- comfortably clearing
    // BULLET_TIME_MIN_TRIGGER_GAP_BARS (6) on a naive trigger-to-trigger
    // check -- but the first event's own window (0 through 9) is still
    // active well past the second event's own trigger point (7), so a
    // trigger-only check would have scheduled both, silently swallowing
    // the second event's entire approach phase (bulletTimeStatusAt
    // resolves an overlap to whichever event sorts first). Only one
    // event should be scheduled.
    const values: number[] = [101, 100.5, 99.6];
    let price = 99.6;
    for (let i = 0; i < 7; i += 1) {
      price *= 1.02;
      values.push(price);
    }
    for (let i = 0; i < 8; i += 1) {
      price *= 0.98;
      values.push(price);
    }
    while (values.length < 25) values.push(price);
    const bars: SessionBar[] = values.map((close, i) => ({ time: `t${i}`, close }));

    const events = scheduleBulletTimeEvents(bars);
    expect(events).toHaveLength(1);
    // The down-swing is the slightly larger-magnitude candidate, so it's
    // the one that wins; the up-swing is correctly rejected as too close.
    expect(events[0]).toMatchObject({ triggerIndex: 7, swing: { fromIndex: 9, toIndex: 17 } });
  });

  it("never schedules an event without BULLET_TIME_LEAD_BARS of room before its own swing", () => {
    for (const bars of [SPY_UP_SESSION_BARS, SPY_DOWN_SESSION_BARS, SPY_SESSION_BARS]) {
      for (const event of scheduleBulletTimeEvents(bars)) {
        expect(event.swing.fromIndex).toBeGreaterThanOrEqual(BULLET_TIME_LEAD_BARS);
        expect(event.triggerIndex).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a real, quiet net-return day (SPY_SESSION_BARS, +0.053% open to close) can still schedule an event -- net return and the biggest intraday swing are different questions", () => {
    // This fixture's own doc comment describes a quiet *day*, but its
    // own path still dips from the open and tops out well above it (see
    // that file's own header) -- a small open-to-close return doesn't
    // imply a small intraday swing, and this scheduler is right to
    // still find one if the path genuinely has one.
    const events = scheduleBulletTimeEvents(SPY_SESSION_BARS);
    for (const event of events) {
      expect(Math.abs(event.swing.returnFraction)).toBeGreaterThanOrEqual(0.003);
    }
  });
});

describe("bulletTimeStatusAt", () => {
  const events: BulletTimeEvent[] = [
    {
      triggerIndex: 3,
      swing: {
        fromIndex: 5,
        toIndex: 10,
        fromTime: "09:55:00",
        toTime: "10:20:00",
        returnFraction: 0.05,
      },
    },
    {
      triggerIndex: 20,
      swing: {
        fromIndex: 22,
        toIndex: 27,
        fromTime: "11:20:00",
        toTime: "11:45:00",
        returnFraction: -0.04,
      },
    },
  ];

  it("is 'none' before any event's own trigger point", () => {
    expect(bulletTimeStatusAt(events, 0)).toMatchObject({
      phase: "none",
      event: null,
      eventIndex: -1,
    });
    expect(bulletTimeStatusAt(events, 2)).toMatchObject({ phase: "none" });
  });

  it("is 'approaching' from the trigger point up to (not including) the swing's own start", () => {
    expect(bulletTimeStatusAt(events, 3)).toMatchObject({ phase: "approaching", eventIndex: 0 });
    expect(bulletTimeStatusAt(events, 4)).toMatchObject({ phase: "approaching", eventIndex: 0 });
  });

  it("is 'deciding' exactly at the swing's own start bar", () => {
    expect(bulletTimeStatusAt(events, 5)).toMatchObject({ phase: "deciding", eventIndex: 0 });
  });

  it("is 'catchup' between the swing's own start and end bars", () => {
    expect(bulletTimeStatusAt(events, 6)).toMatchObject({ phase: "catchup", eventIndex: 0 });
    expect(bulletTimeStatusAt(events, 9)).toMatchObject({ phase: "catchup", eventIndex: 0 });
  });

  it("is 'none' again exactly at the swing's own end bar -- the event has resolved", () => {
    expect(bulletTimeStatusAt(events, 10)).toMatchObject({
      phase: "none",
      event: null,
      eventIndex: -1,
    });
  });

  it("moves on to the second event once its own trigger point arrives", () => {
    expect(bulletTimeStatusAt(events, 15)).toMatchObject({ phase: "none" });
    expect(bulletTimeStatusAt(events, 20)).toMatchObject({ phase: "approaching", eventIndex: 1 });
    expect(bulletTimeStatusAt(events, 22)).toMatchObject({ phase: "deciding", eventIndex: 1 });
    expect(bulletTimeStatusAt(events, 27)).toMatchObject({ phase: "none" });
  });

  it("is 'none' for an empty schedule at every bar", () => {
    expect(bulletTimeStatusAt([], 5)).toMatchObject({ phase: "none", event: null, eventIndex: -1 });
  });
});

describe("bulletTimeTickIntervalMs", () => {
  it("uses the dedicated slow approach pace, distinctly slower than even the slowest existing speed (0.1x)", () => {
    const approachMs = bulletTimeTickIntervalMs("approaching", 1, false);
    expect(approachMs).toBeGreaterThan(tickIntervalMs(0.1));
  });

  it("uses the dedicated brisk catch-up pace, faster than the player's own chosen 1x speed", () => {
    const catchupMs = bulletTimeTickIntervalMs("catchup", 1, false);
    expect(catchupMs).toBeLessThan(tickIntervalMs(1));
  });

  it("falls back to the player's own chosen speed outside an event", () => {
    expect(bulletTimeTickIntervalMs("none", 2, false)).toBe(tickIntervalMs(2));
  });

  it("never slows or speeds up under reduced motion, for every phase -- no slow-motion animation", () => {
    expect(bulletTimeTickIntervalMs("approaching", 1, true)).toBe(tickIntervalMs(1));
    expect(bulletTimeTickIntervalMs("catchup", 1, true)).toBe(tickIntervalMs(1));
    expect(bulletTimeTickIntervalMs("deciding", 4, true)).toBe(tickIntervalMs(4));
  });
});

describe("evaluateBulletTimeCall / resolvedBulletTimeCalls", () => {
  const upSwing = {
    fromIndex: 5,
    toIndex: 10,
    fromTime: "09:55:00",
    toTime: "10:20:00",
    returnFraction: 0.05,
  };
  const downSwing = {
    fromIndex: 5,
    toIndex: 10,
    fromTime: "09:55:00",
    toTime: "10:20:00",
    returnFraction: -0.05,
  };

  it("is correct to have been holding through a real up-swing", () => {
    expect(evaluateBulletTimeCall("holding", upSwing)).toBe("correct");
    expect(evaluateBulletTimeCall("cash", upSwing)).toBe("incorrect");
  });

  it("is correct to have been in cash through a real down-swing", () => {
    expect(evaluateBulletTimeCall("cash", downSwing)).toBe("correct");
    expect(evaluateBulletTimeCall("holding", downSwing)).toBe("incorrect");
  });

  it("resolves purely from the position at the swing's own end bar -- an unanswered decision locks to whatever was already held, no penalty", () => {
    const events: BulletTimeEvent[] = [{ triggerIndex: 3, swing: upSwing }];
    // No moves at all -- the player was already holding from bar 0 (the
    // session's own default start), so a never-answered decision window
    // still resolves "correct" against an up-swing, exactly the "locks
    // to whatever they're already holding" no-op the design calls for.
    expect(resolvedBulletTimeCalls(events, [])).toEqual(["correct"]);
  });

  it("resolves two independent events independently", () => {
    const events: BulletTimeEvent[] = [
      { triggerIndex: 3, swing: upSwing },
      { triggerIndex: 15, swing: { ...downSwing, fromIndex: 17, toIndex: 22 } },
    ];
    // Toggle to cash right before the down-swing's own start (bar 17),
    // staying holding for the whole up-swing.
    expect(resolvedBulletTimeCalls(events, [17])).toEqual(["correct", "correct"]);
  });
});

describe("bulletTimeTallyLine", () => {
  it("is null for a session that never scheduled an event -- not a misleading '0 of 0'", () => {
    expect(bulletTimeTallyLine([])).toBeNull();
  });

  it("states the real count out of the real total", () => {
    expect(bulletTimeTallyLine(["correct", "incorrect", "correct"])).toBe(
      "Bullet Time calls: 2 of 3 correct.",
    );
  });

  it("handles a clean sweep and a total miss", () => {
    expect(bulletTimeTallyLine(["correct", "correct"])).toBe("Bullet Time calls: 2 of 2 correct.");
    expect(bulletTimeTallyLine(["incorrect"])).toBe("Bullet Time calls: 0 of 1 correct.");
  });
});

describe("bulletTimeCallSentence", () => {
  const swing = {
    fromIndex: 5,
    toIndex: 10,
    fromTime: "09:55:00",
    toTime: "10:20:00",
    returnFraction: 0.0512,
  };

  it("is earnest, not celebratory, on a correct call", () => {
    const sentence = bulletTimeCallSentence("correct", swing);
    expect(sentence).toContain("Called it");
    expect(sentence).toContain("9:55 AM to 10:20 AM");
    expect(sentence).toContain("+5.12%");
  });

  it("is earnest, not a scold, on an incorrect call -- never mocking", () => {
    const sentence = bulletTimeCallSentence("incorrect", swing);
    expect(sentence).toContain("Not this time");
    expect(sentence).not.toMatch(/wrong|mistake|oops|fail/i);
  });
});
