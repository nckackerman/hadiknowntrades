// The actual pixel rendering for the OG share card (issue #33), split
// out of ../app/api/og/[range]/route.tsx so `renderOgCard` can be called
// directly -- from the route, or from a throwaway local script for live
// visual verification (see apps/web/CLAUDE.md's OG card note) -- without
// needing a real S3 bucket, `next dev`/`next start`, or a request/response
// cycle at all. Takes an already-built `OgCardContent` (../lib/og-card.ts,
// plain strings/booleans, unit tested there) rather than a raw
// `PrecomputedResult`, so this file is pure rendering with no data-fetch
// or validation concerns of its own.

import { ImageResponse } from "next/og";

import type { OgCardContent } from "@/lib/og-card";
import { rangeLabel } from "@/lib/og-card";

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

// On-brand tokens, hand-copied from globals.css's light (`:root`)
// palette -- Satori renders once, server-side, with no access to a
// viewer's OS theme preference, so this card deliberately always renders
// in the light palette rather than picking one arbitrarily per request.
// If globals.css's values ever change, update these copies too --
// nothing enforces they stay in sync (same known gap as
// app/global-error.tsx's own hand-copied token values).
const BACKGROUND = "#fcfcfb";
const ACCENT = "#2a78d6";
const TEXT_PRIMARY = "#0b0b0b";
const TEXT_SECONDARY = "#52514e";
const TEXT_MUTED = "#898781";
const GRIDLINE = "#e1e0d9";
const STATUS_GOOD = "#006300";
const STATUS_CRITICAL = "#d03b3b";

/** Renders one OG card as a 1200x630 PNG `ImageResponse` for the given content. */
export function renderOgCard(content: OgCardContent): ImageResponse {
  const multiplierColor = content.isMultiplierGain ? STATUS_GOOD : STATUS_CRITICAL;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: BACKGROUND,
        padding: "56px 72px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", width: 16, height: 16, backgroundColor: ACCENT }} />
          <span
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: TEXT_MUTED,
            }}
          >
            Had I Known Trades
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 24, marginTop: 44 }}>
          <span style={{ fontSize: 96, fontWeight: 700, color: TEXT_PRIMARY }}>
            {content.startingCapitalLabel}
          </span>
          <span style={{ display: "flex", fontSize: 64, color: TEXT_MUTED }}>{"→"}</span>
          <span style={{ fontSize: 96, fontWeight: 700, color: TEXT_PRIMARY }}>
            {content.endingBalanceLabel}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 16 }}>
          <span style={{ display: "flex", fontSize: 44, fontWeight: 700, color: multiplierColor }}>
            ({content.multiplierLabel})
          </span>
          <span style={{ display: "flex", fontSize: 32, color: TEXT_SECONDARY }}>
            {rangeLabel(content.range)} range &middot; best possible 3-trade outcome
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          paddingTop: 24,
          borderTop: `2px solid ${GRIDLINE}`,
        }}
      >
        <span style={{ display: "flex", fontSize: 24, color: TEXT_MUTED }}>
          Hindsight only, using closed market data through {content.dataAsOfLabel} -- not investment
          advice.
        </span>
      </div>
    </div>,
    { width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT },
  );
}
