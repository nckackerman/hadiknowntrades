// One real, complete SPY trading session -- the five-minute closes
// apps/pipeline published to results/beat-the-bench/today.json (issue
// #127) for 2026-08-26, taken verbatim from a real local pipeline run
// against real Yahoo data. Not synthetic, and not hand-tuned to make any
// particular test pass: the day is a quiet one that opens at 765.67,
// dips to 764.01, tops out at 767.27 and closes at 766.08 -- a
// buy-and-hold return of +0.053%, which is exactly the
// sub-tenth-of-a-percent scale that makes Beat the Bench's settlement
// copy (and `formatSessionPercent`) need a second decimal place.
//
// 79 bars: 09:30 through 16:00 inclusive, the shape of a regular
// session. `beat-the-bench.test.ts` uses it for the mechanic's core
// invariant (zero trades ties the benchmark exactly) and for the stated
// real-time length of a full 1x playthrough.

import type { SessionBar } from "@hadiknowntrades/core";

/** 79 real SPY five-minute closes, ascending by time-of-day, from the 2026-08-26 session. */
export const SPY_SESSION_BARS: readonly SessionBar[] = [
  { time: "09:30:00", close: 765.6749877929688 },
  { time: "09:35:00", close: 765.5750122070312 },
  { time: "09:40:00", close: 766.2999877929688 },
  { time: "09:45:00", close: 765.9199829101562 },
  { time: "09:50:00", close: 766.5800170898438 },
  { time: "09:55:00", close: 766.8900146484375 },
  { time: "10:00:00", close: 766.8499755859375 },
  { time: "10:05:00", close: 766.6099853515625 },
  { time: "10:10:00", close: 766.1699829101562 },
  { time: "10:15:00", close: 765.9650268554688 },
  { time: "10:20:00", close: 765.4249877929688 },
  { time: "10:25:00", close: 765.0800170898438 },
  { time: "10:30:00", close: 765.1300048828125 },
  { time: "10:35:00", close: 765.219970703125 },
  { time: "10:40:00", close: 765.3900146484375 },
  { time: "10:45:00", close: 765.5599975585938 },
  { time: "10:50:00", close: 765.6400146484375 },
  { time: "10:55:00", close: 765.8499755859375 },
  { time: "11:00:00", close: 766.1900024414062 },
  { time: "11:05:00", close: 766.3499755859375 },
  { time: "11:10:00", close: 766.280029296875 },
  { time: "11:15:00", close: 765.7833862304688 },
  { time: "11:20:00", close: 765.77001953125 },
  { time: "11:25:00", close: 765.8499755859375 },
  { time: "11:30:00", close: 765.25 },
  { time: "11:35:00", close: 765.4600219726562 },
  { time: "11:40:00", close: 766.0700073242188 },
  { time: "11:45:00", close: 766.22998046875 },
  { time: "11:50:00", close: 765.3900146484375 },
  { time: "11:55:00", close: 765.3200073242188 },
  { time: "12:00:00", close: 765.1799926757812 },
  { time: "12:05:00", close: 765.1500244140625 },
  { time: "12:10:00", close: 765.030029296875 },
  { time: "12:15:00", close: 764.989990234375 },
  { time: "12:20:00", close: 764.9299926757812 },
  { time: "12:25:00", close: 764.7999877929688 },
  { time: "12:30:00", close: 764.8499755859375 },
  { time: "12:35:00", close: 764.1599731445312 },
  { time: "12:40:00", close: 764.0120239257812 },
  { time: "12:45:00", close: 764.0700073242188 },
  { time: "12:50:00", close: 764.2000122070312 },
  { time: "12:55:00", close: 764.719970703125 },
  { time: "13:00:00", close: 764.8889770507812 },
  { time: "13:05:00", close: 765.0499877929688 },
  { time: "13:10:00", close: 765.1400146484375 },
  { time: "13:15:00", close: 765.3350219726562 },
  { time: "13:20:00", close: 765.6500244140625 },
  { time: "13:25:00", close: 765.6500244140625 },
  { time: "13:30:00", close: 765.760009765625 },
  { time: "13:35:00", close: 765.6099853515625 },
  { time: "13:40:00", close: 765.6799926757812 },
  { time: "13:45:00", close: 765.4600219726562 },
  { time: "13:50:00", close: 765.7620239257812 },
  { time: "13:55:00", close: 765.6799926757812 },
  { time: "14:00:00", close: 765.510009765625 },
  { time: "14:05:00", close: 765.77001953125 },
  { time: "14:10:00", close: 765.4099731445312 },
  { time: "14:15:00", close: 765.7349853515625 },
  { time: "14:20:00", close: 765.5650024414062 },
  { time: "14:25:00", close: 765.6099853515625 },
  { time: "14:30:00", close: 765.75 },
  { time: "14:35:00", close: 765.739990234375 },
  { time: "14:40:00", close: 765.8599853515625 },
  { time: "14:45:00", close: 766.3200073242188 },
  { time: "14:50:00", close: 766.469970703125 },
  { time: "14:55:00", close: 766.510009765625 },
  { time: "15:00:00", close: 767.27001953125 },
  { time: "15:05:00", close: 766.9500122070312 },
  { time: "15:10:00", close: 766.969970703125 },
  { time: "15:15:00", close: 767.1900024414062 },
  { time: "15:20:00", close: 767.030029296875 },
  { time: "15:25:00", close: 766.8900146484375 },
  { time: "15:30:00", close: 766.8599853515625 },
  { time: "15:35:00", close: 766.6649780273438 },
  { time: "15:40:00", close: 766.6900024414062 },
  { time: "15:45:00", close: 767.1199951171875 },
  { time: "15:50:00", close: 766.1799926757812 },
  { time: "15:55:00", close: 766.010009765625 },
  { time: "16:00:00", close: 766.0800170898438 },
];
