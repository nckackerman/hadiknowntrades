"use client";

import { MODE_LABELS, MODES, type Mode } from "@/lib/mode";

interface ModeToggleProps {
  selected: Mode;
  onSelect: (mode: Mode) => void;
}

/**
 * The long-only / long+short pill toggle (issue #13) -- same controlled-
 * component, pill-button pattern as RangeSelector.tsx (the caller owns
 * which mode is selected and, in the real page, syncs it to the URL via
 * `?mode=`, see lib/mode.ts).
 */
export function ModeToggle({ selected, onSelect }: ModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="Trading mode"
      className="inline-flex gap-1 rounded-full bg-[var(--surface-2)] p-1"
    >
      {MODES.map((mode) => {
        const isSelected = mode === selected;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(mode)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              isSelected
                ? "bg-[var(--series-1)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {MODE_LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}
