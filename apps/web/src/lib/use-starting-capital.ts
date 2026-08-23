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

import {
  DEFAULT_STARTING_CAPITAL,
  clampStartingCapital,
  parseStartingCapital,
} from "./starting-capital";
import { readLocalStorage, writeLocalStorage } from "./local-storage";
import { useHydratedLocalStorageState } from "./use-hydrated-local-storage-state";

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
 * A thin wrapper around use-hydrated-local-storage-state.ts's generic
 * hydration-safe "start at a default, correct from storage after mount"
 * hook -- see that file's own doc comment for the full hydration-safety
 * reasoning and the mount-to-microtask race guard, both shared verbatim
 * with use-onboarding-dismissed.ts (issue #64), the second caller whose
 * addition is what prompted factoring this out (a real code-review
 * finding: this hook and that one used to duplicate the identical
 * mount-hydration + race-guard logic near-verbatim). The only thing this
 * wrapper adds on top is `clampStartingCapital` on write, so an
 * out-of-range value is never persisted or reflected in state.
 */
export function useStartingCapital(): [number, (next: number) => void] {
  const [startingCapital, setStartingCapitalState] = useHydratedLocalStorageState(
    DEFAULT_STARTING_CAPITAL,
    readStoredStartingCapital,
    writeStoredStartingCapital,
  );

  function setStartingCapital(next: number): void {
    setStartingCapitalState(clampStartingCapital(next));
  }

  return [startingCapital, setStartingCapital];
}
