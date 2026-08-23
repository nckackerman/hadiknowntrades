import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomRangeSelector } from "./CustomRangeSelector";

// A fixed, small manifest -- three real days within the same month
// (2024-01) plus one in an adjacent month, so both "same-month" and
// "requires navigation" cases are covered without a huge fixture.
const TEST_ANCHORS = ["2023-12-28", "2024-01-05", "2024-01-10", "2024-01-20"];

function mockAnchorsFetch(anchors: string[] = TEST_ANCHORS) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ schemaVersion: RESULTS_SCHEMA_VERSION, anchors }), {
        status: 200,
      }),
    ),
  );
}

async function openCalendar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("custom-range-trigger"));
}

describe("CustomRangeSelector (day-granularity calendar picker, issue #75)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loading state", () => {
    it("renders a disabled trigger while the anchors manifest is loading", () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      ); // never resolves
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      expect(screen.getByRole("button", { name: "Loading start dates…" })).toBeDisabled();
    });
  });

  describe("error state", () => {
    it("renders an inline unavailable message, no trigger at all, on a fetch error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      expect(await screen.findByText("Start-date picker unavailable")).toBeInTheDocument();
      expect(screen.queryByTestId("custom-range-trigger")).not.toBeInTheDocument();
    });
  });

  describe("loaded, no selection", () => {
    beforeEach(() => mockAnchorsFetch());

    it('shows "Choose a start date…" on the trigger', async () => {
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      expect(await screen.findByTestId("custom-range-trigger")).toHaveTextContent(
        "Choose a start date…",
      );
    });

    it("defaults the calendar view to the newest published anchor's month", async () => {
      const user = userEvent.setup();
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      await openCalendar(user);

      expect(screen.getByText("January 2024")).toBeInTheDocument();
    });

    it("renders every real anchor day as enabled, and every other day in the month as disabled", async () => {
      const user = userEvent.setup();
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      await openCalendar(user);

      expect(screen.getByRole("button", { name: "5" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "10" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "20" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "6" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "15" })).toBeDisabled();
    });

    it("calls onSelect with the clicked real anchor day and closes the popover", async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      const { container } = render(<CustomRangeSelector selected={null} onSelect={onSelect} />);

      await openCalendar(user);
      await user.click(screen.getByRole("button", { name: "10" }));

      expect(onSelect).toHaveBeenCalledWith("2024-01-10");
      expect(container.querySelector("details")).not.toHaveAttribute("open");
    });

    it("clicking a disabled (non-anchor) day does nothing", async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<CustomRangeSelector selected={null} onSelect={onSelect} />);

      await openCalendar(user);
      await user.click(screen.getByRole("button", { name: "15" }));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("navigates to the previous/next month via the nav buttons", async () => {
      const user = userEvent.setup();
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      await openCalendar(user);
      expect(screen.getByText("January 2024")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Previous month" }));
      expect(screen.getByText("December 2023")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "28" })).not.toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Next month" }));
      expect(screen.getByText("January 2024")).toBeInTheDocument();
    });

    it("disables the previous-month button at the oldest anchor's month, and the next-month button at the newest's", async () => {
      const user = userEvent.setup();
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      await openCalendar(user);
      expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Previous month" }));
      expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
    });
  });

  describe("loaded, with a selection", () => {
    beforeEach(() => mockAnchorsFetch());

    it("formats the selected anchor as a full date on the trigger", async () => {
      render(<CustomRangeSelector selected="2024-01-10" onSelect={() => {}} />);

      expect(await screen.findByTestId("custom-range-trigger")).toHaveTextContent(
        "January 10, 2024",
      );
    });

    it("defaults the calendar view to the selected anchor's own month, not the newest anchor's", async () => {
      const user = userEvent.setup();
      render(<CustomRangeSelector selected="2023-12-28" onSelect={() => {}} />);

      await openCalendar(user);

      expect(screen.getByText("December 2023")).toBeInTheDocument();
    });

    it("marks the selected day with aria-current", async () => {
      const user = userEvent.setup();
      render(<CustomRangeSelector selected="2024-01-10" onSelect={() => {}} />);

      await openCalendar(user);

      expect(screen.getByRole("button", { name: "10" })).toHaveAttribute("aria-current", "date");
    });
  });

  describe("empty manifest (defensive, not expected in practice)", () => {
    it("falls back to the real current month when there are no published anchors", async () => {
      mockAnchorsFetch([]);
      const user = userEvent.setup();
      render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

      await openCalendar(user);

      const now = new Date();
      const expectedMonth = now.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
      });
      await waitFor(() => expect(screen.getByText(expectedMonth)).toBeInTheDocument());
    });
  });
});
