// Real SPY daily closes, fetched live from the same Yahoo Finance chart
// endpoint packages/core's yahoo-client.ts uses (interval=1d,
// split/dividend-adjusted closes), on 2026-08-26 -- not synthetic data, and
// not hand-tuned to make any particular test pass.
//
// The window is the trailing 90 calendar days ending 2026-08-25 (the last
// fully-closed session at fetch time), i.e. exactly the shape and size
// apps/pipeline's computeBenchmarkSeries writes into a real
// PrecomputedResult's `benchmarkSeries.closes` (BENCHMARK_SERIES_TRAILING_DAYS
// = 90). 63 real trading days; weekends, Juneteenth (2026-06-19) and the
// observed Independence Day (2026-07-03) are genuinely absent, which is what
// market-calendar.test.ts cross-checks its own holiday model against.
//
// Used by call-board-scoring.test.ts's "always guess Up" backtest -- see that
// test for the hand-worked numbers this data produces.

import type { DailyClose } from "@hadiknowntrades/core";

/** 63 real SPY daily closes, ascending by date, 2026-05-27 through 2026-08-25. */
export const SPY_DAILY_CLOSES: readonly DailyClose[] = [
  { date: "2026-05-27", close: 748.5316162109375 },
  { date: "2026-05-28", close: 752.6609497070312 },
  { date: "2026-05-29", close: 754.5361328125 },
  { date: "2026-06-01", close: 756.5908203125 },
  { date: "2026-06-02", close: 757.6182250976562 },
  { date: "2026-06-03", close: 752.3018798828125 },
  { date: "2026-06-04", close: 755.1445922851562 },
  { date: "2026-06-05", close: 735.65478515625 },
  { date: "2026-06-08", close: 737.3204345703125 },
  { date: "2026-06-09", close: 735.1560668945312 },
  { date: "2026-06-10", close: 723.56591796875 },
  { date: "2026-06-11", close: 735.8642578125 },
  { date: "2026-06-12", close: 739.843994140625 },
  { date: "2026-06-15", close: 752.890380859375 },
  { date: "2026-06-16", close: 748.4019775390625 },
  { date: "2026-06-17", close: 739.0560302734375 },
  { date: "2026-06-18", close: 746.739990234375 },
  { date: "2026-06-22", close: 744.3900146484375 },
  { date: "2026-06-23", close: 733.5800170898438 },
  { date: "2026-06-24", close: 733.239990234375 },
  { date: "2026-06-25", close: 734.2999877929688 },
  { date: "2026-06-26", close: 728.989990234375 },
  { date: "2026-06-29", close: 741 },
  { date: "2026-06-30", close: 746.77001953125 },
  { date: "2026-07-01", close: 745.760009765625 },
  { date: "2026-07-02", close: 744.780029296875 },
  { date: "2026-07-06", close: 751.280029296875 },
  { date: "2026-07-07", close: 747.7100219726562 },
  { date: "2026-07-08", close: 745.4000244140625 },
  { date: "2026-07-09", close: 751.7100219726562 },
  { date: "2026-07-10", close: 754.9500122070312 },
  { date: "2026-07-13", close: 749.1699829101562 },
  { date: "2026-07-14", close: 751.8300170898438 },
  { date: "2026-07-15", close: 754.8099975585938 },
  { date: "2026-07-16", close: 750.719970703125 },
  { date: "2026-07-17", close: 743.2899780273438 },
  { date: "2026-07-20", close: 742.0900268554688 },
  { date: "2026-07-21", close: 748.280029296875 },
  { date: "2026-07-22", close: 747.4099731445312 },
  { date: "2026-07-23", close: 738.1799926757812 },
  { date: "2026-07-24", close: 738.9299926757812 },
  { date: "2026-07-27", close: 739.0900268554688 },
  { date: "2026-07-28", close: 740.8599853515625 },
  { date: "2026-07-29", close: 729.4600219726562 },
  { date: "2026-07-30", close: 741.6900024414062 },
  { date: "2026-07-31", close: 747.030029296875 },
  { date: "2026-08-03", close: 757.6699829101562 },
  { date: "2026-08-04", close: 771.3300170898438 },
  { date: "2026-08-05", close: 769.7899780273438 },
  { date: "2026-08-06", close: 768.5599975585938 },
  { date: "2026-08-07", close: 773.260009765625 },
  { date: "2026-08-10", close: 773.030029296875 },
  { date: "2026-08-11", close: 770.5599975585938 },
  { date: "2026-08-12", close: 772.489990234375 },
  { date: "2026-08-13", close: 777.8800048828125 },
  { date: "2026-08-14", close: 776.3400268554688 },
  { date: "2026-08-17", close: 772.6699829101562 },
  { date: "2026-08-18", close: 767.4500122070312 },
  { date: "2026-08-19", close: 769.0599975585938 },
  { date: "2026-08-20", close: 762.5999755859375 },
  { date: "2026-08-21", close: 765.719970703125 },
  { date: "2026-08-24", close: 763.469970703125 },
  { date: "2026-08-25", close: 765.9099731445312 },
];
