// Defensive localStorage access (issue #34, the first feature in this app
// to use browser storage at all -- see apps/web/CLAUDE.md's "localStorage"
// note for the pattern this establishes and for how a future feature
// should follow it).
//
// `window.localStorage.getItem`/`setItem` can throw in the real world, not
// just hypothetically: Safari's private-browsing mode historically threw
// on any write (quota forced to 0), and a user or an enterprise policy can
// disable site data/storage entirely in any browser, which throws a
// SecurityError on *read* too. There's also no `window` at all during any
// server-side render. None of that should ever crash a page for a feature
// that's just a nice-to-have -- every call here is wrapped so a failure
// degrades to "acts as if nothing was ever saved" instead of throwing.

/**
 * Reads `key` from localStorage, or `null` if it's unset, storage is
 * unavailable (SSR, disabled, private-browsing), or the read itself
 * throws for any other reason.
 */
export function readLocalStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes `value` under `key` in localStorage. Returns whether the write
 * actually succeeded -- callers that only ever re-derive state from a
 * subsequent `readLocalStorage` call (the pattern this app uses) can
 * usually ignore the return value; it's there for a caller that wants to
 * tell the user a save didn't stick.
 */
export function writeLocalStorage(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
