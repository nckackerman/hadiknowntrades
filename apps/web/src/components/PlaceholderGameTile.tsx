// Non-functional placeholder tiles for The Order / The Lineup (issue #197).
//
// **Read issue #189 in full before touching this file.** Both games were
// designed, mocked, then explicitly parked after an independent
// staff-designer + staff-PM review found real, unresolved gaps: neither has
// a working daily-selection/curation mechanism, and The Lineup's
// 3-letter-ticker constraint structurally excludes almost every recognizable
// S&P 500 company. This file does not attempt to resolve either gap -- it
// exists only to give the 2x2 grid (Beat the Bench, The Call Board, The
// Order, The Lineup -- see ResultsPage.tsx's own grid comment) its intended
// visual completeness while that prerequisite design work is still undone.
// No real gameplay, no scoring, no daily-selection logic, no streak chips
// (issue #189 flags streak chips as an open, undecided retention-mechanic
// question -- leaving both tiles' badges empty/absent, per issue #197's own
// Out of scope, rather than defaulting to an implied answer), no wiring into
// daily-ritual.ts's recap (these tiles aren't "played," so the recap is
// unaffected).
//
// **Visual treatment matches BeatTheBench.tsx's/CallBoard.tsx's own
// collapsed-card tiles (issue #197's own Scope)**: an icon plate, a
// colored gradient fill, rounded corners, a status pill -- purple for The
// Order (🏁), teal for The Lineup (🧩), per issue #189's own color/icon
// assignment. Both share one internal `ComingSoonTile` (below) rather than
// two near-duplicate components, since the only real difference between
// them is copy/icon/gradient, not structure.
//
// **Deliberately NOT `<BeatTheBench>`/`<CallBoard>`'s own shape**: those
// are `<details>`/`<summary>` (CallBoard) or a plain toggled `useState`
// (BeatTheBench) specifically because clicking them reveals a real,
// interactive experience. There is nothing behind either tile here to
// reveal, so `ComingSoonTile` is a single, static, non-interactive `<div>`
// -- no `<button>`, no `<details>`, no `tabIndex`, no `onClick`. That is
// what "not interactive... no <details>/expand behavior... no
// focus-trap/dead click target" (issue #197's own Scope wording) actually
// means: rather than adding `aria-disabled` to a focusable control (which
// would still need explaining away as "focusable but does nothing" for a
// keyboard user), there is simply no focusable control here to begin with.
// `aria-disabled="true"` still sits on the tile's own `role="group"`
// container, satisfying the issue's explicit ask for the attribute and
// giving assistive tech a positive "this is disabled" signal even though
// nothing here was ever a real control -- the same "belt and suspenders"
// posture this app's own PortfolioChart `aria-hidden`+`inert` pairing
// already established (see apps/web/CLAUDE.md's "Trade replay" section,
// issue #96 follow-up round two).
//
// **Gradient colors are new, not reused from BeatTheBench's amber or
// CallBoard's blue** -- there is no committed mockup for The Order/The
// Lineup to match pixel-for-pixel (issue #189's own body: "the interactive
// mockup that did include The Order/The Lineup was a scratch artifact, not
// committed to this repo... rebuild... from this description rather than
// hunting for the original"), only issue #189's own purple/teal color
// assignment. Both gradients were tuned the same way issue #177 tuned
// CallBoard's own blue: three stops in the same "lighter to darker" 155deg
// sweep this app's other two tiles already use, each stop's white-text
// contrast independently computed (the WCAG relative-luminance formula,
// not eyeballed) and verified >= 4.5:1 AA before being committed --
//
//   The Order (purple):  #6a3db8 (7.06:1) -> #5d36a1 (8.37:1) -> #4b2b82 (10.68:1)
//   The Lineup (teal):   #297a72 (5.10:1) -> #246b64 (6.25:1) -> #1c544f (8.64:1)
//
// both comfortably clearing AA on every stop, matching the bar issue #177's
// own doc comment already holds CallBoard's blue gradient to.

/**
 * One shared padding/radius/text-color/layout className, per tile, and each
 * tile's own gradient+shadow layered on top via its own Tailwind arbitrary-
 * value class (`CallBoard.tsx`'s own approach, not `BeatTheBench.tsx`'s
 * inline-`style` one) -- a static, per-tile literal string, never built from
 * a runtime CSS custom property. Deliberately avoids threading the glow
 * color through a `var(--...)` referenced *inside* a `shadow-[...]` bracket:
 * this codebase has already been bitten once by Tailwind's bracket-value
 * class-name parsing choking on an unexpected character inside `[...]` (see
 * `BeatTheBench.tsx`'s own doc comment on why its amber gradient is an
 * inline `style`, not a bracket class) -- a literal, fully-static bracket
 * value per tile is the safer, already-proven shape (`CallBoard.tsx`'s own
 * `CARD_CLASSNAME`), not a new mechanism invented here. `min-h-28`
 * (7rem/112px) matches `CallBoard.tsx`'s own `CARD_CLASSNAME` floor --
 * `BeatTheBench.tsx`'s `CompactCard` carries no `min-h-*` class at all, so
 * this is a floor borrowed from one of the two real tiles, not something
 * both already share. Comfortably clears the 44px touch-target size this
 * app's real controls hold themselves to regardless, even though nothing
 * here is a control to begin with. No hover-lift transform and no
 * `cursor-pointer` -- unlike the two real tiles, there's nothing to click
 * here.
 */
const TILE_BASE_CLASSNAME = "min-h-28 rounded-2xl text-white px-[1.15rem] py-[1.1rem]";

interface ComingSoonTileProps {
  icon: string;
  title: string;
  subtitle: string;
  /** This tile's own gradient+shadow, a complete literal Tailwind arbitrary-value className -- see `TILE_BASE_CLASSNAME`'s own doc comment for why this is static per tile rather than built from a shared color prop. */
  gradientAndShadowClassName: string;
}

/**
 * One static, non-interactive placeholder tile -- see this file's own
 * top-of-file note for the full reasoning behind every choice here.
 *
 * `role="group"` + `aria-label` (rather than relying on a heading) gives
 * this a queryable accessible name/role pair on its own, satisfying issue
 * #197's own acceptance criterion ("verified with an accessible-name/role
 * query, not just visual inspection") without needing a visible `<h2>` --
 * unlike BeatTheBench/CallBoard, there's no expanded content elsewhere on
 * the page for a heading to anchor a landmark to, so the tile names itself
 * directly.
 */
function ComingSoonTile({
  icon,
  title,
  subtitle,
  gradientAndShadowClassName,
}: ComingSoonTileProps) {
  return (
    <div
      role="group"
      aria-label={`${title} - coming soon`}
      aria-disabled="true"
      className={`${TILE_BASE_CLASSNAME} ${gradientAndShadowClassName} flex flex-col justify-between gap-4`}
    >
      <span className="flex flex-col gap-2">
        {/* Icon plate, matching BeatTheBench's/CallBoard's own 44px
            circular translucent backdrop (issue #188). */}
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.16]"
        >
          <span className="text-3xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            {icon}
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-display text-lg leading-tight font-extrabold tracking-tight">
            {title}
          </span>
          <span className="text-xs font-medium text-white/85">{subtitle}</span>
        </span>
      </span>
      {/* Same status-pill treatment as CallBoard.tsx's own tiles use for
          "N of 3 called this week" (bg-white/20, same padding/text size) --
          BeatTheBench.tsx's own pill differs (bg-black/[14%], different
          padding), so this borrows from CallBoard specifically, not from
          "both" real tiles at once. Full white text, not a dimmed variant,
          so this reuses CallBoard's own already-verified >= 4.5:1 contrast
          rather than needing its own separate check for a lower-alpha
          label. */}
      <span className="font-numeric self-start rounded-full bg-white/20 px-2.5 py-1 text-[0.6875rem] font-bold">
        Coming soon
      </span>
    </div>
  );
}

const ORDER_GRADIENT_AND_SHADOW_CLASSNAME =
  "bg-[linear-gradient(155deg,#6a3db8_0%,#5d36a1_55%,#4b2b82_100%)] shadow-[0_8px_22px_rgba(93,54,161,0.35),0_6px_18px_rgba(0,0,0,0.35)]";

/**
 * The Order (issue #189): 5 real stocks shown shuffled; the player
 * rearranges them into what they think is yesterday's actual
 * worst-to-best performance order, with Mastermind-style per-slot feedback
 * after each attempt. Purple, 🏁, per issue #189's own assignment.
 */
export function TheOrder() {
  return (
    <section>
      <ComingSoonTile
        icon="🏁"
        title="The Order"
        subtitle="Rearrange 5 real stocks into yesterday's actual worst-to-best order."
        gradientAndShadowClassName={ORDER_GRADIENT_AND_SHADOW_CLASSNAME}
      />
    </section>
  );
}

const LINEUP_GRADIENT_AND_SHADOW_CLASSNAME =
  "bg-[linear-gradient(155deg,#297a72_0%,#246b64_55%,#1c544f_100%)] shadow-[0_8px_22px_rgba(36,107,100,0.35),0_6px_18px_rgba(0,0,0,0.35)]";

/**
 * The Lineup (issue #189): 5 mystery tickers, each exactly 3 letters,
 * guessed Wordle-style against a shared, limited guess budget. Teal, 🧩,
 * per issue #189's own assignment.
 */
export function TheLineup() {
  return (
    <section>
      <ComingSoonTile
        icon="🧩"
        title="The Lineup"
        subtitle="Guess 5 mystery 3-letter tickers, Wordle-style, from limited clues."
        gradientAndShadowClassName={LINEUP_GRADIENT_AND_SHADOW_CLASSNAME}
      />
    </section>
  );
}
