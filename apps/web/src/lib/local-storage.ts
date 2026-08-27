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
    notifyLocalStorageListeners();
    return true;
  } catch {
    return false;
  }
}

// --- Change notification (issue #133) -------------------------------------
//
// The daily ritual's status rail summarises state that three *other*
// features own and write (Beat the Bench's played record, The Call Board's
// picks, the whole-range guess). It has to re-read the moment any of them
// writes, and none of those writes go through React state it can see.
//
// The notification therefore hangs off this module rather than off any one
// feature: `writeLocalStorage` is already the single choke point every
// feature's storage module funnels through (that's this file's whole
// point), so subscribing here wires the rail to all three -- and to any
// future one -- without a single line of per-feature coupling, and without
// the rail ever mirroring state it doesn't own.
//
// **A listener must not write to localStorage**, directly or indirectly:
// this notifies synchronously, so a writing listener would re-enter its own
// notification. Every subscriber shipped today is a pure reader (see
// use-daily-ritual.ts, which deliberately reads The Call Board's picks
// rather than calling `syncCallBoard`, precisely because that function
// writes back a freshly-resolved history).

type LocalStorageListener = () => void;

const listeners = new Set<LocalStorageListener>();

function notifyLocalStorageListeners(): void {
  // Iterate a copy: a listener that unsubscribes itself (a React effect
  // cleanup racing a write) must not mutate the set mid-iteration.
  for (const listener of [...listeners]) listener();
}

/**
 * Subscribes to localStorage changes made through `writeLocalStorage`, and
 * to `storage` events (which fire only for writes made in *other* tabs of
 * the same origin -- the browser never fires them for the document that did
 * the writing, which is exactly why the in-process notification above has
 * to exist too).
 *
 * Returns an unsubscribe function. Safe to call during a server render:
 * there's no `window` to attach the cross-tab listener to, and nothing can
 * write, so it's a no-op that still returns a valid cleanup.
 */
export function subscribeToLocalStorage(listener: LocalStorageListener): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = () => listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
