// Methodology + disclaimer copy, always visible on the site (issue #10 --
// not tucked behind a click, since a disclaimer that requires effort to
// find isn't really "clear"). The v1-assumptions list below the summary
// is the source of truth for what's actually modeled -- see root
// CLAUDE.md and packages/core/CLAUDE.md for the underlying facts it
// summarizes, and keep it in sync if either changes.

/** The site's always-visible disclaimer plus a methodology/assumptions section behind a details/summary. */
export function AboutSection() {
  return (
    <footer className="flex flex-col gap-4 border-t border-[var(--gridline)] pt-8 text-sm text-[var(--text-secondary)]">
      <div
        role="alert"
        className="rounded-lg border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/5 px-4 py-3"
      >
        <p className="font-semibold text-[var(--status-critical)]">Not investment advice</p>
        <p className="mt-1">
          This is a hindsight visualization, not a predictor and not a recommendation. It shows what
          a perfect-foresight sequence of trades would have returned in the past -- it says nothing
          about what will happen next. Past performance, especially perfect-hindsight past
          performance, does not indicate future results.
        </p>
      </div>

      {/* Matches PortfolioChart's own details/summary disclosure (its "View
          chart data as a table") so the two disclosures in the app look and
          behave the same way. */}
      <details>
        <summary className="cursor-pointer text-[var(--text-secondary)]">
          Methodology &amp; assumptions
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p>
            For a selected window, an optimizer considers the entire S&amp;P 500 and finds the
            sequence of at most 3 non-overlapping, all-in, long-only trades (buy on a close, sell on
            a later close, full balance reinvested each time, can switch tickers between trades)
            that maximizes the ending balance starting from $20. It is a backward dynamic program,
            not a search or an approximation -- it is the actual optimal outcome under the
            assumptions below.
          </p>
          <ul className="list-disc pl-5">
            <li>
              <strong>End-of-day only.</strong> Every trade happens at a daily closing price;
              nothing intraday is modeled.
            </li>
            <li>
              <strong>Current constituents, applied retroactively.</strong> The ticker universe is
              today&apos;s S&amp;P 500 membership, used across every historical window -- there is
              no historical index-membership tracking, which introduces mild survivorship bias (a
              company that was added to the index after underperforming, or removed before an
              eventual recovery, won&apos;t appear the way it actually did at the time).
            </li>
            <li>
              <strong>Split- and dividend-adjusted closes.</strong> Prices come from Yahoo
              Finance&apos;s adjusted close, which already accounts for stock splits and dividend
              payouts, so a trade&apos;s return reflects the real total return an actual holder
              would have seen, not a raw price change distorted by a split.
            </li>
            <li>
              <strong>No fees, slippage, taxes, or fractional shares.</strong> Every trade is
              modeled as instant, frictionless, and fully divisible -- real trading has spreads,
              commissions, tax events, and share-count rounding that this does not model.
            </li>
          </ul>
          <p>
            Results are precomputed nightly, not calculated live per request -- the number you see
            reflects the most recent nightly run, not this exact second&apos;s market data.
          </p>
        </div>
      </details>
    </footer>
  );
}
