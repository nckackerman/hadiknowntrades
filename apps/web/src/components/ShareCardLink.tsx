"use client";

import { useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import { buttonClassName } from "@/components/TradeReplay";

type CopyStatus = "idle" | "copied" | "failed";

interface ShareCardLinkProps {
  /**
   * The preset range whose card to link to -- `/api/og/{range}` (see
   * app/api/og/[range]/route.tsx). Only a *preset* range has a card
   * route at all: a custom start-date anchor (issue #11) has no
   * `/api/og/...` equivalent, so that branch simply doesn't render this
   * component rather than this prop widening to accept an anchor.
   */
  range: PresetRange;
}

/**
 * The one visible way into this app's share card (issue #134) -- a
 * copy-link button for `/api/og/{range}`, the 1200x630 PNG this app has
 * rendered since issue #33 but never linked to from anywhere, so nobody
 * outside the codebase had any way to know it existed.
 *
 * **Copy-link, not a file download**, per the issue's own scope. Two
 * independent reasons, either sufficient on its own: this project has
 * already hit page-initiated downloads being inert in a real embedding
 * context (see the issue's own background), and a link is simply the
 * better share primitive regardless -- it pastes into a chat/post as a
 * live image, stays a single canonical URL that re-renders itself as the
 * nightly pipeline refreshes the underlying result (this route is
 * ISR-cached on a 24h window matching that cadence), and never leaves a
 * stale copy of yesterday's numbers sitting in someone's downloads
 * folder.
 *
 * **Deliberately renders only where the underlying figure is already on
 * screen** -- in the intraday-daily model that means inside the
 * post-reveal branch, after the user has answered `WholeRangeBalance`'s
 * own guess prompt (issue #91), never before. See ResultsPanel.tsx's own
 * call sites, and this PR's description, for the full reasoning: the
 * card's URL is guessable and unauthenticated either way, so this is
 * about not handing a player a one-click spoiler for the game they're
 * mid-way through, not about actually protecting the number.
 *
 * The URL is built from `window.location.origin` inside the click
 * handler rather than during render -- nothing about this component's
 * markup depends on it, so there's no SSR/hydration story to get wrong
 * (the same "read browser-only state at the last possible moment"
 * discipline use-count-up.ts/prefers-reduced-motion.ts already apply for
 * `matchMedia`).
 */
export function ShareCardLink({ range }: ShareCardLinkProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  // Only populated on a copy failure -- see handleCopy.
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  async function handleCopy() {
    const url = `${window.location.origin}/api/og/${range}`;
    try {
      // `navigator.clipboard` is genuinely absent in some real contexts
      // (any non-secure origin, and jsdom), not just deniable -- an
      // unguarded `.writeText` would throw a TypeError rather than
      // rejecting, so the optional call plus the explicit undefined
      // check below covers both shapes of failure through one path.
      const written = navigator.clipboard?.writeText(url);
      if (written === undefined) throw new Error("clipboard unavailable");
      await written;
      setStatus("copied");
      setFallbackUrl(null);
    } catch {
      // Degrade to showing the URL itself rather than a dead end -- the
      // user can still select and copy it by hand, which is the whole
      // point of the affordance. Same graceful-degradation posture
      // local-storage.ts takes for its own unavailable-API case.
      setStatus("failed");
      setFallbackUrl(url);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleCopy} className={buttonClassName}>
          Copy share card link
        </button>
        {/* Always present so the copy result is a live-region *update*,
            not a live-region *mount* -- the same reasoning
            ResultsPanel.tsx's own always-rendered status regions use. */}
        <p role="status" aria-live="polite" className="text-sm text-[var(--text-muted)]">
          {status === "copied" && "Link copied -- paste it anywhere to share the card."}
          {status === "failed" && "Couldn't copy automatically -- copy the link below."}
        </p>
      </div>
      {fallbackUrl !== null && (
        <input
          type="text"
          readOnly
          value={fallbackUrl}
          aria-label="Share card link"
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-secondary)]"
        />
      )}
    </div>
  );
}
