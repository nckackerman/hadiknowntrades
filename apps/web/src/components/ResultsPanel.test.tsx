import type { PrecomputedResult } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ResultsState } from "@/lib/use-results";
import { ResultsPanel } from "./ResultsPanel";

function fixtureResult(overrides: Partial<PrecomputedResult> = {}): PrecomputedResult {
  return {
    schemaVersion: 1,
    range: "1Y",
    generatedAt: "2026-08-21T19:50:21.468Z",
    dataAsOf: "2026-08-21",
    startDate: "2025-08-21",
    endDate: "2026-08-21",
    startingCapital: 20,
    endingBalance: 6876.860256895814,
    trades: [
      {
        ticker: "SNDK",
        buyDate: "2025-08-21",
        buyPrice: 45.5,
        sellDate: "2026-06-25",
        sellPrice: 2335,
      },
      {
        ticker: "MNST",
        buyDate: "2026-07-21",
        buyPrice: 47.22999954223633,
        sellDate: "2026-07-28",
        sellPrice: 97.73999786376953,
      },
      {
        ticker: "MRNA",
        buyDate: "2026-08-06",
        buyPrice: 53.86000061035156,
        sellDate: "2026-08-19",
        sellPrice: 174.3800048828125,
      },
    ],
    universeSize: 503,
    skippedTickers: [],
    ...overrides,
  };
}

describe("ResultsPanel", () => {
  it("shows a loading state while the request is in flight", () => {
    render(<ResultsPanel range="1Y" state={{ status: "loading" }} />);

    expect(screen.getByText(/loading results/i)).toBeInTheDocument();
  });

  it("shows a not-found message for a range that hasn't been published yet", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 404,
      error: "not_found",
      message: 'No precomputed results are available yet for range "1Y".',
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/not published yet/i);
  });

  it("shows a server-misconfigured message for a 500", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 500,
      error: "server_misconfigured",
      message: "Results storage is not configured.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
  });

  it("shows an upstream-error message for a 502 upstream_error", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 502,
      error: "upstream_error",
      message: "Failed to read precomputed results.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load results/i);
  });

  it("shows a corrupted-data message for a 502 corrupt_data", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 502,
      error: "corrupt_data",
      message: "Stored results could not be parsed.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/look corrupted/i);
  });

  it("shows a corrupted-data message for a 502 schema_mismatch", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 502,
      error: "schema_mismatch",
      message: "Stored results are in an unrecognized format.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/look corrupted/i);
  });

  it("shows a network-error message when the fetch itself fails", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 0,
      error: "network_error",
      message: "Failed to fetch",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't reach the server/i);
  });

  it("shows an empty state when a successful response has zero trades", () => {
    const state: ResultsState = {
      status: "success",
      data: fixtureResult({ trades: [], endingBalance: 20 }),
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByText(/no trade would have beaten holding cash/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the hero stat, chart, and trade list for a full success response", () => {
    const state: ResultsState = { status: "success", data: fixtureResult() };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getAllByText("$20.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$6.9K").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    expect(screen.getAllByText(/SNDK/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MNST/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MRNA/).length).toBeGreaterThan(0);
  });

  it("renders fewer than 3 trades gracefully", () => {
    const state: ResultsState = {
      status: "success",
      data: fixtureResult({
        trades: [
          {
            ticker: "AAPL",
            buyDate: "2025-08-21",
            buyPrice: 100,
            sellDate: "2025-09-01",
            sellPrice: 110,
          },
        ],
        endingBalance: 22,
      }),
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getAllByText(/AAPL/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no trade would have beaten/i)).not.toBeInTheDocument();
  });
});
