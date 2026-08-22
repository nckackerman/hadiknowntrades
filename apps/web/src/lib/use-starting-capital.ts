"use client";

// Owns the user's chosen starting dollar amount (issue #15), persisted
// across reloads via localStorage -- this app's first use of browser
// storage (a separate, unrelated in-progress feature, issue #34, is
// expected to add its own independent key later; see
// apps/web/CLAUDE.md's note on this).
//
// Storage access itself goes through lib/local-storage.ts's
// readLocalStorage/writeLocalStorage rather than calling
// window.localStorage directly -- see that file's own doc comment and
// apps/web/CLAUDE.md's "localStorage pattern" section: it's documented
// as the one place this app should ever touch window.localStorage
// directly, specifically so every feature's try/catch/SSR-guard logic
// doesn't get re-implemented ad hoc per hook.

import { useEffect, useState } from "react";

import { readLocalStorage, writeLocalStorage } from "./local-storage";
import {
  DEFAULT_STARTING_CAPITAL,
  clampStartingCapital,
  parseStartingCapital,
} from "./starting-capital";

const STORAGE_KEY = "hikt:startingCapital";

/** Reads and validates whatever's stored, if anything -- `null` covers
 * "nothing saved yet," "not a usable number," and "localStorage itself
 * unavailable/throwing" (readLocalStorage already degrades all of that
 * to `null`) uniformly, since every one of those cases means the same
 * thing to the caller: fall back to the default. */
function readStoredStartingCapital(): number | null {
  const raw = readLocalStorage(STORAGE_KEY);
  return raw === null ? null : parseStartingCapital(raw);
}

function writeStoredStartingCapital(value: number): void {
  // writeLocalStorage's boolean return (did the write actually stick) is
  // intentionally ignored here, same as every other caller of it in this
  // app -- the in-memory state this hook returns still updates
  // regardless of whether the write succeeded, so the control keeps
  // working for the rest of this session even if the choice won't
  // survive a reload.
  writeLocalStorage(STORAGE_KEY, String(value));
}

/**
 * The user's chosen starting dollar amount, defaulting to
 * DEFAULT_STARTING_CAPITAL (today's fixed $20) and persisted to
 * localStorage across reloads once changed.
 *
 * Always starts at DEFAULT_STARTING_CAPITAL on every render -- including
 * the very first client render during hydration -- and only corrects to
 * whatever's actually in storage from an effect after mount. This is the
 * same hydration-safety trick prefers-reduced-motion.ts/use-count-up.ts
 * use for the same reason (see their own doc comments): reading
 * localStorage during render would make the client's first render
 * (during hydration) disagree with the server-rendered HTML whenever a
 * non-default value was already stored, which is exactly the kind of
 * hydration mismatch those files already warn against. The tradeoff is
 * the same one they accept too -- a brief flash of the default value
 * before the real one applies just after mount -- rather than a
 * console-visible hydration error.
 */
export function useStartingCapital(): [number, (next: number) => void] {
  const [startingCapital, setStartingCapitalState] = useState(DEFAULT_STARTING_CAPITAL);

  useEffect(() => {
    // Deferred to a microtask rather than called synchronously as the
    // first thing in the effect body -- react-hooks/set-state-in-effect
    // flags exactly that shape (a direct, unconditional-looking setState
    // at the top of an effect), the same lint use-count-up.ts's own doc
    // comment describes working around by folding a setState call into
    // a callback invoked by something external to the effect itself
    // (there, requestAnimationFrame; here, the microtask queue) instead
    // of calling it as the effect's own first statement.
    queueMicrotask(() => {
      const stored = readStoredStartingCapital();
      if (stored !== null) {
        setStartingCapitalState(stored);
      }
    });
    // Mount-only: a one-time "hydrate from storage" correction, not a
    // subscription that should ever re-run.
  }, []);

  function setStartingCapital(next: number): void {
    const clamped = clampStartingCapital(next);
    setStartingCapitalState(clamped);
    writeStoredStartingCapital(clamped);
  }

  return [startingCapital, setStartingCapital];
}
