import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareCardLink } from "./ShareCardLink";

/**
 * jsdom implements no `navigator.clipboard` of its own, so every test
 * states explicitly which of the three real cases it's exercising: a
 * working clipboard, a rejecting one (permission denied), or none at all
 * (a non-secure origin).
 *
 * **Must be called after `userEvent.setup()`, not before** -- setup
 * installs its own working `navigator.clipboard` stub, which otherwise
 * silently wins over this one and makes every "no/denied clipboard" test
 * exercise the happy path instead (a real failure this was written
 * against, not a hypothetical ordering worry).
 */
function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(window.navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
    writable: true,
  });
}

describe("ShareCardLink", () => {
  afterEach(() => {
    // Back to jsdom's own default (no clipboard at all), so a stub can't
    // leak into the next test.
    Reflect.deleteProperty(window.navigator, "clipboard");
    vi.unstubAllGlobals();
  });

  it("copies an absolute link to this range's own card route", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<ShareCardLink range="1W" />);

    await user.click(screen.getByRole("button", { name: "Copy share card link" }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/og/1W`);
    expect(screen.getByRole("status")).toHaveTextContent("Link copied");
  });

  it("links to the exact-case range, which is what the card route accepts", async () => {
    // route.tsx rejects any case variant outright (see isCanonicalRange)
    // -- a lowercased link here would 404 for the person it was shared
    // with, so this asserts the exact string, not a case-insensitive
    // match.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<ShareCardLink range="MAX" />);

    await user.click(screen.getByRole("button", { name: "Copy share card link" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/og\/MAX$/));
  });

  it("says nothing until the button is actually clicked", () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    render(<ShareCardLink range="1M" />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("falls back to a selectable link when the clipboard write is denied", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<ShareCardLink range="3M" />);

    await user.click(screen.getByRole("button", { name: "Copy share card link" }));

    expect(screen.getByRole("status")).toHaveTextContent("Couldn't copy automatically");
    expect(screen.getByRole("textbox", { name: "Share card link" })).toHaveValue(
      `${window.location.origin}/api/og/3M`,
    );
  });

  it("falls back the same way when there's no clipboard API at all (a non-secure origin)", async () => {
    const user = userEvent.setup();
    stubClipboard(null);
    render(<ShareCardLink range="1Y" />);

    await user.click(screen.getByRole("button", { name: "Copy share card link" }));

    expect(screen.getByRole("textbox", { name: "Share card link" })).toHaveValue(
      `${window.location.origin}/api/og/1Y`,
    );
  });
});
