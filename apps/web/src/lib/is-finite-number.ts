// A single source of truth for "is this a real, usable number" when
// validating an untrusted `unknown` value read back from localStorage
// (a hand-edited value, or a stale stored shape, can be anything) --
// shared by every per-feature storage module's own shape validator
// (beat-the-bench-storage.ts, lineup-storage.ts) so the check can't
// silently drift between them. `JSON.parse` itself never produces
// `NaN`/`Infinity` (both serialize to `null`), but a validator has to
// reject them anyway since the parsed value is `unknown`, not narrowed
// to "whatever JSON.parse can produce."
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
