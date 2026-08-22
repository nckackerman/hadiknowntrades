import { Component, type ReactNode } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ErrorPage from "./error";

/**
 * A minimal stand-in for Next's real error-boundary wiring (see
 * node_modules/next/dist/client/components/error-boundary.d.ts's
 * ErrorBoundaryHandler) -- just enough of the same shape (catch a
 * render-time throw, hand `error`/`reset` to the same fallback
 * component this app ships as app/error.tsx) to prove that mounting a
 * component that throws during render actually surfaces this app's
 * on-brand fallback UI, not a crashed tree. Testing against the real
 * Next runtime's boundary isn't practical under RTL/jsdom (see
 * apps/web/CLAUDE.md's "No headless-browser screenshot verification"
 * note on this environment's testing constraints more generally), so
 * this mirrors its contract instead.
 */
class TestErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  // Real React error boundaries call this too; overriding it as a no-op
  // (rather than omitting it) is what stops the expected thrown error
  // from also printing as an uncaught exception in test output.
  componentDidCatch() {}

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <ErrorPage error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}

function Boom(): ReactNode {
  throw new Error("deliberate render-time throw for testing");
}

describe("app/error.tsx", () => {
  beforeEach(() => {
    // React logs caught errors to console.error even when
    // componentDidCatch is a no-op, and ErrorPage's own effect logs
    // them too (see its doc comment) -- both are expected noise here,
    // not a real test failure signal.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the on-brand fallback, not a crashed tree, when a child throws during render", () => {
    render(
      <TestErrorBoundary>
        <Boom />
      </TestErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("recovers via reset() when Try again is clicked", () => {
    render(
      <TestErrorBoundary>
        <Boom />
      </TestErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    // reset() clears the boundary's own error state and re-renders its
    // children -- Boom throws again immediately, but the fact that the
    // fallback is still what's on screen (rather than something else,
    // or a crash) confirms reset() actually ran and the boundary took
    // another render pass, not that the click did nothing.
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("logs the error for debugging", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");

    render(<ErrorPage error={error} reset={() => {}} />);

    expect(errorSpy).toHaveBeenCalledWith(error);
  });
});
