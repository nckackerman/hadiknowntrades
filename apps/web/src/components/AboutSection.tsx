// Methodology + disclaimer copy (issue #10 shipped this always-visible;
// issue #104 deliberately reverses that call -- see this component's own
// summary below). Everything here now sits behind a single click: a
// small, clearly-labeled <details>/<summary> affordance, not a bare icon.
// The v1-assumptions list nested inside is the source of truth for what's
// actually modeled -- see root CLAUDE.md and packages/core/CLAUDE.md for
// the underlying facts it summarizes, and keep it in sync if either
// changes.

interface AboutSectionProps {
  /**
   * The current view's own "Best possible outcome ..." sentence (date
   * range/anchor phrasing, the trade-count ceiling, the "as of"
   * timestamp) -- issue #104 removed this as a second, separate
   * always-visible restatement in ResultsPanel.tsx and folds its
   * substance in here instead, right alongside the rest of the
   * disclaimer/methodology content behind the same single click.
   */
  viewDetails: string;
}

/**
 * The one remaining disclaimer/methodology surface in the app (issue
 * #104) -- previously four separate always-visible restatements
 * (ResultsPage.tsx's header subtitle, this component's own always-visible
 * `role="alert"` box, ResultsPanel.tsx's per-view "Best possible
 * outcome..." sentence in both result models, and this component's own
 * already-collapsed "Methodology & assumptions" details) collapsed into a
 * single small affordance. Rendered once per result view (WindowResultBody
 * for the "window"/"custom-window" models, the "intraday-daily" branch)
 * rather than once at the page level, since the view-specific sentence
 * above needs real per-view data (the description phrase, trade-count
 * ceiling, "as of" timestamp) that only the branch currently rendering has
 * on hand -- see ResultsPanel.tsx's own call sites.
 *
 * **Doesn't touch a different, unrelated sentence**: the intraday-daily
 * model's whole-range headline (`WholeRangeBalance`, issue #91) still has
 * its own always-visible "Every trading day's own best possible outcome,
 * chained day to day..." paragraph once the whole-range guess is revealed
 * -- that explains the day-to-day chaining mechanic, not a disclaimer or a
 * restatement of the "not investment advice" framing, so it's out of this
 * issue's own named scope (its Background section cites specific line
 * numbers for the sentence this component does consolidate) and was left
 * as-is.
 *
 * Dropped `role="alert"` and the red-bordered/red-background treatment
 * entirely (issue #104's own Scope) -- that styling existed specifically
 * to make the disclaimer visible with no effort; moving it behind a
 * click means that reasoning no longer applies.
 */
export function AboutSection({ viewDetails }: AboutSectionProps) {
  return (
    <footer className="border-t border-[var(--gridline)] pt-8 text-sm text-[var(--text-secondary)]">
      <details>
        <summary className="cursor-pointer text-[var(--text-secondary)]">
          Disclaimer &amp; methodology
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <p>{viewDetails}</p>

          <div>
            <p className="font-semibold text-[var(--text-primary)]">Not investment advice</p>
            <p className="mt-1">
              This is a hindsight visualization, not a predictor and not a recommendation. It shows
              what a perfect-foresight sequence of trades would have returned in the past -- it says
              nothing about what will happen next. Past performance, especially perfect-hindsight
              past performance, does not indicate future results.
            </p>
          </div>

          {/* Matches PortfolioChart's own nested details/summary
              disclosure (its "View chart data as a table") so the two
              disclosures in the app look and behave the same way. Kept
              intact, unaffected by this issue -- already collapsed
              before this issue, still collapsed underneath the new
              outer affordance now. */}
          <details>
            <summary className="cursor-pointer text-[var(--text-secondary)]">
              Methodology &amp; assumptions
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <p>
                For a selected window, an optimizer considers the entire S&amp;P 500 and finds the
                sequence of at most 3 non-overlapping, all-in, long-only trades (buy on a close,
                sell on a later close, full balance reinvested each time, can switch tickers between
                trades) that maximizes the ending balance starting from $20. It is a backward
                dynamic program, not a search or an approximation -- it is the actual optimal
                outcome under the assumptions below.
              </p>
              <ul className="list-disc pl-5">
                <li>
                  <strong>End-of-day only.</strong> Every trade happens at a daily closing price;
                  nothing intraday is modeled.
                </li>
                <li>
                  <strong>Current constituents, applied retroactively.</strong> The ticker universe
                  is today&apos;s S&amp;P 500 membership, used across every historical window --
                  there is no historical index-membership tracking, which introduces mild
                  survivorship bias (a company that was added to the index after underperforming, or
                  removed before an eventual recovery, won&apos;t appear the way it actually did at
                  the time).
                </li>
                <li>
                  <strong>Split- and dividend-adjusted closes.</strong> Prices come from Yahoo
                  Finance&apos;s adjusted close, which already accounts for stock splits and
                  dividend payouts, so a trade&apos;s return reflects the real total return an
                  actual holder would have seen, not a raw price change distorted by a split.
                </li>
                <li>
                  <strong>No fees, slippage, taxes, or fractional shares.</strong> Every trade is
                  modeled as instant, frictionless, and fully divisible -- real trading has spreads,
                  commissions, tax events, and share-count rounding that this does not model.
                </li>
              </ul>
              <p>
                Results are precomputed nightly, not calculated live per request -- the number you
                see reflects the most recent nightly run, not this exact second&apos;s market data.
              </p>
            </div>
          </details>
        </div>
      </details>
    </footer>
  );
}
