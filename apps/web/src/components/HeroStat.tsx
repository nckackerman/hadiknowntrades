import { formatHeroCurrency } from "@/lib/format-currency";

interface HeroStatProps {
  startingCapital: number;
  endingBalance: number;
}

/** The "$20 -> $X" headline figure. Exactly one per view, per the dataviz skill's hero-figure spec: >=48px, the same sans as the rest of the page, proportional (not tabular) figures. */
export function HeroStat({ startingCapital, endingBalance }: HeroStatProps) {
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm font-medium text-[var(--text-secondary)]">Starting from</p>
      <p className="flex flex-wrap items-baseline gap-3 text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
        <span>{formatHeroCurrency(startingCapital)}</span>
        <span aria-hidden="true" className="text-[var(--text-muted)]">
          →
        </span>
        <span>{formatHeroCurrency(endingBalance)}</span>
      </p>
    </div>
  );
}
