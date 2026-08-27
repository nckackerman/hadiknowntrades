import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./copy-text";

/**
 * jsdom does not implement `navigator.clipboard` at all -- there's no
 * property to spy on, and no amount of test setup makes a real one appear.
 * That is expected rather than a gap to fight: stub the shape the module
 * actually reads (`navigator.clipboard.writeText`) and assert against it.
 * The real end-to-end path is verified separately, in a real headless
 * Chromium with the clipboard permission granted -- see apps/web/CLAUDE.md.
 */
function stubClipboard(writeText: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

afterEach(() => {
  // Remove the stub entirely rather than leaving an undefined-valued
  // property behind, so the next test starts from jsdom's real "no
  // clipboard at all" state.
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyText", () => {
  it("writes the text and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("reports failure when the write is refused, without throwing", async () => {
    // What a denied clipboard permission actually looks like.
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    stubClipboard(writeText);

    await expect(copyText("hello")).resolves.toBe(false);
  });

  it("reports failure when the API isn't there at all (a non-secure context)", async () => {
    stubClipboard(undefined);

    await expect(copyText("hello")).resolves.toBe(false);
  });

  it("reports failure when `clipboard` exists but has no writeText", async () => {
    stubClipboard(null);

    await expect(copyText("hello")).resolves.toBe(false);
  });
});
