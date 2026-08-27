import { describe, expect, it } from "vitest";

import { buildIntradaySessions, MIN_CLOSED_SESSION_SPAN_MINUTES } from "./intraday-sessions";
import {
  SPY_2025_11_20,
  SPY_2025_11_26,
  SPY_2025_11_28_HALF_DAY,
  SPY_THANKSGIVING_WEEK_2025,
  SPY_TRAILING_CURRENT_MOMENT_STUB,
} from "./test-fixtures/spy-thanksgiving-2025";

// The exhaustive vocabulary SessionBar.time is allowed to use -- if a
// full datetime ever leaks back into it, this is what catches it.
const TIME_OF_DAY = /^\d{2}:\d{2}:\d{2}$/;

describe("buildIntradaySessions", () => {
  it("splits one day's bars into a dated session whose bars carry no date at all", () => {
    const [session] = buildIntradaySessions(SPY_2025_11_26);

    expect(session?.date).toBe("2025-11-26");
    expect(session?.bars).toHaveLength(7);
    // The whole point of the split: the date lives on the envelope, once,
    // and nowhere in the bars.
    for (const bar of session!.bars) {
      expect(bar.time).toMatch(TIME_OF_DAY);
    }
    expect(JSON.stringify(session!.bars)).not.toContain("2025-11-26");
    expect(session!.bars[0]).toEqual({ time: "09:30:00", close: 678.1300048828125 });
    expect(session!.bars.at(-1)).toEqual({ time: "15:30:00", close: 679.6300048828125 });
  });

  it("keeps a real holiday-shortened session intact, at its real (shorter) bar count", () => {
    // 2025-11-28 -- the Friday after Thanksgiving 2025, a real 1:00pm-ET
    // NYSE early close. See the fixture's own header comment for why this
    // is the real half day this repo can actually get data for.
    const [session] = buildIntradaySessions(SPY_2025_11_28_HALF_DAY);

    expect(session?.date).toBe("2025-11-28");
    // 4 bars, not the 7 a regular session has -- kept, not rejected, and
    // not padded. Nothing here assumes a bar count.
    expect(session?.bars).toHaveLength(4);
    expect(session!.bars[0]!.time).toBe("09:30:00");
    expect(session!.bars.at(-1)!.time).toBe("13:00:00");
  });

  it("returns every complete session in the week ascending by date, including the half day", () => {
    const sessions = buildIntradaySessions(SPY_THANKSGIVING_WEEK_2025);

    expect(sessions.map((s) => s.date)).toEqual([
      "2025-11-20",
      "2025-11-21",
      "2025-11-24",
      "2025-11-25",
      "2025-11-26",
      "2025-11-28",
    ]);
    // The half day sits alongside the regular ones with a genuinely
    // different length -- the mixed-length case a downstream bar-count
    // assumption would break on.
    expect(sessions.map((s) => s.bars.length)).toEqual([7, 7, 7, 7, 7, 4]);
  });

  it("drops Yahoo's trailing current-moment stub bar instead of publishing a one-bar session", () => {
    // This bar is real, not invented: the same request that produced the
    // Thanksgiving-week fixture came back with a single 2026-08-26 bar
    // tacked onto the end, months past its own period2.
    const sessions = buildIntradaySessions(SPY_THANKSGIVING_WEEK_2025);

    expect(sessions.map((s) => s.date)).not.toContain("2026-08-26");
    // ...and on its own, it produces nothing at all rather than a
    // degenerate session.
    expect(buildIntradaySessions(SPY_TRAILING_CURRENT_MOMENT_STUB)).toEqual([]);
  });

  it("drops a partial session that hasn't run long enough to be a real closed day", () => {
    // A real session's first three bars -- what a pipeline run partway
    // through the morning would see. 09:30 -> 11:30 is 120 minutes,
    // under the 180-minute floor.
    const partial = SPY_2025_11_20.slice(0, 3);
    expect(buildIntradaySessions(partial)).toEqual([]);

    // One more bar takes it to 09:30 -> 12:30 (180 minutes), exactly at
    // the floor -- and a real half day (09:30 -> 13:00, 210 minutes) sits
    // above it, which is the property that matters.
    const atFloor = SPY_2025_11_20.slice(0, 4);
    expect(buildIntradaySessions(atFloor).map((s) => s.date)).toEqual(["2025-11-20"]);
    expect(MIN_CLOSED_SESSION_SPAN_MINUTES).toBe(180);
  });

  it("sorts bars before grouping rather than trusting the fetch's return order", () => {
    const shuffled = [...SPY_2025_11_26].reverse();

    const [session] = buildIntradaySessions(shuffled);

    expect(session?.bars.map((b) => b.time)).toEqual(
      SPY_2025_11_26.map((b) => b.date.slice(11, 19)),
    );
  });

  it("returns nothing for an empty fetch rather than throwing", () => {
    expect(buildIntradaySessions([])).toEqual([]);
  });
});
