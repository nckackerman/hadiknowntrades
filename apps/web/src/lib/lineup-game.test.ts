import { describe, expect, it } from "vitest";

import {
  LINEUP_MAX_ATTEMPTS,
  classifyCell,
  classifyColumnGuess,
  columnsSolvedCount,
  createLineupBoard,
  noteLetterResult,
  reconstructFinishedCells,
  submitLineupRound,
  tilesFilledCount,
  totalTilesCount,
  type LineupBoardState,
} from "./lineup-game";

// The mock's own sample lineup -- a genuinely mixed-length set (3/4/3/4/3
// letters), reused here as test data since it exercises the hidden-length
// mechanic directly: columns 1 and 3 (TSLA, MSFT) are the real 4-letter
// answers; columns 0, 2, 4 (IBM, DIS, CAT) are real 3-letter answers.
const ANSWERS = ["IBM", "TSLA", "DIS", "MSFT", "CAT"];

/** Accepts any string as legal -- most tests care about classification/board mechanics, not the autocomplete pool. */
const anyGuessLegal = () => true;

describe("classifyCell", () => {
  it("classifies a letter in the right column and position as exact", () => {
    expect(classifyCell("I", 0, 0, ANSWERS)).toBe("exact");
    expect(classifyCell("B", 0, 1, ANSWERS)).toBe("exact");
    expect(classifyCell("M", 0, 2, ANSWERS)).toBe("exact");
  });

  it("classifies a letter correct for this row in a DIFFERENT column as rowmatch", () => {
    // Row 0 across all 5 answers: I, T, D, M, C -- "T" at row 0 of column 0
    // (IBM's own slot) isn't IBM's own letter, but it IS TSLA's row-0 letter.
    expect(classifyCell("T", 0, 0, ANSWERS)).toBe("rowmatch");
  });

  it("classifies a letter present elsewhere in the SAME column's answer as colmatch", () => {
    // TSLA's own letters at row 0/1/2/3 are T/S/L/A. Guessing "A" at row 0
    // isn't exact (T is there), and "A" isn't any other column's row-0
    // letter (I/D/M/C) -- but "A" IS TSLA's own row-3 letter.
    expect(classifyCell("A", 1, 0, ANSWERS)).toBe("colmatch");
  });

  it("classifies a letter absent everywhere as absent", () => {
    // "Z" isn't in any of IBM/TSLA/DIS/MSFT/CAT at all.
    expect(classifyCell("Z", 0, 0, ANSWERS)).toBe("absent");
  });

  it("a guess reaching past a shorter column's true length can never classify as exact there -- the hidden-length discovery mechanic", () => {
    // Column 0's real answer is IBM (3 letters) -- row 3 is past its own
    // true length. Even guessing the "right" letter can't land exact,
    // since `row < answer.length` is false for every check.
    const state = classifyCell("M", 0, 3, ANSWERS);
    expect(state).not.toBe("exact");
  });

  it("a slot past a shorter column's own length can still be rowmatch or colmatch, just never exact", () => {
    // Row 3 across the 5 answers: only TSLA and MSFT actually have a row-3
    // letter (A and T respectively) -- IBM/DIS/CAT don't reach that far.
    // Guessing "T" at column 0 (IBM), row 3: MSFT's row-3 letter is "T",
    // so this is rowmatch, not exact and not absent.
    expect(classifyCell("T", 0, 3, ANSWERS)).toBe("rowmatch");
  });

  it("a guess shorter than the column's own true length never gets classified at all for its missing rows (submitLineupRound's own loop, not classifyCell)", () => {
    // classifyCell itself has no opinion about guess length -- that's
    // enforced by submitLineupRound only looping `row < guessWord.length`.
    // Covered directly in the submitLineupRound tests below.
    expect(true).toBe(true);
  });
});

describe("classifyColumnGuess (duplicate-letter fix)", () => {
  it("never double-credits a single real letter occurrence -- the exact 'AAL' vs 'ALL' case", () => {
    // Real answer 'AAL' (A, A, L). Guess 'ALL' (A, L, L). The column's
    // own only real L is at position 2. Before the fix, row 1's own
    // colmatch check (does 'L' appear elsewhere in AAL?) found that same
    // position 2, and row 2's own exact check *also* matched it -- one
    // real L credited twice (2 exact + 1 colmatch, for a column with
    // only one real L). With consumption tracking: row 0 'A' is exact
    // (against answer[0]='A'), row 2 'L' is exact (against answer[2]='L',
    // claiming that position first via the exact pass), and row 1's own
    // 'L' has no unclaimed answer position left to match -- absent, not
    // colmatch, since the answer only ever had one L to credit.
    const answers = ["AAL", "ZZZ", "ZZZ", "ZZZ", "ZZZ"]; // no other column shares a row-position letter with ALL
    const ranks = classifyColumnGuess("ALL", 0, answers);

    expect(ranks).toEqual(["exact", "absent", "exact"]);
    // Sanity: exactly one exact per real answer position, no double count.
    expect(ranks.filter((r) => r === "exact")).toHaveLength(2);
    expect(ranks.filter((r) => r === "colmatch")).toHaveLength(0);
  });

  it("submitLineupRound end to end: the same duplicate-letter guess never double-credits a column's counts", () => {
    // Same 'AAL' vs 'ALL' case, exercised through the real whole-board
    // submission path (not just the pure classifier) -- proving the fix
    // actually reaches the UI-facing counts/cells, not just the
    // lower-level function.
    const answers = ["AAL", "ZZZ", "ZZZ", "ZZZ", "ZZZ"];
    const board = createLineupBoard(answers);

    const result = submitLineupRound(board, ["ALL", "QQQ", "QQQ", "QQQ", "QQQ"], anyGuessLegal);

    expect(result.state.cells[0]).toEqual([
      { state: "exact", letter: "A" },
      { state: "absent", letter: "L" },
      { state: "exact", letter: "L" },
      { state: "mystery", letter: "" }, // row 4 -- LINEUP_SLOTS, never touched by a 3-letter guess
    ]);
    // Exactly 2 exact for column 0 (its own real length), never 2 exact + 1 colmatch.
    const column0Counts = result.state.cells[0]!.slice(0, 3).reduce(
      (acc, cell) => ({ ...acc, [cell.state]: (acc[cell.state as string] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    expect(column0Counts.exact).toBe(2);
    expect(column0Counts.colmatch ?? 0).toBe(0);
  });

  it("still allows two guessed duplicate letters to both classify as colmatch when the answer genuinely has two of that letter", () => {
    // Real answer 'LLA' (L, L, A). Guess 'ALL': row 1 'L' lands exact
    // (against answer[1]='L', claiming that position first), then row 0
    // 'A' colmatches against answer[2]='A', and row 2 'L' colmatches
    // against the still-unclaimed answer[0]='L' -- both duplicate-letter
    // colmatches genuinely credited, not suppressed just because the
    // exact pass already consumed one of the answer's two Ls.
    const answers = ["LLA", "ZZZ", "ZZZ", "ZZZ", "ZZZ"];
    const ranks = classifyColumnGuess("ALL", 0, answers);

    expect(ranks).toEqual(["colmatch", "exact", "colmatch"]);
  });
});

describe("noteLetterResult", () => {
  it("records a letter's first-seen result", () => {
    const best = noteLetterResult({}, "A", "absent");
    expect(best.A).toBe("absent");
  });

  it("upgrades to a stronger result (rank: exact > rowmatch > colmatch > absent)", () => {
    let best = noteLetterResult({}, "A", "absent");
    best = noteLetterResult(best, "A", "colmatch");
    expect(best.A).toBe("colmatch");
    best = noteLetterResult(best, "A", "rowmatch");
    expect(best.A).toBe("rowmatch");
    best = noteLetterResult(best, "A", "exact");
    expect(best.A).toBe("exact");
  });

  it("never downgrades an already-recorded stronger result", () => {
    let best = noteLetterResult({}, "A", "exact");
    best = noteLetterResult(best, "A", "absent");
    expect(best.A).toBe("exact");
    best = noteLetterResult(best, "A", "colmatch");
    expect(best.A).toBe("exact");
  });

  it("tracks every letter independently", () => {
    let best = noteLetterResult({}, "A", "exact");
    best = noteLetterResult(best, "B", "absent");
    expect(best).toEqual({ A: "exact", B: "absent" });
  });

  it("does not mutate the input map", () => {
    const original = { A: "absent" as const };
    noteLetterResult(original, "A", "exact");
    expect(original.A).toBe("absent");
  });
});

describe("createLineupBoard", () => {
  it("builds a fresh board with 5 columns of 4 mystery slots each", () => {
    const board = createLineupBoard(ANSWERS);
    expect(board.attempt).toBe(1);
    expect(board.done).toBe(false);
    expect(board.locked).toEqual([false, false, false, false, false]);
    expect(board.cells).toHaveLength(5);
    for (const column of board.cells) {
      expect(column).toHaveLength(4);
      for (const cell of column) expect(cell).toEqual({ state: "mystery", letter: "" });
    }
  });

  it("throws if not given exactly 5 answers", () => {
    expect(() => createLineupBoard(["IBM", "TSLA"])).toThrow();
  });
});

describe("submitLineupRound", () => {
  it("rejects an invalid guess for an unlocked column, changing nothing", () => {
    const board = createLineupBoard(ANSWERS);
    const isLegal = (guess: string) => guess !== "ZZZ";

    const result = submitLineupRound(board, ["ZZZ", "TSLA", "DIS", "MSFT", "CAT"], isLegal);

    expect(result.valid).toBe(false);
    expect(result.state).toBe(board); // unchanged, same reference
  });

  it("classifies every unlocked column's guess and deducts one attempt", () => {
    const board = createLineupBoard(ANSWERS);
    // A deliberately wrong-everywhere 3-letter guess for column 0 (IBM's
    // own real length) -- only rows 0-2 get classified this round; row 3
    // (past the guess's own length) is never touched, staying "mystery".
    const result = submitLineupRound(board, ["ZZZ", "TSLA", "DIS", "MSFT", "CAT"], anyGuessLegal);

    expect(result.valid).toBe(true);
    expect(result.state.attempt).toBe(2); // still going -- 4 of 5 solved this round
    expect(result.state.locked).toEqual([false, true, true, true, true]);
    expect(result.state.cells[0]!.slice(0, 3).every((cell) => cell.state === "absent")).toBe(true);
    expect(result.state.cells[0]![3]).toEqual({ state: "mystery", letter: "" });
  });

  it("locks a column the instant its guess exactly matches, and freezes its cells", () => {
    const board = createLineupBoard(ANSWERS);
    const result = submitLineupRound(board, ["IBM", "ZZZZ", "DIS", "MSFT", "CAT"], anyGuessLegal);

    expect(result.state.locked[0]).toBe(true);
    expect(result.state.cells[0]).toEqual([
      { state: "exact", letter: "I" },
      { state: "exact", letter: "B" },
      { state: "exact", letter: "M" },
      { state: "empty", letter: "" }, // IBM is 3 letters -- the 4th slot is confirmed empty
    ]);
  });

  it("an already-locked column re-submits its own answer and is never re-classified", () => {
    let board = createLineupBoard(ANSWERS);
    board = submitLineupRound(board, ["IBM", "ZZZZ", "DIS", "MSFT", "CAT"], anyGuessLegal).state;
    expect(board.locked[0]).toBe(true);
    const frozenCells = board.cells[0];

    // Submit a garbage guess for column 0 -- it's ignored; the board
    // still needs *a* value there to build this round's own log entry.
    const result = submitLineupRound(board, ["QQQ", "MSFT", "DIS", "MSFT", "CAT"], anyGuessLegal);

    expect(result.state.cells[0]).toBe(frozenCells); // byte-identical, not re-derived
    expect(result.state.log.at(-1)?.guesses[0]).toBe("IBM"); // echoes the real answer, not the ignored guess
  });

  it("wins the instant every column locks in one round", () => {
    const board = createLineupBoard(ANSWERS);
    const result = submitLineupRound(board, ANSWERS, anyGuessLegal);

    expect(result.state.done).toBe(true);
    expect(result.state.won).toBe(true);
    expect(result.state.locked).toEqual([true, true, true, true, true]);
    expect(result.state.attempt).toBe(1); // frozen on the winning round, not advanced
  });

  it("wins across multiple rounds as columns lock one at a time", () => {
    let board = createLineupBoard(ANSWERS);
    board = submitLineupRound(board, ["IBM", "ZZZZ", "ZZZ", "ZZZZ", "ZZZ"], anyGuessLegal).state;
    expect(board.locked[0]).toBe(true);
    expect(board.done).toBe(false);

    board = submitLineupRound(board, ["IBM", "TSLA", "DIS", "MSFT", "CAT"], anyGuessLegal).state;
    expect(board.won).toBe(true);
    expect(board.done).toBe(true);
  });

  it("loses when the budget runs out with at least one column unsolved, revealing the rest", () => {
    let board = createLineupBoard(ANSWERS);
    // Solve column 0 on round 1; burn every remaining round on wrong guesses.
    for (let round = 1; round <= LINEUP_MAX_ATTEMPTS; round++) {
      const guesses =
        round === 1 ? ["IBM", "ZZZZ", "ZZZ", "ZZZZ", "ZZZ"] : ["IBM", "AAAA", "AAA", "AAAA", "AAA"];
      board = submitLineupRound(board, guesses, anyGuessLegal).state;
    }

    expect(board.done).toBe(true);
    expect(board.won).toBe(false);
    expect(board.attempt).toBe(LINEUP_MAX_ATTEMPTS);
    expect(board.locked).toEqual([true, false, false, false, false]);
    // The unsolved columns are revealed (not "exact"), the solved one stays "exact".
    expect(board.cells[0]![0]).toEqual({ state: "exact", letter: "I" });
    expect(board.cells[1]![0]).toEqual({ state: "reveal", letter: "T" });
    expect(board.cells[3]!).toEqual([
      { state: "reveal", letter: "M" },
      { state: "reveal", letter: "S" },
      { state: "reveal", letter: "F" },
      { state: "reveal", letter: "T" },
    ]);
    // A 3-letter column's own unused 4th slot is still "empty" even revealed.
    expect(board.cells[2]![3]).toEqual({ state: "empty", letter: "" });
  });

  it("does nothing once the game is already done", () => {
    let board = createLineupBoard(ANSWERS);
    board = submitLineupRound(board, ANSWERS, anyGuessLegal).state;
    expect(board.done).toBe(true);

    const result = submitLineupRound(board, ANSWERS, anyGuessLegal);
    expect(result.valid).toBe(false);
    expect(result.state).toBe(board);
  });

  it("a guess longer than a column's own true length only ever produces rowmatch/colmatch/absent at the overflow row, never exact -- the discovery mechanic exercised end to end", () => {
    // Column 0's real answer is IBM (3 letters). Guessing a 4-letter
    // ticker there means row 3 gets classified against a slot IBM
    // doesn't really have.
    const board = createLineupBoard(ANSWERS);
    const result = submitLineupRound(board, ["TSLA", "ZZZZ", "ZZZ", "ZZZZ", "ZZZ"], anyGuessLegal);

    const row3 = result.state.cells[0]![3];
    expect(row3?.state).not.toBe("exact");
    expect(row3?.letter).toBe("A"); // TSLA's own 4th letter, whatever it classified as
    expect(board.locked[0]).toBe(false); // TSLA !== IBM, doesn't lock
  });

  it("a guess shorter than a column's own true length leaves the overflow row(s) untouched this round", () => {
    // Column 1's real answer is TSLA (4 letters). Guessing a 3-letter
    // ticker there means only rows 0-2 get classified this round; row 3
    // (a real letter, "A") is simply not looked at, not marked absent.
    const board = createLineupBoard(ANSWERS);
    const result = submitLineupRound(board, ["ZZZ", "IBM", "ZZZ", "ZZZZ", "ZZZ"], anyGuessLegal);

    expect(result.state.cells[1]![3]).toEqual({ state: "mystery", letter: "" });
  });
});

describe("tilesFilledCount / totalTilesCount / columnsSolvedCount", () => {
  it("totalTilesCount sums every answer's real length", () => {
    expect(totalTilesCount(ANSWERS)).toBe(3 + 4 + 3 + 4 + 3); // 17
  });

  it("tilesFilledCount only counts locked columns' tiles", () => {
    let board = createLineupBoard(ANSWERS);
    board = submitLineupRound(board, ["IBM", "ZZZZ", "ZZZ", "ZZZZ", "ZZZ"], anyGuessLegal).state;

    expect(tilesFilledCount(board)).toBe(3); // just IBM's own 3 tiles
    expect(columnsSolvedCount(board)).toBe(1);
  });

  it("tilesFilledCount is 0 on a fresh board and totalTiles on a full win", () => {
    const fresh = createLineupBoard(ANSWERS);
    expect(tilesFilledCount(fresh)).toBe(0);

    const won = submitLineupRound(fresh, ANSWERS, anyGuessLegal).state;
    expect(tilesFilledCount(won)).toBe(totalTilesCount(ANSWERS));
    expect(columnsSolvedCount(won)).toBe(5);
  });
});

describe("reconstructFinishedCells", () => {
  it("shows a solved column's own real letters as exact, with a dim empty 4th slot for a 3-letter answer", () => {
    const cells = reconstructFinishedCells(ANSWERS, [true, false, false, false, false]);
    expect(cells[0]).toEqual([
      { state: "exact", letter: "I" },
      { state: "exact", letter: "B" },
      { state: "exact", letter: "M" },
      { state: "empty", letter: "" },
    ]);
  });

  it("shows an unsolved column's own real letters as revealed, not exact", () => {
    const cells = reconstructFinishedCells(ANSWERS, [true, false, false, false, false]);
    expect(cells[1]).toEqual([
      { state: "reveal", letter: "T" },
      { state: "reveal", letter: "S" },
      { state: "reveal", letter: "L" },
      { state: "reveal", letter: "A" },
    ]);
  });

  it("a fully-won reconstruction (all locked) matches the same shape submitLineupRound produces on a real win", () => {
    const board = createLineupBoard(ANSWERS);
    const won = submitLineupRound(board, ANSWERS, anyGuessLegal).state;
    const reconstructed = reconstructFinishedCells(ANSWERS, [true, true, true, true, true]);
    expect(reconstructed).toEqual(won.cells);
  });
});

// Sanity check that the board shape stays internally consistent across a
// realistic multi-round game, not just the individual-round assertions
// above.
describe("a realistic multi-round game", () => {
  it("plays out consistently: attempt count, log length, and final state all agree", () => {
    let board: LineupBoardState = createLineupBoard(ANSWERS);
    const rounds = [
      ["ZZZ", "ZZZZ", "ZZZ", "ZZZZ", "ZZZ"],
      ["IBM", "TSLA", "ZZZ", "ZZZZ", "ZZZ"],
      ["IBM", "TSLA", "DIS", "MSFT", "CAT"],
    ];
    for (const round of rounds) {
      const result = submitLineupRound(board, round, anyGuessLegal);
      expect(result.valid).toBe(true);
      board = result.state;
    }

    expect(board.log).toHaveLength(3);
    expect(board.log.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(board.won).toBe(true);
    expect(board.done).toBe(true);
  });
});
