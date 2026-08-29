import { describe, expect, it } from "vitest";

import type { PlayedSession } from "./beat-the-bench-storage";
import {
  RECAP_LOCKED_HEADLINE,
  RECAP_UNLOCKED_HEADLINE,
  STEP_STYLES,
  benchGapClause,
  benchRecapClause,
  buildRecapText,
  callsRecapClause,
  callsState,
  headlineRecapClause,
  isRecapUnlocked,
  orderRecapClause,
  type DailyRitualSnapshot,
  type RitualOrder,
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
    order: null,
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

function orderState(overrides: Partial<RitualOrder> = {}): RitualOrder {
  return {
    attemptsUsed: 2,
    maxAttempts: 4,
    solved: false,
    bestExactCount: 3,
    done: true,
    ...overrides,
  };
}

describe("orderRecapClause", () => {
  it("renders an honest fallback when nothing has been submitted yet today", () => {
    expect(orderRecapClause(null)).toBe("not played yet today");
    expect(orderRecapClause(orderState({ attemptsUsed: 0, done: false }))).toBe(
      "not played yet today",
    );
  });

  it("reports the attempt count on a solve, never a ticker or the real order", () => {
    expect(orderRecapClause(orderState({ solved: true, attemptsUsed: 2, maxAttempts: 4 }))).toBe(
      "solved in 2 of 4",
    );
  });

  it("reports the best exact count when not solved", () => {
    expect(
      orderRecapClause(orderState({ solved: false, attemptsUsed: 4, bestExactCount: 3 })),
    ).toBe("3 of 5 exact after 4 guesses");
  });

  it("does not misreport a bailed-out reveal (zero guesses, done) as unplayed", () => {
    // reveal() sets done: true, won: false with history.length === 0 --
    // attemptsUsed alone can't tell this apart from never having opened
    // the game at all, so `done` has to be checked first.
    expect(orderRecapClause(orderState({ attemptsUsed: 0, solved: false, done: true }))).toBe(
      "revealed without guessing",
    );
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
        "The Order: not played yet today",
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

describe("recap disclosure summary copy", () => {
  it("ships the design reference's own locked summary line", () => {
    expect(RECAP_LOCKED_HEADLINE).toBe("Today's recap unlocks after you play Beat the Bench");
  });

  it("ships the design reference's own unlocked summary line", () => {
    expect(RECAP_UNLOCKED_HEADLINE).toBe("Today's recap is ready -- Copy");
  });
});

describe("STEP_STYLES", () => {
  // WCAG 1.4.1: every non-"todo" state must carry a real glyph, not just a
  // colour -- both game cards' own corner badges (issue #186) depend on
  // this being true, since colour alone can't tell "done" apart from
  // "partial" for a colourblind viewer.
  it("gives done and partial each a real glyph or an explicit override point", () => {
    expect(STEP_STYLES.done.glyph).toBe("✓");
    expect(STEP_STYLES.done.colorClassName).not.toBe("");
    // "partial" has no glyph of its own -- CallBoard.tsx's own badge
    // supplies the filled count instead, per that component's own doc
    // comment -- but its colour still has to be real.
    expect(STEP_STYLES.partial.colorClassName).not.toBe("");
  });

  it("renders nothing at all for todo -- callers must skip it, not render an empty circle", () => {
    expect(STEP_STYLES.todo.glyph).toBe("");
    expect(STEP_STYLES.todo.colorClassName).toBe("");
  });
});
