// The Lineup's pure board-state/classification logic (issue #208) --
// no React, no storage, no network. Ported from
// docs/design/order-lineup-2026-08/mockup-order-lineup.html's own
// `<script>` (the "THE LINEUP" section), treated as executable spec per
// this issue's own instruction, not just its screenshots -- see that
// file's own top-of-block comment for the algorithm's full reasoning.
//
// Every column always renders LINEUP_SLOTS (4) tiles regardless of the
// real answer's true length (3 or 4) -- there is deliberately no
// explicit "reveal the length" affordance anywhere. The classification
// below is the entire discovery mechanism: a slot past a shorter
// answer's own real length can never classify as "exact" no matter what
// letter is tried there, which is how a player learns a column is only 3
// letters long. `finalizedCells`/`revealedCells` are the one place a
// column's true length is ever stated outright -- a solved column shows
// a dim "empty" tile for its own unused 4th slot, and a column revealed
// on a loss does the same.
//
// Four classification states, exactly the mock's own `classifyCell`:
//   - exact:    right ticker AND right position
//   - rowmatch: the letter is correct for this same position (row) in a
//               DIFFERENT column's real answer -- "right spot, wrong
//               ticker"
//   - colmatch: the letter appears elsewhere within THIS column's own
//               real answer -- "right ticker, wrong spot"
//   - absent:   neither of the above

export const LINEUP_MAX_ATTEMPTS = 7;
export const LINEUP_COLUMNS = 5;
/** Every column always renders this many slots, regardless of the real ticker's true length (3 or 4). */
export const LINEUP_SLOTS = 4;

/**
 * A tile's classification. `mystery` (not yet guessed) and `empty` (a
 * solved/revealed column's own confirmation it never had a letter at
 * this slot) are rendering states, not something classifyCell ever
 * returns -- only exact/rowmatch/colmatch/absent come out of a guess.
 * `reveal` is `finishLineup`'s own loss-only state: a real letter shown
 * because the budget ran out, not because the player got it right --
 * styled distinctly from `exact` (see TheLineup.tsx).
 */
export type LineupCellState =
  "mystery" | "exact" | "rowmatch" | "colmatch" | "absent" | "empty" | "reveal";

/** The four real classification outcomes a guessed letter can land on -- classifyCell's own return type, and the letter tracker's own ranked vocabulary. */
export type LineupLetterRank = "exact" | "rowmatch" | "colmatch" | "absent";

/**
 * Best-result-per-letter rank order (the mock's own `LETTER_RANK`) --
 * higher wins. Mirrors the tile states' own "how good is this signal"
 * ordering: exact is the strongest thing a player can learn about a
 * letter, absent the weakest (but still worth recording -- a letter
 * genuinely absent everywhere is a real, useful fact).
 */
const LETTER_RANK: Record<LineupLetterRank, number> = {
  exact: 4,
  rowmatch: 3,
  colmatch: 2,
  absent: 1,
};

export interface LineupCell {
  state: LineupCellState;
  /** "" for `mystery`/`empty` -- both are unlabeled placeholder states. */
  letter: string;
}

export interface LineupRoundCounts {
  exact: number;
  rowmatch: number;
  colmatch: number;
  absent: number;
}

/** One past round's log entry (the mock's own collapsible "Guess history"). */
export interface LineupLogEntry {
  attempt: number;
  /** This round's guess for every column, in column order -- an already-locked column's own real answer, echoed back (nothing new was learned there this round). */
  guesses: string[];
  counts: LineupRoundCounts;
}

export interface LineupBoardState {
  /** The day's 5 real tickers -- the answer. Never rendered to the player except via classification/reveal. */
  answers: readonly string[];
  /** 1-indexed, the round currently in progress (or, once `done`, the round the game ended on). */
  attempt: number;
  /** Per column -- true once that column's own guess has exactly matched its answer. */
  locked: boolean[];
  /** Per column, the most recent guess text submitted for it (echoed back into that column's own input on the next render). */
  lastGuess: string[];
  /** [column][row] -- always LINEUP_COLUMNS x LINEUP_SLOTS. */
  cells: LineupCell[][];
  /** The single best result seen anywhere on the board for each letter tried so far (the "letters tried" keyboard tracker). Absent from the map entirely means "not tried yet." */
  letterBest: Partial<Record<string, LineupLetterRank>>;
  log: LineupLogEntry[];
  done: boolean;
  /** Only meaningful once `done` is true. */
  won: boolean;
}

/** A fresh board for a real day's 5 answers -- exactly LINEUP_COLUMNS of them, or every downstream index assumption here breaks. */
export function createLineupBoard(answers: readonly string[]): LineupBoardState {
  if (answers.length !== LINEUP_COLUMNS) {
    throw new Error(
      `createLineupBoard: expected exactly ${LINEUP_COLUMNS} answers, got ${answers.length}`,
    );
  }
  return {
    answers: [...answers],
    attempt: 1,
    locked: answers.map(() => false),
    lastGuess: answers.map(() => ""),
    cells: answers.map(() =>
      Array.from({ length: LINEUP_SLOTS }, () => ({ state: "mystery" as const, letter: "" })),
    ),
    letterBest: {},
    log: [],
    done: false,
    won: false,
  };
}

/**
 * Classifies one guessed letter at `[col, row]` against every column's
 * real answer -- the mock's own `classifyCell`, byte-for-byte.
 * `row < answer.length` guards every comparison against a shorter
 * column's own real length; a slot past it can never classify as
 * `exact`, `rowmatch`, or `colmatch` from that column's own side, which
 * is the entire hidden-length discovery mechanism (see this file's own
 * header comment).
 */
export function classifyCell(
  guessLetter: string,
  col: number,
  row: number,
  answers: readonly string[],
): LineupLetterRank {
  const answer = answers[col]!;
  if (row < answer.length && guessLetter === answer[row]) return "exact";
  for (let c = 0; c < answers.length; c++) {
    if (c !== col && row < answers[c]!.length && answers[c]![row] === guessLetter) {
      return "rowmatch";
    }
  }
  for (let r2 = 0; r2 < answer.length; r2++) {
    if (r2 !== row && answer[r2] === guessLetter) return "colmatch";
  }
  return "absent";
}

/** A solved column's own final tiles -- every real letter marked `exact`, every unused slot past the answer's true length marked `empty`. */
function finalizedCells(answer: string): LineupCell[] {
  return Array.from({ length: LINEUP_SLOTS }, (_, r) =>
    r < answer.length
      ? { state: "exact" as const, letter: answer[r]! }
      : { state: "empty" as const, letter: "" },
  );
}

/** An unsolved column's own tiles once the budget runs out -- every real letter revealed (not "earned"), every unused slot marked `empty`. */
function revealedCells(answer: string): LineupCell[] {
  return Array.from({ length: LINEUP_SLOTS }, (_, r) =>
    r < answer.length
      ? { state: "reveal" as const, letter: answer[r]! }
      : { state: "empty" as const, letter: "" },
  );
}

/**
 * Folds one letter's newly-seen classification into the running
 * best-per-letter map, only overwriting when the new result outranks
 * whatever was already recorded (LETTER_RANK). A deliberate
 * simplification, carried over from the mock's own comment: a letter can
 * genuinely be `exact` in one column and `absent` in another, and this
 * tracker only ever shows the single best case -- still enough to answer
 * "have I already learned everything useful about this letter?"
 */
export function noteLetterResult(
  best: Partial<Record<string, LineupLetterRank>>,
  letter: string,
  state: LineupLetterRank,
): Partial<Record<string, LineupLetterRank>> {
  const rank = LETTER_RANK[state];
  const previousRank = best[letter] ? LETTER_RANK[best[letter]!] : 0;
  return rank > previousRank ? { ...best, [letter]: state } : best;
}

export interface SubmitLineupRoundResult {
  state: LineupBoardState;
  /**
   * `false` if `guesses` failed validation (an unlocked column's own
   * guess isn't a real, legal ticker for that slot) and nothing changed
   * -- the caller should show a shake/error affordance, matching the
   * mock's own invalid-submit branch, rather than silently no-op.
   */
  valid: boolean;
}

/**
 * Submits one whole-board round -- `rawGuesses[i]` is the player's
 * current guess for column i, for every column, submitted together (not
 * one column picked and guessed at a time). An already-locked column's
 * own entry is ignored and always re-submits that column's real answer
 * instead, mirroring the mock's own
 * `if (lineupLocked[i]) { guesses.push(lineupAnswers[i]); continue; }` --
 * nothing new is learned there, but it still needs a value to build this
 * round's own log entry from.
 *
 * `isLegalGuess` validates a single (already uppercased/trimmed) guess
 * against the day's real autocomplete pool -- injected rather than
 * imported directly, so this module has no dependency on
 * packages/core's ticker list and stays trivially testable against a
 * synthetic pool.
 */
export function submitLineupRound(
  state: LineupBoardState,
  rawGuesses: readonly string[],
  isLegalGuess: (guess: string) => boolean,
): SubmitLineupRoundResult {
  if (state.done) return { state, valid: false };

  const guesses = state.answers.map((_, i) =>
    state.locked[i] ? state.answers[i]! : (rawGuesses[i] ?? "").toUpperCase().trim(),
  );
  const allValid = guesses.every((guess, i) => state.locked[i] || isLegalGuess(guess));
  if (!allValid) return { state, valid: false };

  // An already-locked column is never touched again this round -- reuse
  // its own cells array by reference rather than cloning it for no
  // reason, so a caller (e.g. a React render keyed on array identity)
  // can tell a locked column's own cells genuinely didn't change.
  const cells = state.cells.map((col, i) =>
    state.locked[i] ? col : col.map((cell) => ({ ...cell })),
  );
  const locked = [...state.locked];
  const lastGuess = [...state.lastGuess];
  let letterBest = { ...state.letterBest };
  const counts: LineupRoundCounts = { exact: 0, rowmatch: 0, colmatch: 0, absent: 0 };

  for (let col = 0; col < state.answers.length; col++) {
    if (state.locked[col]) continue;
    const guessWord = guesses[col]!;
    lastGuess[col] = guessWord;
    for (let row = 0; row < guessWord.length; row++) {
      const letter = guessWord[row]!;
      const cellState = classifyCell(letter, col, row, state.answers);
      cells[col]![row] = { state: cellState, letter };
      counts[cellState] += 1;
      letterBest = noteLetterResult(letterBest, letter, cellState);
    }
    if (guessWord === state.answers[col]) {
      locked[col] = true;
      cells[col] = finalizedCells(state.answers[col]!);
    }
  }

  const log = [...state.log, { attempt: state.attempt, guesses, counts }];
  const allSolved = locked.every(Boolean);
  const outOfAttempts = state.attempt >= LINEUP_MAX_ATTEMPTS;
  const done = allSolved || outOfAttempts;

  const finalCells =
    done && !allSolved
      ? cells.map((colCells, i) => (locked[i] ? colCells : revealedCells(state.answers[i]!)))
      : cells;

  return {
    valid: true,
    state: {
      ...state,
      locked,
      lastGuess,
      cells: finalCells,
      letterBest,
      log,
      attempt: done ? state.attempt : state.attempt + 1,
      done,
      won: allSolved,
    },
  };
}

/**
 * Rebuilds a finished game's own cell grid directly from the day's real
 * answers and which columns were actually solved -- used to redisplay a
 * completed day's board on a return visit (see lineup-storage.ts's own
 * `LineupPlayedResult.lockedColumns`) without persisting the full
 * letter-by-letter guess history. Once a day is over, every column's
 * real letters are exactly as safe to show as they already were
 * mid-game once locked/revealed -- there's nothing left to protect by
 * replaying the history instead.
 */
export function reconstructFinishedCells(
  answers: readonly string[],
  lockedColumns: readonly boolean[],
): LineupCell[][] {
  return answers.map((answer, i) =>
    lockedColumns[i] ? finalizedCells(answer) : revealedCells(answer),
  );
}

/** How many of the day's real answer tiles were correctly filled in (locked columns only) -- what a recap's "T of {total}" figure reports. */
export function tilesFilledCount(state: LineupBoardState): number {
  return state.answers.reduce((sum, answer, i) => sum + (state.locked[i] ? answer.length : 0), 0);
}

/** The sum of every column's real answer length -- what tilesFilledCount is out of. */
export function totalTilesCount(answers: readonly string[]): number {
  return answers.reduce((sum, answer) => sum + answer.length, 0);
}

/** How many of the 5 columns were solved -- a plain count of `locked`. */
export function columnsSolvedCount(state: LineupBoardState): number {
  return state.locked.filter(Boolean).length;
}
