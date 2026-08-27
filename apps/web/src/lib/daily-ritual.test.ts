import { describe, expect, it } from "vitest";

import type { PlayedSession } from "./beat-the-bench-storage";
import {
  RECAP_LOCKED_HEADLINE,
  benchGapClause,
  benchRecapClause,
  buildRecapText,
  callsRecapClause,
  callsState,
  headlineRecapClause,
  isRecapUnlocked,
  stepsDone,
  type DailyRitualSnapshot,
} from "./daily-ritual";
import type { HeadlineFigure } from "./headline-figure";

const HEADLINE: HeadlineFigure = {
  model: "intraday-daily",
  rangePhrase: "over the past week",
  startingCapital: 20,
  endingBalance: 2431.19,
};

function session(overrides: Partial<PlayedSession> = {}): PlayedSession {
  return {
    played: true,
    outcome: "win",
    playerBalance: 20.03,
    benchmarkBalance: 20.01,
    moves: 2,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DailyRitualSnapshot> = {}): DailyRitualSnapshot {
  return {
    heroSeen: true,
    bench: { date: "2026-08-26", session: session() },
    calls: { filled: 2, total: 3 },
    headline: HEADLINE,
    ...overrides,
  };
}

describe("isRecapUnlocked", () => {
  it("is locked until Beat the Bench has been played today", () => {
    expect(isRecapUnlocked(snapshot({ bench: null }))).toBe(false);
  });

  it("unlocks on a played session, however it came out", () => {
    expect(isRecapUnlocked(snapshot())).toBe(true);
    expect(
      isRecapUnlocked(
        snapshot({
          bench: { date: "2026-08-26", session: session({ outcome: "loss", playerBalance: 19.9 }) },
        }),
      ),
    ).toBe(true);
  });
});

describe("stepsDone", () => {
  // The reveal is endowed progress, not a step anyone has to earn -- see
  // DailyRitualSnapshot.heroSeen. A brand-new visitor is at 1 of 3, never 0.
  it("counts the reveal as done for a viewer who has done nothing else", () => {
    expect(stepsDone(snapshot({ bench: null, calls: { filled: 0, total: 3 } }))).toBe(1);
  });

  it("counts a played session but not a partially-filled board", () => {
    expect(stepsDone(snapshot({ calls: { filled: 2, total: 3 } }))).toBe(2);
  });

  it("reaches 3 only once every slot is called", () => {
    expect(stepsDone(snapshot({ calls: { filled: 3, total: 3 } }))).toBe(3);
  });
});

describe("callsState", () => {
  it("distinguishes none, some and all", () => {
    expect(callsState({ filled: 0, total: 3 })).toBe("todo");
    expect(callsState({ filled: 1, total: 3 })).toBe("partial");
    expect(callsState({ filled: 3, total: 3 })).toBe("done");
  });

  it("does not report a board with no open sessions as complete", () => {
    expect(callsState({ filled: 0, total: 0 })).toBe("todo");
  });
});

describe("benchGapClause", () => {
  it("rounds a real gap to two decimals, the same precision the settlement card uses", () => {
    expect(benchGapClause(session({ playerBalance: 20.03, benchmarkBalance: 20.0 }))).toBe("0.15%");
  });

  it("refuses to print a misleading 0.00% below a hundredth of a percent", () => {
    expect(benchGapClause(session({ playerBalance: 20.000001, benchmarkBalance: 20 }))).toBe(
      "less than 0.01%",
    );
  });

  it("has no gap at all for an exact tie", () => {
    expect(benchGapClause(session({ playerBalance: 20, benchmarkBalance: 20 }))).toBeNull();
  });
});

describe("benchRecapClause", () => {
  it("names the winner and the gap, in either direction", () => {
    expect(
      benchRecapClause(session({ outcome: "win", playerBalance: 20.03, benchmarkBalance: 20 })),
    ).toBe("you beat the bench by 0.15%");
    expect(
      benchRecapClause(session({ outcome: "loss", playerBalance: 19.97, benchmarkBalance: 20 })),
    ).toBe("the bench stayed ahead by 0.15%");
  });

  it("gives a zero-move session its own phrasing rather than calling it a tie", () => {
    expect(
      benchRecapClause(
        session({ outcome: "tie", playerBalance: 20.01, benchmarkBalance: 20.01, moves: 0 }),
      ),
    ).toBe("you rode it out, level with the bench to the cent");
  });

  it("calls a tie reached by actually trading dead even", () => {
    expect(
      benchRecapClause(
        session({ outcome: "tie", playerBalance: 20.01, benchmarkBalance: 20.01, moves: 4 }),
      ),
    ).toBe("dead even with the bench");
  });
});

describe("headlineRecapClause", () => {
  it("quotes both endpoints and the multiple, in the page's own formatting", () => {
    expect(headlineRecapClause(HEADLINE)).toBe("$20.00 became $2.4K (122x)");
  });
});

describe("callsRecapClause", () => {
  it("reports the commitment count, never which buckets were picked", () => {
    expect(callsRecapClause({ filled: 2, total: 3 })).toBe("2 of 3 upcoming sessions called");
  });
});

describe("buildRecapText", () => {
  it("returns nothing while the recap is locked, so a half-day can't be copied", () => {
    expect(buildRecapText(snapshot({ bench: null }))).toBeNull();
  });

  it("builds the whole recap from the day's real state", () => {
    expect(buildRecapText(snapshot())).toBe(
      [
        "Had I Known Trades · Aug 26, 2026",
        "",
        "Hindsight over the past week: $20.00 became $2.4K (122x)",
        "Beat the Bench: you beat the bench by 0.10%",
        "The Call Board: 2 of 3 upcoming sessions called",
        "",
        "Hindsight only -- not advice, and not a predictor.",
      ].join("\n"),
    );
  });

  it("omits the hindsight line entirely rather than stubbing it when there's no figure to quote", () => {
    const text = buildRecapText(snapshot({ headline: null }))!;
    expect(text).not.toContain("Hindsight over");
    expect(text).toContain("Beat the Bench: you beat the bench");
    // The signature line stays -- it's the app's own disclaimer, not part
    // of the hindsight line it sits below.
    expect(text).toContain("not advice");
  });

  it("names the window in the page's own words for a custom start-date anchor", () => {
    const text = buildRecapText(
      snapshot({
        headline: {
          model: "window",
          rangePhrase: "since Mar 1, 2019",
          startingCapital: 20,
          endingBalance: 500,
        },
      }),
    )!;
    expect(text).toContain("Hindsight since Mar 1, 2019: $20.00 became $500.00 (25x)");
  });

  // The spoiler rule this recap is written to (see daily-ritual.ts's own
  // header): a recipient who hasn't played today's session must not learn
  // from it which way the market went, or by how much.
  it("never leaks the session's absolute balances or the bench's own return", () => {
    const text = buildRecapText(
      snapshot({
        bench: {
          date: "2026-08-26",
          session: session({ playerBalance: 20.03, benchmarkBalance: 20.01 }),
        },
      }),
    )!;
    expect(text).not.toContain("20.03");
    expect(text).not.toContain("20.01");
  });

  it("regenerates from a changed snapshot rather than reporting a stale day", () => {
    const before = buildRecapText(snapshot({ calls: { filled: 1, total: 3 } }))!;
    const after = buildRecapText(snapshot({ calls: { filled: 3, total: 3 } }))!;
    expect(before).toContain("1 of 3 upcoming sessions called");
    expect(after).toContain("3 of 3 upcoming sessions called");
  });
});

describe("locked copy", () => {
  it("ships the real sentence, in this app's second-person register", () => {
    expect(RECAP_LOCKED_HEADLINE).toBe("Play Beat the Bench above, and the day has a recap.");
  });
});
