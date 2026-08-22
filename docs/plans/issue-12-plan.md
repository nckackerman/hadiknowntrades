# Plan: issue #12 - buy-and-hold (SPY) comparison stat

Status: drafted, awaiting independent review. Not yet implemented. Written
against `main` at commit `ee88eea`.

**Read this first, before anything else below**: §0 flags a real
discrepancy between this issue's briefing and the actual state of the
repo. The rest of this plan is written to still be useful despite it, but
a reviewer should resolve §0 before treating any of the UI-facing
sections (§5) as ready to implement as-is.

## 0. A correction to this issue's own briefing: issue #15 is NOT merged

This issue's briefing (and the issue-15 backlog description) describe
`apps/web/src/lib/rescale-starting-capital.ts` as "already merged." It is
not: issue #15 ("Configurable starting capital") is an **open, unmerged
PR (#55)**, on branch `feat/15-configurable-starting-capital`, currently
reported by `gh pr view` as `mergeable: CONFLICTING`. `main` today has no
`rescale-starting-capital.ts`, no `StartingCapitalInput`, and `HeroStat`
takes no `displayStartingCapital` prop.

This plan is still written to reuse that machinery (§5), because building
a second, competing rescale mechanism now — only to delete it once #15
actually lands — would be strictly worse than depending on #15's current
design. But this is a real, load-bearing assumption, not a formality:

- §5 (UI) is written against PR #55's _current_ code (read directly via
  `git show origin/feat/15-configurable-starting-capital:...` for
  `rescale-starting-capital.ts`, `HeroStat.tsx`, `ResultsPanel.tsx` — not
  guessed from the issue text). If #15 changes shape before merging (a
  renamed prop, a different rescale signature, review feedback that
  moves where `StartingCapitalInput` lives), this plan's §5 needs a
  re-read against whatever actually merges, not a blind port of what's
  written here.
- **Implementation of this issue cannot start until #15 is actually
  merged to `main`** — there is nothing to rebase onto otherwise. This
  is a real sequencing dependency the manager needs to account for
  (independent of the already-known #12/#31 schema-version collision —
  see §7.6), not just a note-to-self.
- Everything in §1-§4 (pipeline fetch, schema, fallback) has **no
  dependency on #15 at all** and can be implemented and reviewed
  independently of #15's merge status — only §5 (UI) is blocked.

## 1. Data fetch: SPY's daily closes in `apps/pipeline/src/pipeline.ts`

**No new fetch function, no new `RunPipelineOptions` field.** Unlike
every granularity override (issues #29/#30), which each needed a genuinely
new bar-granularity fetch function threaded through `RunPipelineOptions`
and `apps/pipeline/src/run.ts`, this needs only the _same_
`fetchDailyCloses` function `RunPipelineOptions` already carries, called
once more for a different symbol (`"SPY"`) instead of once per
S&P 500 constituent. `run.ts` needs **zero changes**.

- New module constant in `pipeline.ts`: `const BENCHMARK_TICKER = "SPY";`
  (hardcoded, matching the issue's explicit out-of-scope note — no
  user-chosen ticker).
- New helper, sitting alongside `fetchPathHistory`:

  ```ts
  async function fetchBenchmarkHistory(
    fetchFn: RunPipelineOptions["fetchDailyCloses"],
    from: Date,
    to: Date,
  ): Promise<{ closes: DailyClose[]; error: string | null }> {
    try {
      const closes = await fetchFn(BENCHMARK_TICKER, from, to);
      return { closes, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pipeline] benchmark (${BENCHMARK_TICKER}) fetch failed, comparison stat omitted this run: ${message}`,
      );
      return { closes: [], error: message };
    }
  }
  ```

  Deliberately **not** built on `fetchUniverseHistory`/`fetchPathHistory`'s
  worker-pool-plus-abort-classification machinery: that machinery exists
  to distinguish "this one ticker failed" from "something systemic is
  wrong" across ~503 tickers. For exactly one ticker, that distinction is
  meaningless — there's no "skip this ticker, keep going" option when
  it's the only ticker, and no other in-flight worker whose failure a
  `BlockedError` needs to preempt. A flat try/catch that turns _any_
  failure into "no benchmark this run" is simpler and equally correct
  here; reusing the heavier machinery for `n=1` would be complexity
  without a matching benefit.

- **Concurrency**: add this as a **fourth entry** in `runPipeline`'s
  existing outer `Promise.all([windowFetch, intradayFetch,
overrideOutcomes])`, becoming `Promise.all([windowFetch, intradayFetch,
overrideOutcomes, benchmarkFetch])`. It's a single extra HTTP request
  per run (not a new ~503-ticker pool like the window/intraday/override
  paths), so — unlike the granularity overrides, which each meaningfully
  raised total request volume and got their own risk write-up in
  `apps/pipeline/CLAUDE.md` — this is a negligible addition to that
  budget. Worth stating explicitly so a reviewer doesn't conflate this
  with that larger, already-documented risk (see §9).
- **`from`/`to`**: reuse the window path's own `earliestDate` (default 1970) and `asOf` — the same "ask for everything, let the client return
  whatever actually exists" pattern the window path already uses for the
  ~503-ticker universe fetch (`DEFAULT_EARLIEST_DATE`'s own comment: "the
  Yahoo client naturally returns only what actually exists in range").
  SPY's real inception (1993-01-29) naturally bounds what comes back —
  no special-casing needed at the fetch layer; see §3 for where the
  resulting gap is handled.
- **Error handling**: every failure mode (`TickerNotFoundError`,
  `TransientFetchError`, `BlockedError`, `UnexpectedResponseError`) is
  caught identically and treated as "no benchmark data this run" —
  `closes: []`. This is deliberately coarser than the window/intraday
  paths' classification (which matters there because it decides
  per-ticker-skip vs. whole-run-abort across hundreds of tickers); here
  there is no finer distinction to make. **Non-fatal**: a benchmark
  fetch failure never contributes to `runPipeline`'s final
  `if (windowFetch.failureReason || intradayFetch.failureReason || ...)`
  throw condition — same reasoning as granularity overrides (see
  `apps/pipeline/CLAUDE.md`'s "Neither override is held to the
  window/intraday split's must-still-fail-the-run standard"): losing the
  benchmark stat for a run means every range's comparison figure is
  simply absent (`benchmark: null`, see §3), not that a range serves
  stale or broken _primary_ data. Its outcome is still folded into the
  final status message purely for operational visibility, one more line
  alongside the existing override status lines.
- **Not added to `skippedTickers`.** That field's existing semantics are
  specifically "constituent tickers the optimizer's own universe fetch
  couldn't use" (see `PipelineRunSummary`'s doc comment: "union of
  tickers skipped by any fetch path... a ticker can be skipped from one
  path's fetch but not another's"). SPY is not a universe constituent —
  it never appears in `options.tickers` / `SP500_CONSTITUENTS` — so
  there is no meaningful "skipped from N candidates" framing for it the
  way there is for a granularity override's _own_ per-ticker skips
  (which genuinely are constituent-ticker skips, just from a second
  fetch over the same universe). Mixing SPY into that list would
  misrepresent what `skippedTickers` counts. Its failure is reported
  only via the status-message line described above.

## 2. Computing the comparison: `computeBenchmark`, one function, both models

**No per-model duplication.** Both `WindowResult` and `IntradayResult`
need the exact same thing here: one whole-window buy-and-hold figure
(start price -> end price -> ending balance), computed once per range
from the single shared SPY `closes` array — not per-day, not
re-derived differently for the two result shapes. One pure function,
called from both `buildWindowResults` and `buildIntradayResults`:

```ts
function computeBenchmark(
  closes: readonly DailyClose[],
  range: PresetRange,
  asOf: Date,
  endDateString: string,
  startingCapital: number,
): BenchmarkResult | null {
  const rangeStart = presetRangeStartDate(range, asOf);
  const rangeStartString = rangeStart ? toDateString(rangeStart) : null;
  const inWindow = closes.filter(
    (c) => (!rangeStartString || c.date >= rangeStartString) && c.date <= endDateString,
  );
  if (inWindow.length === 0) return null;

  // Explicit min/max by date comparison, not array position (inWindow[0]
  // / inWindow[inWindow.length - 1]) -- deliberately mirrors
  // findMaxDate's own defensive style above, rather than assuming
  // fetchDailyCloses's output is already date-sorted. That assumption
  // holds in every observed case (Yahoo returns ascending timestamps,
  // and extractCloses/parseDailyChartResult iterate them in order), but
  // it's never explicitly documented or enforced as a contract of
  // fetchDailyCloses's return type -- see the CLAUDE.md-facing note in
  // section 8 flagging this as worth reconfirming live rather than
  // trusting silently.
  let start = inWindow[0]!;
  let end = inWindow[0]!;
  for (const close of inWindow) {
    if (close.date < start.date) start = close;
    if (close.date > end.date) end = close;
  }

  return {
    ticker: BENCHMARK_TICKER,
    startDate: start.date,
    startPrice: start.close,
    endDate: end.date,
    endPrice: end.close,
    endingBalance: startingCapital * (end.close / start.close),
    truncated: rangeStartString !== null && start.date > rangeStartString,
  };
}
```

- Called once per `PresetRange` in `runPipeline`, right after the
  benchmark fetch settles (before `buildWindowResults`/
  `buildIntradayResults` run), producing a `Map<PresetRange,
BenchmarkResult | null>`. Both builder functions gain a
  `benchmarksByRange: Map<PresetRange, BenchmarkResult | null>` parameter
  and attach `benchmark: benchmarksByRange.get(range) ?? null` to each
  range's returned object — a one-line addition to each builder's return
  object, not a structural change to either.
- Cheap: a linear scan over one ticker's `closes` array per range (at
  most ~13,000 daily bars for the full 1970-2026 span, times 5 ranges) —
  no DP, no per-ticker fan-out, negligible next to the optimizer's own
  cost.

## 3. Fallback behavior: SPY data missing part of a window (the MAX/1993 case)

This is the part of the issue's own scope note ("match the pipeline's
existing best-effort-degrade philosophy... rather than failing the whole
range") that needs a concrete, not just gestured-at, answer. Two distinct
failure shapes exist, handled differently and deliberately:

**(a) SPY fetch fails entirely (network/blocking/parse failure).**
`closes = []` for every range uniformly (see §1). `computeBenchmark`
returns `null` for every range (its `inWindow.length === 0` guard fires
immediately, since `closes` itself is empty). Every range's
`PrecomputedResult.benchmark` is `null` this run. **This is not the MAX
case** — it can happen to any range, including 1M, if SPY's fetch simply
fails outright.

**(b) SPY fetch succeeds, but its own history doesn't reach back as far
as the range's requested start date.** This is the _actual_ MAX/1993
case: MAX's own window is unbounded (`presetRangeStartDate("MAX", asOf)`
returns `null`, meaning "as far back as anything has data" — the
S&P 500 universe's own earliest constituent history goes back well
before 1993), but SPY's own inception is 1993-01-29. `computeBenchmark`
does **not** return `null` here — `inWindow` is non-empty (it has all of
SPY's real history up to `endDateString`), so a real, honest comparison
is still computed. What changes is:

- `startDate`/`startPrice` reflect SPY's own **actual** earliest
  available close in the window (~1993-01-29), not the range's nominal
  start (which for MAX has no meaning to compare against anyway, since
  it's `null`/unbounded).
- `truncated: true` is set whenever the _achieved_ `startDate` is later
  than the range's own _requested_ start date (`rangeStartString`) — for
  MAX this is unconditionally true in practice (SPY's real inception is
  always later than "as far back as anything has data"); for every other
  range (1M/3M/1Y/5Y) it's false in every realistic case, since SPY's
  1993 inception predates all of their windows by decades, but the check
  is written generically (not `if (range === "MAX")`) so it stays correct
  automatically if a future, even-longer-than-MAX range were ever added,
  or if SPY's own data ever had an unexpected gap for some other range.
  This mirrors this file's own established preference for a generic
  mechanism over a hardcoded per-range branch (see
  `GranularityOverrideSpec`'s own doc comment on exactly this point).

**What a reader (`apps/web`) is required to do with `truncated: true`**:
**not** silently present the figure as if it covers the full range —
that would misrepresent a ~33-year comparison as if it were the same
multi-decade window the optimizer's own trades cover. §5's UI plan
surfaces `truncated` in the displayed copy itself ("since SPY's earliest
available data, {startDate}") rather than only in the JSON. A reader that
ignores `truncated` and just prints `endingBalance` is not wrong about
the _number_, only silently misleading about what window that number
represents — worth stating plainly since nothing in the type system
forces a consumer to branch on it (unlike `benchmark: null`, which forces
a null-check just to compile against).

**(c) A range's window has SPY data but `computeBenchmark`'s window
filter still ends up empty** (a hypothetical, not expected in practice
given SPY's dense modern daily coverage): handled by the same `null`
return as (a) — no separate code path, no crash.

## 4. Schema change (`packages/core/src/results-schema.ts`)

New exported type:

```ts
/**
 * A SPY buy-and-hold comparison over the same window a PrecomputedResult
 * covers (issue #12) -- see apps/pipeline's computeBenchmark for how this
 * is derived, and the module note above for what `truncated` means.
 */
export interface BenchmarkResult {
  /** Hardcoded to "SPY" -- no user-chosen ticker (issue #12's own scope). Present as a real field, not assumed by every reader, in case that ever changes. */
  ticker: string;
  /** Actual first date of benchmark data used -- may be later than this result's own effective start date; see `truncated`. */
  startDate: string;
  startPrice: number;
  /** Actual last date of benchmark data used -- <= this result's endDate, same "fact about the data" framing as dataAsOf. */
  endDate: string;
  endPrice: number;
  endingBalance: number;
  /**
   * True when `startDate` had to be pulled forward from this result's own
   * requested start date because the benchmark's own history doesn't
   * reach back that far (concretely: the MAX range vs. SPY's 1993-01-29
   * inception). A reader MUST reflect this in displayed copy when true --
   * see results-schema.ts's own module note and packages/core/CLAUDE.md's
   * benchmark section for why silently showing the number without this
   * caveat misrepresents what window it covers.
   */
  truncated: boolean;
}
```

Add one field to `PrecomputedResultBase` (shared by both `WindowResult`
and `IntradayResult`, so this is a single addition, not two):

```ts
/**
 * SPY buy-and-hold comparison over the same window (issue #12). Null
 * only when no benchmark data could be fetched at all this run (see
 * results-schema.ts's BenchmarkResult / the fetch failure case) -- a
 * present-but-truncated result is a real, honestly-scoped comparison,
 * not a degraded/missing one; see BenchmarkResult.truncated.
 */
benchmark: BenchmarkResult | null;
```

**`RESULTS_SCHEMA_VERSION` bump: 2 -> 3.** A reader needs to know about
this (the field's presence and its `null`-vs-populated distinction), so
this meets the constant's own documented bump criterion. See §8.6 for the
expected collision with issue #31, being planned in parallel against the
same constant and the same `PrecomputedResultBase` — not resolved here,
flagged for the manager's merge-order reconciliation as instructed.

**`validatePrecomputedResult` extension** (`validateBase`, since this is
a base-level field, checked once for both models rather than duplicated
in the `model === "window"` / `model === "intraday-daily"` branches):

```ts
function validateBenchmark(value: unknown, problems: string[]): void {
  if (value === null) return; // valid: no benchmark data was available this run
  if (typeof value !== "object") {
    problems.push(`benchmark must be null or an object, got ${describe(value)}`);
    return;
  }
  const b = value as Record<string, unknown>;
  if (!isNonEmptyString(b.ticker))
    problems.push(`benchmark.ticker must be a non-empty string, got ${describe(b.ticker)}`);
  if (!isNonEmptyString(b.startDate))
    problems.push(`benchmark.startDate must be a non-empty string, got ${describe(b.startDate)}`);
  if (!isPositiveFiniteNumber(b.startPrice))
    problems.push(
      `benchmark.startPrice must be a positive finite number, got ${describe(b.startPrice)}`,
    );
  if (!isNonEmptyString(b.endDate))
    problems.push(`benchmark.endDate must be a non-empty string, got ${describe(b.endDate)}`);
  if (!isPositiveFiniteNumber(b.endPrice))
    problems.push(
      `benchmark.endPrice must be a positive finite number, got ${describe(b.endPrice)}`,
    );
  if (!isPositiveFiniteNumber(b.endingBalance))
    problems.push(
      `benchmark.endingBalance must be a positive finite number, got ${describe(b.endingBalance)}`,
    );
  if (typeof b.truncated !== "boolean")
    problems.push(`benchmark.truncated must be a boolean, got ${describe(b.truncated)}`);
}
```

Called from `validateBase` as `validateBenchmark(result.benchmark,
problems)`. **Deliberately distinguishes `undefined` from `null`**: since
`validateBenchmark`'s first check is `value === null` (passes) and
`typeof undefined !== "object"` (fails the second check, correctly
flagged as a problem), an entirely-missing `benchmark` field — e.g. a
stale pre-#12 stored object, or a future refactor bug that forgets to set
it — is caught as a real validation failure, not silently treated the
same as the valid "no benchmark data this run" empty state. This is the
same distinction issue #47's own write-time validator already draws
carefully elsewhere (see `packages/core/CLAUDE.md`'s note on
`schemaVersion` being checked for exact equality, not just "is it a
number") — worth being equally careful here rather than writing a looser
`value == null` check that would blur the two.

## 5. `apps/web`: UI placement, reusing `rescale-starting-capital.ts`

**Depends on issue #15 actually being merged first — see §0.** Written
against PR #55's current code.

New component, `apps/web/src/components/BenchmarkStat.tsx`:

```tsx
"use client";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import type { BenchmarkResult } from "@hadiknowntrades/core";

interface BenchmarkStatProps {
  benchmark: BenchmarkResult | null;
  /** The precomputed result's own startingCapital -- what benchmark.endingBalance was computed relative to. */
  startingCapital: number;
  /** The user's chosen display capital (issue #15) -- defaults to startingCapital, a no-op rescale, same convention as HeroStat's own displayStartingCapital prop. */
  displayStartingCapital?: number;
}

export function BenchmarkStat({
  benchmark,
  startingCapital,
  displayStartingCapital = startingCapital,
}: BenchmarkStatProps) {
  if (!benchmark) return null;
  const displayedEndingBalance = rescaleFromStartingCapital(
    benchmark.endingBalance,
    startingCapital,
    displayStartingCapital,
  );
  return (
    <p className="text-sm text-[var(--text-secondary)]">
      Buying and holding {benchmark.ticker} instead
      {benchmark.truncated
        ? ` (since its earliest available data, ${formatDate(benchmark.startDate)})`
        : ""}{" "}
      would have turned {formatHeroCurrency(displayStartingCapital)} into{" "}
      <span className="font-medium text-[var(--text-primary)]">
        {formatHeroCurrency(displayedEndingBalance)}
      </span>
      .
    </p>
  );
}
```

- **Rescale mechanism**: identical pattern to `HeroStat`'s own
  `displayStartingCapital` prop — `benchmark.endingBalance` is a
  precomputed dollar figure relative to `startingCapital` (the
  pipeline's own constant, currently $20), and `rescaleFromStartingCapital`
  (issue #15) is a pure `value * (to/from)` linear scale that needs no
  new math, exactly per that file's own doc comment on why any
  precomputed dollar figure can be rescaled this way. No new rescale
  logic is written for this issue — this is the entire point of reusing
  #15's machinery rather than re-deriving it.
- **`null` renders nothing** (not an error message, not a placeholder
  box) — see §8.5 for why this is a judgment call, not a certainty.
- **Placement**: a single prose line directly below the existing
  methodology `<p>` in `ResultsPanel.tsx` (the "Best possible outcome
  over {range}... As of {dataAsOf}." line), in **both** the `"window"`
  and `"intraday-daily"` render branches — one new line, same spot,
  passed `data.benchmark`, `data.startingCapital`, and the same
  `effectiveStartingCapital` each branch already computes for its
  `HeroStat`/`StartingCapitalInput` calls. This satisfies the acceptance
  criteria's "clear contrast next to the existing hero stat, not
  competing with it" by construction: it's textual, secondary-sized
  (`text-sm`, matching the methodology line's own weight), and placed
  where this app's existing prose-narration precedent (issue #32's
  `TradeList`) already establishes that a contextual dollar figure reads
  fine as a sentence rather than a second hero number. Recommended over a
  `HeroStat`-adjacent badge/second big figure, but flagged as a real
  design judgment call in §8.2 — this wasn't resolved by the issue text
  either way, and a screenshot pass during implementation should confirm
  it reads well before treating this as final.
- **Intraday-daily model: the benchmark is whole-window, not per-day**
  (see §2/§3 — `data.benchmark`, a top-level field, computed once over
  the range's own `presetRangeStartDate(range, asOf)`..`endDate` window,
  identical for every day the `DaySelector` can pick). This is a real,
  intentional mismatch with everything else in that branch's view (the
  `HeroStat`/chart/trade-list below it are all scoped to whichever single
  day is selected) — flagged explicitly, not glossed over, in §8.3, with
  a recommended copy fix (spelling out "over the full {range}" in the
  sentence) rather than a structural change.

`results-api.ts` needs **no code change** beyond what the type-level
`RESULTS_SCHEMA_VERSION`/`PrecomputedResult` import already picks up
automatically — it only version-checks and passes the parsed object
through, never inspects field-level shape (same precedent as issue #28's
own plan doc noted for its schema change).

## 6. Testing / verification plan (not performed in this phase)

- **`packages/core`**: `results-schema.test.ts` additions for
  `validatePrecomputedResult`'s new `benchmark` branch: `null` (valid,
  passes), a well-formed object (passes), each individually-malformed
  field (each independently caught), and `undefined` specifically
  (caught, per §4's undefined-vs-null distinction).
- **`apps/pipeline`**: `computeBenchmark` unit tests (module-private,
  tested via `pipeline.test.ts` or exported for direct testing, judgment
  call at implementation time) covering: a normal in-window case, the
  MAX/truncated case (a synthetic `closes` fixture whose earliest date is
  later than the range's nominal start), the empty-window edge case
  (returns `null`), and the explicit-min/max-not-array-position behavior
  from §2 (a deliberately out-of-order fixture, to catch a regression if
  someone "simplifies" it back to `inWindow[0]`/`inWindow.at(-1)`).
  `pipeline.test.ts` additions: the new 4th concurrent fetch is wired up
  and awaited (a slow/rejecting benchmark fetch doesn't block or fail the
  other three paths), a benchmark fetch failure results in `benchmark:
null` on every written range without failing the run, and every
  written range's `benchmark` field round-trips through
  `validatePrecomputedResult` correctly.
- **`apps/web`**: `BenchmarkStat.test.tsx` (renders nothing for `null`,
  renders the rescaled figure, renders the `truncated` caveat text only
  when `truncated` is true). `ResultsPanel.test.tsx` additions for both
  models, with and without a `benchmark`.
- **Not attempted in unit tests**: real SPY data shape/values, real
  inception-date confirmation.

## 7. Live verification plan (not performed in this planning phase)

Per this repo's working agreement (verify live at least once per
feature, not after every incremental fix):

- A real `fetchDailyCloses("SPY", ...)` call against the live Yahoo
  endpoint (from `1970-01-01` to today), confirming: the shape is
  identical to any other daily-close fetch (no SPY-specific quirk
  expected, but not yet confirmed), the actual first returned date
  (expected ~1993-01-29, confirming the `truncated` logic's premise
  empirically rather than from general knowledge), and — directly
  relevant to §2's design choice — whether the returned array is in fact
  date-ascending in practice (informs whether the explicit min/max scan
  is turning out to matter, or is defensive-only).
- A real, full pipeline run, confirming: `benchmark` is populated
  correctly for all 5 ranges, MAX's `truncated: true` with a sensible
  `startDate`, and `validatePrecomputedResult` passes on every written
  range.
- A screenshot pass (per `apps/web/CLAUDE.md`'s documented
  headless-Chromium/throwaway-route technique) of `BenchmarkStat` in
  both the window and intraday-daily branches, in both light and dark,
  including the `truncated`-caveat copy for a MAX-range fixture, and a
  starting-capital edit (once #15 is in) rescaling it live.
- This is a real-AWS action (the pipeline run) and needs the user's
  explicit go-ahead per this repo's working agreement — not performed as
  part of this plan.

## 8. Open questions / judgment calls this plan made without a resolving answer in the issue text

1. **Issue #15's actual merge state (§0) — the single biggest issue with
   this plan's own briefing.** This issue was described as depending on
   an "already merged" #15; it is in fact an open, conflicting PR. This
   plan proceeds by reading that PR's real code directly rather than
   waiting, but implementation cannot start on §5 until #15 actually
   lands, and this plan's §5 needs to be re-checked against whatever
   #15's final merged form actually looks like, not assumed unchanged
   from PR #55's current snapshot.
2. **`BenchmarkStat`'s placement (§5): a prose line under the methodology
   paragraph, not a `HeroStat`-adjacent badge/second figure.** Recommended,
   not certain — the issue's "clear contrast... not competing" acceptance
   criterion is satisfiable either way, and this plan's choice leans on
   this app's existing prose-narration precedent (issue #32) rather than
   a resolved decision in the issue text itself. Worth confirming with an
   actual screenshot before treating as final.
3. **Intraday-daily's whole-window benchmark shown alongside a
   single-day view (§5).** A real, deliberate juxtaposition (SPY over the
   full range vs. the optimizer's best day), not an oversight, but it's
   worth explicit confirmation that spelling this out in copy ("over the
   full {range}...") is enough disambiguation, versus, e.g., not showing
   the benchmark stat at all on the intraday-daily model (mirroring how
   the OG share card, issue #33, deliberately scopes itself to the
   `"window"` model only and skips `"intraday-daily"` entirely for a
   related "this stat doesn't map cleanly onto a per-day view" reason).
   This plan recommends showing it with clarifying copy, but the
   alternative is real and simpler.
4. **No gain/loss coloring on `BenchmarkStat`'s figure**, unlike
   `HeroStat`'s multiplier badge or `TradeRow`'s per-trade return badge.
   Deliberate simplicity for v1 (this is a comparison figure, not itself
   a "did the optimizer win" signal), but not something the issue text
   rules in or out either way.
5. **`benchmark: null` renders nothing at all**, rather than a visible
   "SPY comparison unavailable this run" note. Consistent with this
   app's general silent-graceful-degrade posture elsewhere (e.g. the OG
   card route's model-based 404, no user-facing error copy for that
   either), but this is a real product choice a reviewer might want to
   flip, especially since (unlike the OG card's always-same 404) this
   condition is transient — a benchmark that's `null` today could be
   populated again on tomorrow's pipeline run with no code change,
   which might argue for at least a subtle "not available for this run"
   affordance instead of silence.
6. **`RESULTS_SCHEMA_VERSION` bump to 3 will collide with issue #31**,
   being planned in parallel and independently touching the same
   constant and the same `PrecomputedResultBase`. Per the manager's own
   framing of this task, not resolved here — whichever of #12/#31 merges
   second needs to rebase its version bump onto whichever number the
   first one landed at, and re-verify `validatePrecomputedResult`'s
   combined field list still round-trips correctly. Flagged, not solved.
7. **`fetchDailyCloses`'s return ordering is not a documented contract**
   anywhere in `packages/core` (confirmed by reading `yahoo-client.ts`
   end to end — no explicit sort call on its output; `optimizer.ts`'s own
   `buildCalendar` builds and sorts its own date set rather than trusting
   fetch order, which is itself informative). §2's `computeBenchmark`
   is written defensively (explicit min/max scan) rather than assuming
   ascending order, but this has not been live-verified as _necessary_
   (vs. just cheap insurance) — §7's live-verification step should
   settle whether the defensive version is doing real work or not, for
   future readers of this code who might otherwise "simplify" it back to
   an index-based version.

## 9. Risks

- **Perf**: negligible. One extra single-ticker HTTP fetch per run
  (§1), concurrent with existing fetches; `computeBenchmark` (§2) is a
  linear scan over at most ~13,000 daily bars, run 5 times per pipeline
  invocation — nowhere near the optimizer's own cost, and nowhere near
  the granularity overrides' already-documented per-run request-volume
  growth (see `apps/pipeline/CLAUDE.md`'s "Quadrupled Yahoo request
  volume risk" note) — this issue adds one request, not a new
  ~503-ticker pool, and that distinction is worth keeping clear so this
  change isn't mistakenly folded into that existing, much larger risk.
- **Correctness / honesty risk**: the MAX/truncated case (§3) is the one
  place this feature can be _technically correct but misleading_ if the
  UI ever drops the `truncated` caveat in a future refactor — a ~33-year
  SPY-only comparison silently juxtaposed against a "MAX" range whose own
  window can span 50+ years for some constituents. The schema forces a
  `truncated: boolean` field to exist; nothing forces a future UI change
  to keep rendering it. Worth a regression test asserting the caveat
  copy actually appears when `truncated` is true (§6), not just that the
  dollar figure is correct.
- **Blast radius**: same rollout hazard #28's plan already documented
  and #29/#30 repeated — bumping `RESULTS_SCHEMA_VERSION` means _all 5_
  range keys need to be rewritten by a real pipeline run before or
  atomically with deploying the schema-3-only `apps/web`, or every range
  (including the 4 this issue doesn't otherwise touch the behavior of)
  502s with `schema_mismatch` until the next nightly run. Real-AWS
  action, needs the user's explicit go-ahead, same as every prior
  schema-version bump in this repo.
- **Sequencing risk**: this issue is now blocked on issue #15 actually
  merging (§0), which was not expected going in. If #15 stalls (its
  `mergeable: CONFLICTING` status suggests it may need a rebase against
  `main` itself before it can land), this issue's §1-§4 (pipeline +
  schema) can still proceed and be reviewed/merged independently, with
  §5 (UI) picked up as a small follow-up once #15 is actually in — worth
  keeping these as separable review units rather than one all-or-nothing
  PR, given the dependency turned out to be unresolved rather than
  already-done.
