import { vi } from "vitest";

/**
 * Stubs `window.matchMedia` per-query (unlike
 * `stub-prefers-reduced-motion.test-util.ts`'s own `stubPrefersReducedMotion`
 * -- a single fixed `matches` regardless of query, fine for a caller that
 * only ever checks one media feature). `use-chart-tap-hint.ts` checks two
 * independent queries (`(pointer: coarse)`, plus
 * `prefersReducedMotion()`'s own `(prefers-reduced-motion: reduce)`), so
 * its own tests -- here and in `PortfolioChart.test.tsx`, which renders
 * the same hook indirectly -- need to control them independently.
 * Extracted once both call sites needed the identical stub (code review
 * finding on issue #66's own PR, fixed) rather than left as two
 * hand-copied duplicates.
 *
 * jsdom in this repo's Vitest setup doesn't implement `matchMedia` at
 * all -- see `use-count-up.ts`'s own doc comment -- so any test that
 * exercises a `matchMedia`-gated code path needs this stub even to reach
 * a deterministic `false` default.
 *
 * `.test-util.ts` (not `.ts`) so this is never mistaken for a real
 * application module or picked up by Vitest as its own test file.
 */
export function stubMatchMedia(overrides: Record<string, boolean>): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: overrides[query] ?? false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}
