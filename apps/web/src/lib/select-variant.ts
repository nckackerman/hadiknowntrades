// Long-only vs. long+short variant selection (issue #13), extracted
// verbatim out of ResultsPanel.tsx by issue #133 so the daily ritual's
// shareable recap can read the *same* headline figure the page itself
// renders rather than growing a second, silently-drifting copy of this
// rule.
//
// This module is deliberately tiny and pure: no React, no formatting, no
// rescaling. Everything that decides which of a result's two computed
// tracks a consumer reads goes through `selectVariant`, and nothing else.

import type { Mode } from "./mode";

/** The three fields every dollar-figure/trade-list consumer actually reads, shared by the window model's WindowResult/LongShortResult and the intraday-daily model's IntradayDayResult/IntradayLongShortResult -- both pairs have this exact shape. */
export interface Variant<T> {
  endingBalance: number;
  trades: T[];
  worstCase: { endingBalance: number; trades: T[] };
}

/**
 * Picks which of a result's two computed variants (issue #13) every
 * dollar-figure/trade-list consumer should read: the long-only fields
 * (unchanged since before that issue) or the sibling `longShort` fields,
 * both always present on a real pipeline-written result. This is the single
 * place that decision is made -- every consumer downstream
 * (HeroAndWorstCase, PortfolioChart via portfolio-series.ts,
 * TradeList/IntradayTradeList, and wholeRangeFinalBalance via
 * whole-range-balance.ts) is threaded this function's result instead
 * of reading the raw top-level fields directly, the same class of mistake
 * apps/web/CLAUDE.md documents happening *twice* for
 * `effectiveStartingCapital` (issue #15) -- a component quietly reading the
 * un-rescaled/wrong-variant field instead of the thread-through value.
 *
 * **Every call site passes a `WindowResult`/`IntradayDayResult` (or its own
 * `longShort` field) straight through as `base`/`longShort`, with no
 * intermediate `{endingBalance, trades, worstCase}` object construction
 * (code review follow-up)** -- an earlier version built that object
 * independently at each call site, exactly the duplication-drift risk this
 * doc comment already warned about. That construction was always redundant:
 * `WindowResult`/`IntradayDayResult`/`LongShortResult`/
 * `IntradayLongShortResult` already have `endingBalance`/`trades`/
 * `worstCase` as own top-level fields with these exact names and shapes, so
 * passing the real result object satisfies `Variant<T>` structurally
 * (TypeScript's excess-property check only applies to fresh object
 * literals, not existing typed variables) with nothing to keep in sync --
 * one fewer place to drift, not just one shared helper to remember to call.
 */
export function selectVariant<T>(base: Variant<T>, longShort: Variant<T>, mode: Mode): Variant<T> {
  return mode === "long" ? base : longShort;
}
