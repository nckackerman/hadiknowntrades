// A single source of truth for "is this a legitimate stock price,"
// shared between yahoo-client.ts (filtering a bad bar from the upstream
// feed) and optimizer.ts (defending against any caller's input) so the
// two checks can't silently drift apart.
export function isValidPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
