// A single source of truth for "safely parse a raw localStorage read into
// an untrusted `unknown` value" -- shared by every per-feature storage
// module's own read path (call-board-storage.ts, order-storage.ts,
// lineup-storage.ts) so the same three-line try/catch can't silently
// drift between them. `raw === null` (the key was never set, or
// `readLocalStorage` itself degraded to "nothing stored") and a value
// that fails to parse are both treated as "nothing usable" -- the
// caller's own shape validator is what tells the difference between
// "never played" and "a malformed value," not this function.
export function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
