// The small icon-plate + heading row every daily-hub game's expanded
// panel opens with (issue #195's connector device #2, extended to all
// four games once Beat the Bench's own tile stopped fully unmounting on
// expand -- see BeatTheBench.tsx's own top-of-file note): a persistent
// visual echo of the collapsed tile's own icon, tinted with a ~15% wash
// of the panel's own `CONNECTOR_ACCENT`, beside a heading naming the
// mechanic. Each game's own sr-only `<h2>` landmark already names its
// section for accessibility purposes; this is the first *visible*
// instance of that name once the panel is open.
//
// Extracted once this exact JSX (icon span, `h-9 w-9`/`text-lg` plate,
// `text-sm font-medium` h3, `${accentColor}26` wash) turned up
// hand-duplicated verbatim across all four game components -- a real
// reuse finding, not written speculatively ahead of a need.

interface GamePanelHeaderProps {
  /** The single emoji echoing the collapsed tile's own icon. */
  icon: string;
  /** The panel's own `CONNECTOR_ACCENT` -- a bare 6-digit hex, not yet carrying the wash's own alpha suffix (this component appends `26` itself, so every caller's wash stays byte-identical). */
  accentColor: string;
  /** The mechanic's name, matching the game's own sr-only landmark heading. */
  title: string;
}

export function GamePanelHeader({ icon, accentColor, title }: GamePanelHeaderProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
        style={{ backgroundColor: `${accentColor}26` }}
      >
        {icon}
      </span>
      <h3 className="text-sm font-medium text-[var(--text-primary)]">{title}</h3>
    </div>
  );
}
