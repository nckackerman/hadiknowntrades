import { describe, expect, it } from "vitest";

import { STATUS_BADGE_CLASSNAME, STEP_STYLES, callsState } from "./daily-ritual";

describe("callsState", () => {
  it("distinguishes none, some and all", () => {
    expect(callsState({ filled: 0, total: 3 })).toBe("todo");
    expect(callsState({ filled: 1, total: 3 })).toBe("partial");
    expect(callsState({ filled: 3, total: 3 })).toBe("done");
  });

  it("does not report a board with no open sessions as complete", () => {
    expect(callsState({ filled: 0, total: 0 })).toBe("todo");
  });
});

describe("STEP_STYLES", () => {
  // WCAG 1.4.1: every non-"todo" state must carry a real glyph, not just a
  // colour -- both game tiles' own corner badges (issue #186) depend on
  // this being true, since colour alone can't tell "done" apart from
  // "partial" for a colourblind viewer.
  it("gives done and partial each a real glyph or an explicit override point", () => {
    expect(STEP_STYLES.done.glyph).toBe("✓");
    expect(STEP_STYLES.done.colorClassName).not.toBe("");
    // "partial" has no glyph of its own -- CallBoard.tsx's own badge
    // supplies the filled count instead, per that component's own doc
    // comment -- but its colour still has to be real.
    expect(STEP_STYLES.partial.colorClassName).not.toBe("");
  });

  it("renders nothing at all for todo -- callers must skip it, not render an empty circle", () => {
    expect(STEP_STYLES.todo.glyph).toBe("");
    expect(STEP_STYLES.todo.colorClassName).toBe("");
  });
});

describe("STATUS_BADGE_CLASSNAME", () => {
  it("positions the badge absolutely, anchored to the tile's own corner", () => {
    expect(STATUS_BADGE_CLASSNAME).toContain("absolute");
  });
});
