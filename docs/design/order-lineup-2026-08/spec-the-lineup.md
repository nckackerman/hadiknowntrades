# The Lineup - design spec (resolving issue #189's gaps)

> **Superseded in three places by direct human iteration on the mock --
> read this file's sibling `README.md` first, it's the authoritative
> summary of what actually shipped in the mock and why.** In short: (1)
> the guessing model changed from "pick one column, guess it, repeat"
> (described below) to whole-board guessing -- all 5 columns submitted at
> once each round, 7 rounds total instead of 15 per-column guesses; (2)
> the pool was widened to include real 4-letter tickers alongside the
> 3-letter ones, and a ticker's length is itself hidden until the player
> discovers it through play; (3) a "letters tried" tracker (a shared
> on-screen keyboard, `Quordle`-style) was added, which this document
> predates. The coherence proposal, the daily-selection algorithm, the
> WCAG glyph system's underlying reasoning, and the streak-chip call are
> exactly what shipped -- kept in full below.

## Concept

The Lineup is a daily Wordle-style puzzle built from 5 real, mystery S&P 500 tickers that are each exactly 3 letters long. The player sees a 5-column x 3-row grid of blank tiles, picks a column, and submits a guess (a real 3-letter ticker, entered through an autocomplete constrained to the same 281-ticker pool every possible answer is drawn from). Each guess returns per-letter feedback for that column - correct letter/correct position, correct letter/wrong position, or letter not in the ticker - communicated with a visible glyph plus color plus screen-reader text, never color alone. All 5 columns share one limited guess budget. The player wins by correctly filling all 15 tiles before the budget runs out. Unlike The Order (which asks the player to rank real trading outcomes), The Lineup's tie to this app's hindsight premise lives in _which_ 5 tickers get selected each day, not in the guessing mechanic itself - the daily selection is a real, computed statistic pulled from the same price data the optimizer already consumes, not an arbitrary draw.

## Coherence-with-hindsight-premise proposal

Issue #189's own review is right that Wordle-on-a-ticker is, by itself, "a well-worn mechanic wearing a stock-market skin." The fix is to make the _selection_ of the day's 5 tickers a real, checkable output of this app's own data pipeline, not a random draw from the 3-letter pool.

**Proposal: each day's 5 tickers are the day's 5 biggest movers, restricted to the 3-letter subset of the S&P 500.**

Concretely: for the most recently completed trading day (the same day `DailyHero`/the 1W range already headlines - `apps/web/src/lib/daily-challenge.ts`'s `dailyChallengeFor` reads exactly this day today), compute each of the 281 three-letter tickers' close-to-close daily return: `close[today] / close[yesterday] - 1`. Rank by absolute value, descending. Take the top 5.

This is checkable and cheap, not aspirational:

- The daily-close history needed to compute this is **already fetched** by the pipeline for every ticker in the universe, every night, to support the window-model ranges (5Y/MAX use exactly this daily-close series - see the root `CLAUDE.md`'s data-flow description). No new fetch, no new API call, no new rate-limit risk. This is a pure post-processing step over data `apps/pipeline` already holds in memory during a run.
- It is directly, causally connected to "hindsight" the same way every other mechanic in this app is: a big single-day mover is exactly the kind of stock a perfect-hindsight 1-day trade would have wanted to be in. The Lineup becomes "guess which of today's biggest real movers this ticker is," which is a genuine, checkable statement about real price action, not a generic word game.
- It is verifiable by a human or an agent without touching this codebase's frontend at all: pull the same day's close history for the 281-ticker pool, compute the returns by hand, and confirm the published 5 match the top 5 by `abs(return)`.

**Why not tie it to the optimizer's actual trade output instead** (e.g., "tickers that appeared in today's best 3-trade sequence")? Checked and rejected: the optimizer's picks cluster heavily on a handful of high-conviction, usually 4-5-letter names (AAPL/NVDA/etc., per issue #189's own list) precisely because it's searching the _whole_ 503-ticker universe for the single best sequence - the 281-ticker 3-letter subset would show up in that output rarely and unpredictably, which would make daily selection sparse, inconsistent, and prone to running dry on ordinary quiet days. "Biggest movers within the 3-letter pool" sidesteps this: it is always computable, every single trading day, directly from the 281-ticker pool itself, with no dependency on whether the optimizer happened to pick a 3-letter name that day.

## Daily-selection algorithm

1. Identify the trading day: the same "most recent completed day" `DailyHero`/1W already use (`data.days[data.days.length - 1].date` from the 1W intraday-daily result).
2. For each of the 281 three-letter tickers, compute `abs(close[day] / close[previousTradingDay] - 1)` from the pipeline's own daily-close history (the same data `WindowResult`'s 5Y/MAX computation already has fetched for every ticker in the universe).
3. Sort descending by that absolute return.
4. Walk the sorted list and greedily select tickers into today's lineup, **skipping any ticker that appeared in a lineup published in the last `LINEUP_REPEAT_AVOIDANCE_DAYS` days** (propose 14 - about two weeks, long enough that a repeat reads as "this stock is volatile again," not "didn't they just use this one").
5. If step 4 can't find 5 tickers under a 14-day window (a real possibility only in a low-volatility stretch with a very short published-lineup history), relax to 7 days, then to 0 (no repeat-avoidance at all) - the mechanic must never fail to produce a puzzle. This mirrors the "best-effort, gracefully degrade rather than break" posture this app already uses for granularity overrides in `apps/pipeline` (see `packages/core/CLAUDE.md`'s "Mixed-granularity 1M/3M assembly" section) and for `CallBoard`'s "not tractable" concern issue #189 itself called simpler than The Lineup's.
6. Publish the 5 selected tickers (and nothing else revealing) to a new nightly-written object, e.g. `results/lineup/{date}.json`, alongside a small rolling `results/lineup/history.json` (the last `LINEUP_REPEAT_AVOIDANCE_DAYS`-plus-slack days of published ticker sets, needed by step 4 the next night) - the same "small, versioned, nightly-written object" shape every other mechanic in this app already uses (`results/beat-the-bench/pool/index.json`, `results/mystery-index.json`, `hikt:call-board:history` client-side).

This is deterministic, not random: the same day's real price data always produces the same 5 tickers. That is a deliberate choice, not an oversight - it is what makes "the day's 5 biggest movers" a true, checkable statement rather than a coincidence. Repeat-avoidance is the one place randomness-adjacent behavior (rotation) enters, and even that is a fallback constraint on an otherwise fully data-driven selection, not the primary mechanism.

## Guess-budget & difficulty reasoning

Real Wordle: 1 five-letter word, 6 guesses, drawn from a large legal-guess dictionary (roughly 13,000 words) against a much smaller answer list (~2,300 words); average human solve is around 4 guesses.

The Lineup is a genuinely different difficulty curve, and the budget has to be derived from that difference, not imported from Wordle wholesale:

- **The answer space per column is far smaller.** Every guess is constrained to the 281-ticker 3-letter S&P 500 pool (see the autocomplete rule below), not all 17,576 possible 3-letter strings. That is roughly `log2(281) ~= 8.1` bits of entropy to resolve per column, well under a 5-letter Wordle's `log2(2315) ~= 11.2` bits - so each column, in isolation, is an easier puzzle than Wordle's single word.
- **But there are 5 of them, and (unlike Quordle/Duotrigordle-style "shared board" games) a guess here only ever tests one column.** In this app's own concept, picking a column and guessing narrows _only that column_ - there is no cross-column information gain the way a single Quordle guess narrows all 4 boards simultaneously. So the total work is closer to "solve 5 independent, easier puzzles" than "solve 1 much harder one."
- **Estimate the independent-play cost, then trim it to create a shared-budget squeeze.** A single 3-letter puzzle against a 281-candidate legal-guess list, with full per-letter feedback, is comfortably solvable in about 4 guesses by a careful player (matching real "small answer space" Wordle variants). Giving every column its own free budget of 4 would mean `5 x 4 = 20` guesses - but that isn't really "sharing" a budget at all, since no player would ever have to make a trade-off between columns. The whole point of a _shared_ budget (per the original concept) is to force real prioritization - do you spend one more guess chasing a stubborn column, or cut your losses and protect the ones you're close on?

**Proposal: 15 guesses total, shared across all 5 columns** (an average of 3 per column, `25%` under the naive independent-play estimate of 20). This is tight enough that a player who guesses carelessly on 1-2 columns will feel real pressure on the rest, but loose enough that a player who plays efficiently - using the per-letter feedback rather than guessing blind - can realistically solve all 5. A solved column locks immediately (no further guesses possible or needed against it), so the budget concentrates on whatever's still open as the puzzle progresses.

This number is a reasoned estimate, not something benchmarked against real play data (this app has no telemetry) - flagged again under Open questions.

## Autocomplete/validation rule

**Proposal: the autocomplete accepts only real 3-letter S&P 500 tickers - the same 281-ticker pool every day's answers are drawn from - never a bare 3-letter string, and never the wider 503-ticker universe (which can't be typed into a 3-tile slot anyway).**

Reasoning:

- **Not "any 3-letter string."** Accepting arbitrary text would let a player burn a guess on a typo or a nonsense string ("ZZZ", "QQX") that can never be correct and carries zero letter-feedback signal worth having - every wasted guess against a 15-guess shared budget is a real cost, so the UX should never let a guess be _accidentally_ uninformative. This also avoids an awkward "not a real ticker" rejection UX for a player who typos.
- **Not "the full 503-ticker universe."** A 4+ letter ticker can't physically occupy a 3-tile column, so widening validation past the 281-ticker 3-letter pool would only ever reject input the UI's own 3-character field couldn't hold in the first place - there is no real behavior difference, only a confusing wider mental model ("could I guess AAPL here?" "no, obviously, look at the tiles").
- **This mirrors real Wordle's own two-tier design** (a broad legal-_guess_ dictionary that is meaningfully larger than the narrow legal-_answer_ list) applied at the smallest scale that still makes sense here: every one of the 281 tickers is a legal guess in every column, even though only 5 of them are this particular day's actual answers. This keeps every submitted guess maximally informative (a real ticker's real letters, checked against a real answer) without ever narrowing the visible guess options down to "these 5 are the only things you're allowed to type," which would spoil the game outright.
- Validation can run entirely client-side against the public, already-shipped 281-ticker list (`packages/core/src/sp500-constituents.ts` is public data, not a secret) - the only thing that needs to stay server-side/precomputed and hidden is _which 5 of the 281_ are today's actual answers, exactly the same "candidate pool is public, the day's specific pick is not" shape `packages/core/CLAUDE.md`'s Beat the Bench Mystery Day section already establishes for session picks.

## Rules & flow (state by state)

**Idle (first visit today, not yet played):**

- Compact card (matching `BeatTheBench.tsx`/`CallBoard.tsx`'s established collapsed-tile convention - icon, title, one-line subtitle, a status pill) shows "Not played yet today."
- Clicking/expanding reveals the full board: 5 columns x 3 blank/mystery tiles, a guess counter ("15 guesses left"), and a single autocomplete input tied to whichever column is currently selected (default: the first unsolved column, left to right).

**In-progress:**

- Player selects a column (clicking any of that column's tiles, or a lightweight column-header control) - the autocomplete input's focus/context follows the selection.
- Player types into the autocomplete; it filters live against the 281-ticker pool (see above) and only lets a real, valid-for-this-slot ticker be submitted.
- Submitting a guess deducts 1 from the shared budget, regardless of outcome.

**Per-guess feedback:**

- If the guess exactly matches that column's real answer: all 3 tiles in that column flip to the "correct" state (green + checkmark glyph, see Feedback mechanics), the column locks (no further guesses possible or needed against it), and focus/selection automatically advances to the next unsolved column, if any.
- If the guess does not match: each of the 3 letters in the guess gets Wordle-style per-letter feedback (correct letter/position, correct letter/wrong position, or absent) rendered onto that column's 3 tiles, replacing whatever was shown from the column's previous guess (see the "guess history" note below for how earlier guesses aren't fully lost). The column stays open for another guess, budget permitting.
- The shared guess counter updates after every submission, regardless of column outcome.

**Guess history is not a second Wordle board.** The grid stays a fixed 5x3 shape (matching the original concept) - it is not a 5x6 board of stacked attempt rows the way a real Wordle board is. Each column's 3 tiles always show the feedback from that column's _most recent_ guess. Below the grid, propose a compact, collapsible text log (mirroring `CallBoard.tsx`'s already-established `<details>`/history-strip pattern) listing every past guess per column and its outcome in plain, screen-reader-friendly sentences ("AKA: A correct, K wrong position, A grey") - so a careful player can still review earlier deductions without needing 6 rows of tile-space per column. This is a genuine, flagged design decision - see Open questions.

**Win:** all 5 columns solved (all 15 tiles green) before the budget hits 0. Renders a settled, celebratory state - not necessarily the full `CelebrationBurst` confetti treatment (that is scoped to `HeroStat`'s magnitude-scaled reveal, issue #125, and reusing it here would need its own design check), but at minimum a clear "Solved! N guesses used" headline in this app's established earnest, non-mocking voice (see Beat the Bench's own tone precedent).

**Lose:** the shared budget hits 0 with at least one column still unsolved. Every remaining unsolved column reveals its real answer (all tiles fill in, styled distinctly from a "guessed correctly" green - e.g., a neutral/muted reveal state, not red/critical, since this is a puzzle running out of guesses, not a losing trade) with a plain, non-punishing headline ("Out of guesses - here's the rest of today's lineup"), matching this app's established "never mocking, always earnest" register.

## Feedback mechanics (WCAG 1.4.1: color is never the only signal)

Directly modeled on `CallBoard.tsx`'s own `OUTCOME_STYLES` pattern (see `apps/web/src/components/CallBoard.tsx`): every state carries a real, distinct glyph plus a color plus an `sr-only` sentence, and a legend beneath the grid repeats every glyph next to its meaning in plain text - never color alone, and never a bare `title` attribute (which the same file's own doc comment already notes assistive tech doesn't reliably announce).

| state                            | meaning                                 | glyph                          | color treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct letter, correct position | this letter is exactly right            | `✓` (filled tile)              | `--status-good` border/background wash - the same token `CallBoard`'s "right-direction" state and `TradeRow`'s gain coloring already use                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Correct letter, wrong position   | this letter is in the ticker, elsewhere | `~` or a directional `↕` glyph | a visually distinct _neutral_ highlight - not `--status-good`/`--status-critical` (this state is neither a win nor a miss), and deliberately not `--accent-reward` gold either (gold is reserved for genuinely earned state, per `globals.css`'s issue #121 decision record - a mid-guess signal is not earned state). Propose `--surface-2` background with a `--text-secondary` border, differentiated from the "absent" state primarily by its glyph and by a dashed vs. solid border treatment, not by a second color axis - keeping this feature inside the existing token set rather than inventing a new one. |
| Letter not in this ticker        | this letter is absent                   | `✕`                            | `--status-critical` border/background wash - matching `CallBoard`'s "far-miss" state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Not yet guessed                  | mystery placeholder                     | none (or a plain `?`)          | neutral surface, no color signal needed since nothing has been learned yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Every tile also carries an `sr-only` sentence naming the position, the letter, and the outcome in full ("Position 2: letter K is in this ticker but in the wrong position"), mirroring `CallBoard.tsx`'s `historyCellDescription` helper exactly. The legend at the bottom of the expanded board repeats all four states' glyph + one-line meaning, matching `CallBoard`'s own end-of-board legend `<ul>`.

The "correct position" state deliberately does **not** use `--accent-reward` gold, even though it is the single strongest per-guess signal in the game - reserving gold specifically for the full-solve win state and (if approved) a streak chip keeps this app's own established gold-means-earned convention intact rather than diluting it across every routine correct letter.

## Retention mechanic recommendation

**Recommendation: yes, add a small per-card streak chip - but only once a card is expanded/played, matching an already-shipped precedent in this exact app, not a fresh design decision.**

Issue #189 flags this as undecided because a persistent streak _badge in the page hero_ was tried and explicitly killed. That is a different placement than what's being asked here. Since then, `CallBoard.tsx`'s own compact card (issue #186) has already shipped a small corner streak chip (`🔥 {currentStreak}`, gold `--accent-reward`, appearing only once resolved history exists, with a real `aria-label` since nothing else on the collapsed card states the streak in words) - a small, secondary, non-modal per-card badge, not a prominent hero-level element. That is a real, already-approved precedent inside this app, not a hypothetical.

Given that precedent, The Lineup should follow the identical treatment for consistency: a small `🔥 N` chip (gold, `--accent-reward`, appearing only once the player has a real streak history) on The Lineup's compact card, defined as **consecutive days the player fully solved all 5 columns within budget** - a clean, unambiguous definition that maps directly onto Wordle's own widely-understood streak semantics, so it needs no new explanation copy.

Why this isn't the same thing that was killed: the hero-level badge issue #189 references was a much more prominent, always-visible placement that risked making the whole page read as a personal-finance-app engagement mechanic before a visitor had even opted into a specific game. A quiet corner chip on an already-optional, already-collapsed game card - visible only after a visitor has actually chosen to play - is a materially smaller, more contained ask, and this app has already made exactly that call once (Call Board) without walking it back.

**Cross-game consistency flag (for the human to reconcile):** this recommendation is made without seeing The Order's own spec. If that spec recommends _against_ streak chips for The Order, whoever reconciles the two specs should pick one answer and apply it to both games - a player seeing a streak chip on The Lineup but not on The Order (or vice versa) would read as arbitrary, not as two independently-reasoned decisions. Flagging this explicitly rather than silently assuming my recommendation here should win.

## Recap-line copy proposal

Following `lib/daily-ritual.ts`'s two established rules exactly (see `apps/web/src/lib/daily-ritual.ts`'s own header comment): report the outcome _relatively_, never leak the actual answers, and omit the line entirely (not a stub) if the mechanic wasn't played today.

Proposed clause, matching the existing lines' plain, lowercase-after-label shape ("Beat the Bench: you rode it out, level with the bench to the cent", "The Call Board: 2 of 3 upcoming sessions called"):

- **Won:** `The Lineup: solved all 5 in {N} guesses` - mirrors Wordle's own widely-recognized "solved in X" share convention, and reveals nothing about which tickers were involved.
- **Lost (budget exhausted):** `The Lineup: {M} of 5 solved, {T} of 15 tiles filled when the guesses ran out` - honest about the outcome without naming a single ticker, matching the non-punishing tone the Rules & flow section above establishes for the lose state itself.
- **Not played today:** the line is omitted from the recap entirely, exactly like the existing hindsight line's own "omitted entirely (rather than stubbed) when there is no figure to quote" behavior - a recap made on a day The Lineup wasn't touched should stay honest, not show a "not played" placeholder line that doesn't match the other two lines' own established shape.

This needs no new gating logic beyond what `isRecapUnlocked`/`buildRecapText` already do for Beat the Bench and The Call Board - The Lineup's own played-today record (win/loss, guesses used, tiles filled) is the only new input `daily-ritual.ts` would need, following the same `RitualBench`/`calls`-shaped pattern already established for the other two mechanics.

## Open questions left for the human

1. **Exact visual treatment for the "wrong position" letter state.** I proposed a neutral highlight distinguished from "correct"/"absent" by glyph and border style rather than a third color, to avoid inventing a new token - but the precise pixel treatment (dashed border vs. a background pattern vs. something else) needs a real design pass against this app's dark palette, the same way `CallBoard.tsx`'s own gradient stops needed live contrast measurement before shipping.
2. **Guess-history display shape.** I proposed a compact collapsible text log below the fixed 5x3 grid rather than a scrolling multi-row Wordle board, to keep the tile grid true to the original 5x3 concept - but this is a real UX trade-off (loses the at-a-glance "see all past guesses stacked" feel real Wordle has) that should get explicit sign-off, not just my own default.
3. **The 15-guess budget and the 14-day repeat-avoidance window are both reasoned estimates, not measured against real play.** This app has no telemetry today; both numbers should be treated as a starting point to tune once real usage exists, not a final answer.
4. **The streak-chip recommendation is made without seeing The Order's own spec.** Flagged above under Retention mechanic recommendation - needs explicit reconciliation between the two specs before either ships.
5. **Nightly-pipeline cost of the "biggest movers" computation.** I believe it is free (the daily-close history it needs is already fetched for the window-model ranges every run), but I have not benchmarked this against a real pipeline run the way `packages/core/CLAUDE.md`'s other additions were - whoever implements this should confirm live, following this repo's own "verify live at least once per feature" working agreement.
6. **Mobile layout of a 5-column grid.** This app's own CLAUDE.md repeatedly documents real horizontal-overflow bugs at a 375px viewport that were only caught by an actual screenshot, not reasoned about in advance (see the "Mobile layout pass" and "Day-strip layout" sections). Five columns plus an autocomplete input is a tight fit at phone width and deserves the same live-screenshot scrutiny before shipping, not just a spec-level assumption that it will fit.
7. **Whether a full win should trigger `CelebrationBurst`-style confetti or a lighter, bespoke celebration.** I left this as "at minimum a clear celebratory headline" rather than prescribing confetti reuse, since `CelebrationBurst`'s magnitude-scaling (issue #125) is purpose-built for the hero's dollar-figure multiplier and reusing it here for a puzzle win is a real design question, not a given.
