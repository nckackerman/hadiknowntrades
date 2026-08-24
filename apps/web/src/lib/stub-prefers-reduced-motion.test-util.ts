import { vi } from "vitest";

/**
 * Stubs `window.matchMedia` with a single fixed `matches` regardless of
 * query -- fine for any caller that only ever checks one media feature
 * (`prefers-reduced-motion`). A caller that needs to control more than
 * one query independently (e.g. `use-chart-tap-hint.ts`'s own
 * `(pointer: coarse)` check alongside this one) should use
 * `stub-match-media.test-util.ts`'s per-query `stubMatchMedia` instead.
 *
 * jsdom in this repo's Vitest setup doesn't implement `matchMedia` at
 * all -- see `use-count-up.ts`'s own doc comment -- so any test that
 * exercises a `matchMedia`-gated code path needs this stub even to reach
 * a deterministic `false` default.
 *
 * Extracted once a third caller (`PortfolioChart.test.tsx`, issue #85)
 * needed the identical stub already hand-copied between
 * `use-count-up.test.ts` and `HeroStat.test.tsx` -- `stub-match-media
 * .test-util.ts`'s own doc comment already flagged this as "worth
 * extracting alongside this one if a third caller ever needs it."
 *
 * `.test-util.ts` (not `.ts`) so this is never mistaken for a real
 * application module or picked up by Vitest as its own test file.
 */
export function stubPrefersReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}
