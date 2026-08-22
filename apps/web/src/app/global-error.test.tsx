import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import GlobalError from "./global-error";

/**
 * `global-error.tsx` renders its own `<html>`/`<body>` per Next's
 * convention (see that file's own doc comment), which RTL is fine
 * mounting directly into jsdom's document -- no fake boundary needed
 * here (contrast error.test.tsx's TestErrorBoundary, which exists to
 * prove a *thrown* child gets caught; this file's job is just "renders
 * the right fallback given error/reset props", the same thing
 * error.test.tsx's other two cases check for app/error.tsx).
 */
describe("app/global-error.tsx", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the on-brand fallback card", () => {
    render(<GlobalError error={new Error("boom")} reset={() => {}} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("calls reset() when Try again is clicked", () => {
    const reset = vi.fn();

    render(<GlobalError error={new Error("boom")} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("logs the error for debugging", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");

    render(<GlobalError error={error} reset={() => {}} />);

    expect(errorSpy).toHaveBeenCalledWith(error);
  });
});
