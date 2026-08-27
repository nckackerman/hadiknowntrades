"use client";

// The daily hero (issue #161): the previous market day's own result,
// leading with a direct statement ("Had you known, you'd have made 3
// trades and turned $20.00 into $X.XX") instead of the 1W range view's
// guess-then-reveal gate -- the app's new top-of-page content, matching
// the "daily game" framing this UI-simplification pass is working
// toward. See docs/design/ui-simplification-2026-08/ for the mockup
// this matches (its own README: 99% visual fidelity is the bar, not
// pixel-perfect) -- this component uses this app's own real design
// tokens/components (HeroStat's exported classes, format-currency.ts,
// narrate-trades.ts), not the mockup's own literal inline CSS.
//
// Mounted directly in ResultsPage.tsx, above the existing header/range
// explorer. It fetches its own data (useDailyChallenge, the same fixed
// `/api/results?range=1W` `use-call-board.ts` already fetches) rather
// than taking a PrecomputedResult prop -- ResultsPanel renders nothing
// until /api/results succeeds, and this section is meant to be the very
// first thing a visitor sees regardless of how that fetch goes.
//
// **No guess-then-reveal gate here**, unlike `WholeRangeBalance.tsx`'s
// whole-range headline (issue #91) -- this is a direct statement, per
// this issue's own Goal. That mechanic (and the whole 1W range view it
// lives in) is completely untouched by this issue; it just becomes a
// secondary, demoted view in a later issue.
//
// **Deliberately not animated** -- unlike `HeroStat.tsx`'s count-up
// reveal, this figure renders its final value immediately. Reusing
// `HeroStat`'s exported typography classes (`heroValueRowClassName`,
// `heroMultiplierClassName`/`heroMultiplierColor`) gives this section
// the same hero-scale look without pulling in `useCountUp`/
// `CelebrationBurst`/the reveal-accent glow, none of which this issue's
// own Scope asks for -- consistent with this app's other static figures
// (`WorstCaseStat`, `BenchmarkStat`, the trade narration below), which
// stay unanimated for the same reason.

import {
  heroMultiplierClassName,
  heroMultiplierColor,
  heroValueRowClassName,
} from "@/components/HeroStat";
import { formatHeroCurrency, formatMultiplier, formatPercent } from "@/lib/format-currency";
import { formatDateWithWeekday, formatTime } from "@/lib/format-date";
import type { Mode } from "@/lib/mode";
import { narrateTrades, type TradeNarration } from "@/lib/narrate-trades";
import { useDailyChallenge } from "@/lib/use-daily-challenge";

interface DailyHeroProps {
  mode: Mode;
}

/** Anchor target for the "See the trades ↓" scroll cue below. */
const TRADES_SECTION_ID = "daily-hero-trades";

function LoadingCard() {
  return (
    <div
      aria-hidden="true"
      className="flex animate-pulse flex-col gap-3 rounded-xl border border-[var(--gridline)] bg-[var(--surface-1)] px-6 py-6"
    >
      <div className="h-3 w-48 rounded bg-[var(--surface-2)]" />
      <div className="h-12 w-72 rounded bg-[var(--surface-2)]" />
      <div className="h-4 w-56 rounded bg-[var(--surface-2)]" />
    </div>
  );
}

/**
 * "Yesterday's trades" narration, in the same past-tense prose style
 * `lib/narrate-trades.ts`/`TradeList.tsx` already use for the window
 * model (issue #32) -- reuses `narrateTrades` directly rather than a
 * second narration function, per this issue's own Scope. The JSX here
 * mirrors `TradeList.tsx`'s own sentence-building closely, differing in
 * exactly one place: "at {time}" instead of "on {date}" for each
 * trade's open/close labels (the day itself is already named by this
 * section's own eyebrow above, so it isn't repeated per trade) --
 * matching `IntradayTradeList`/`TradeRow.tsx`'s own established "at" for
 * a time-of-day label, vs. `TradeList.tsx`'s "on" for a calendar date.
 */
function TradeNarrationList({ narrations }: { narrations: TradeNarration[] }) {
  return (
    <ol className="surface-card rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-3 text-sm leading-relaxed text-[var(--text-primary)]">
      {narrations.map((narration, index) => {
        const startPhrase =
          index === 0 ? `your ${formatHeroCurrency(narration.startBalance)}` : "that";
        const before = `${index > 0 ? " " : ""}${narration.leadIn} ${narration.openVerb} `;
        const middle =
          ` at ${narration.buyLabel} at ${formatHeroCurrency(narration.buyPrice)} and ${narration.closeVerb} at ` +
          `${narration.sellLabel} at ${formatHeroCurrency(narration.sellPrice)}, turning ` +
          `${startPhrase} into ${formatHeroCurrency(narration.endBalance)} `;

        return (
          <li key={narration.key} className="trade-narration-item">
            {before}
            <span className="font-semibold">{narration.ticker}</span>
            {middle}
            <span
              className="font-semibold"
              style={{
                color: narration.isGain ? "var(--status-good)" : "var(--status-critical)",
              }}
            >
              ({formatPercent(narration.returnFraction)})
            </span>
            {"."}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The daily hero section itself: an eyebrow date label, the "had you
 * known" statement + $20 -> $X figures + multiplier badge, the ticker
 * sequence, a scroll cue, and (as a following sibling section, per this
 * issue's own Scope item 4) the "Yesterday's trades" prose narration.
 * Returns a Fragment of two sibling sections -- like `TradeReplay.tsx`'s
 * own doc comment explains for the identical shape, a component
 * returning more than one logical block for a parent's `flex flex-col
 * gap-*` column must return real siblings, not one wrapping div, or the
 * parent's own gap collapses to whatever gap a new wrapper happens to
 * use instead.
 */
export function DailyHero({ mode }: DailyHeroProps) {
  const { dailyChallenge, loading } = useDailyChallenge(mode);

  if (loading) {
    return <LoadingCard />;
  }
  if (dailyChallenge === null) {
    // Degrades to nothing rather than an error box -- the same silent
    // graceful-degrade posture `BenchmarkStat`'s own `null` render and
    // the OG card route's 404 already take elsewhere in this app. The
    // existing range explorer below still works even when this section
    // has nothing to show (a fetch error, or a range with no trading
    // days published yet).
    return null;
  }

  const tickers = dailyChallenge.trades.map((trade) => trade.ticker);
  const tradeCount = tickers.length;
  const eyebrowDate = formatDateWithWeekday(dailyChallenge.date);

  if (tradeCount === 0) {
    return (
      <section
        aria-label="Yesterday's result"
        className="surface-card flex flex-col gap-3 rounded-xl border border-[var(--gridline)] bg-[var(--surface-1)] px-6 py-6"
      >
        <p className="font-numeric text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
          Yesterday · {eyebrowDate}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          No trade would have beaten holding cash on {eyebrowDate}.
        </p>
      </section>
    );
  }

  const multiplier = dailyChallenge.endingBalance / dailyChallenge.startingCapital;
  const narrations = narrateTrades(
    dailyChallenge.trades.map((trade) => ({
      ticker: trade.ticker,
      direction: trade.direction,
      buyLabel: formatTime(trade.openTime),
      buyPrice: trade.openPrice,
      sellLabel: formatTime(trade.closeTime),
      sellPrice: trade.closePrice,
    })),
    dailyChallenge.startingCapital,
  );

  return (
    <>
      <section
        aria-label="Yesterday's result"
        className="surface-card flex flex-col gap-3 rounded-xl border border-[var(--gridline)] bg-[var(--surface-1)] px-6 py-6"
      >
        <p className="font-numeric text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
          Yesterday · {eyebrowDate}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          Had you known, you&apos;d have made{" "}
          <strong className="font-semibold text-[var(--text-primary)]">
            {tradeCount} {tradeCount === 1 ? "trade" : "trades"}
          </strong>{" "}
          and turned
        </p>
        <p className={heroValueRowClassName}>
          <span>{formatHeroCurrency(dailyChallenge.startingCapital)}</span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            →
          </span>
          <span style={{ color: heroMultiplierColor(multiplier) }}>
            {formatHeroCurrency(dailyChallenge.endingBalance)}
          </span>
          <span
            className={heroMultiplierClassName}
            style={{ color: heroMultiplierColor(multiplier) }}
          >
            ({formatMultiplier(multiplier)})
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-1.5 font-numeric text-sm font-semibold text-[var(--text-secondary)]">
          {tickers.map((ticker, index) => (
            <span key={`${ticker}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="font-normal text-[var(--text-muted)]">
                  →
                </span>
              )}
              {ticker}
            </span>
          ))}
        </p>
        <a
          href={`#${TRADES_SECTION_ID}`}
          className="text-sm text-[var(--text-secondary)] underline underline-offset-2"
        >
          See the trades ↓
        </a>
      </section>

      <div id={TRADES_SECTION_ID} className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Yesterday&apos;s trades
        </h2>
        <TradeNarrationList narrations={narrations} />
      </div>
    </>
  );
}
