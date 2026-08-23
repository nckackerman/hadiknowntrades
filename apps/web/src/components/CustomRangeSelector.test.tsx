import { RESULTS_SCHEMA_VERSION, type CustomAnchorsManifest } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ResultsState } from "@/lib/use-results";

import { CustomRangeSelector } from "./CustomRangeSelector";

// A fixed, small manifest -- three real days within the same month
// (2024-01) plus one in an adjacent month, so both "same-month" and
// "requires navigation" cases are covered without a huge fixture.
const TEST_ANCHORS = ["2023-12-28", "2024-01-05", "2024-01-10", "2024-01-20"];

// issue #75 code review finding: CustomRangeSelector no longer fetches
// its own anchors manifest (that's lifted up to ResultsPage.tsx, fetched
// once and shared across both mounted instances -- see
// ResultsPage.tsx's own doc comment) -- it's a plain prop now, so these
// tests build the state directly instead of mocking `fetch`.
const LOADING_STATE: ResultsState<CustomAnchorsManifest> = { status: "loading" };
const ERROR_STATE: ResultsState<CustomAnchorsManifest> = {
  status: "error",
  httpStatus: 502,
  error: "upstream_error",
  message: "Failed to read precomputed results.",
};

function successState(anchors: string[] = TEST_ANCHORS): ResultsState<CustomAnchorsManifest> {
  return { status: "success", data: { schemaVersion: RESULTS_SCHEMA_VERSION, anchors } };
}

function openCalendar(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByTestId("custom-range-trigger"));
}

describe("CustomRangeSelector (day-granularity calendar picker, issue #75)", () => {
  describe("loading state", () => {
    it("renders a disabled trigger while the anchors manifest is loading", () => {
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={LOADING_STATE} />,
      );

      expect(screen.getByRole("button", { name: "Loading start dates…" })).toBeDisabled();
    });

    it("also renders the loading trigger when anchorsState is null (not yet mounted/fetched)", () => {
      render(<CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={null} />);

      expect(screen.getByRole("button", { name: "Loading start dates…" })).toBeDisabled();
    });
  });

  describe("error state", () => {
    it("renders an inline unavailable message, no trigger at all, on a fetch error", () => {
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={ERROR_STATE} />,
      );

      expect(screen.getByText("Start-date picker unavailable")).toBeInTheDocument();
      expect(screen.queryByTestId("custom-range-trigger")).not.toBeInTheDocument();
    });
  });

  describe("loaded, no selection", () => {
    it('shows "Choose a start date…" on the trigger', () => {
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState()} />,
      );

      expect(screen.getByTestId("custom-range-trigger")).toHaveTextContent("Choose a start date…");
    });

    it("defaults the calendar view to the newest published anchor's month", async () => {
      const user = userEvent.setup();
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState()} />,
      );

      await openCalendar(user);

      expect(screen.getByText("January 2024")).toBeInTheDocument();
    });

    it("renders every real anchor day as enabled, and every other day in the month as disabled", async () => {
      const user = userEvent.setup();
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState()} />,
      );

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
      const { container } = render(
        <CustomRangeSelector selected={null} onSelect={onSelect} anchorsState={successState()} />,
      );

      await openCalendar(user);
      await user.click(screen.getByRole("button", { name: "10" }));

      expect(onSelect).toHaveBeenCalledWith("2024-01-10");
      expect(container.querySelector("details")).not.toHaveAttribute("open");
    });

    it("clicking a disabled (non-anchor) day does nothing", async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(
        <CustomRangeSelector selected={null} onSelect={onSelect} anchorsState={successState()} />,
      );

      await openCalendar(user);
      await user.click(screen.getByRole("button", { name: "15" }));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("navigates to the previous/next month via the nav buttons", async () => {
      const user = userEvent.setup();
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState()} />,
      );

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
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState()} />,
      );

      await openCalendar(user);
      expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Previous month" }));
      expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
    });

    it("resets a navigated-away month once the popover is closed without a selection (code review finding)", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState()} />,
      );

      await openCalendar(user);
      await user.click(screen.getByRole("button", { name: "Previous month" }));
      expect(screen.getByText("December 2023")).toBeInTheDocument();

      // Close without selecting a day -- click the trigger again (a
      // native <details>/<summary> toggle), the same effect a real
      // click-away or Escape would have.
      await user.click(screen.getByTestId("custom-range-trigger"));
      expect(container.querySelector("details")).not.toHaveAttribute("open");

      // Reopen: the calendar should be back to its natural default
      // (the newest anchor's month), not stuck on the previously
      // navigated-away month.
      await user.click(screen.getByTestId("custom-range-trigger"));
      expect(screen.getByText("January 2024")).toBeInTheDocument();
    });
  });

  describe("loaded, with a selection", () => {
    it("formats the selected anchor as a full date on the trigger", () => {
      render(
        <CustomRangeSelector
          selected="2024-01-10"
          onSelect={() => {}}
          anchorsState={successState()}
        />,
      );

      expect(screen.getByTestId("custom-range-trigger")).toHaveTextContent("Jan 10, 2024");
    });

    it("defaults the calendar view to the selected anchor's own month, not the newest anchor's", async () => {
      const user = userEvent.setup();
      render(
        <CustomRangeSelector
          selected="2023-12-28"
          onSelect={() => {}}
          anchorsState={successState()}
        />,
      );

      await openCalendar(user);

      expect(screen.getByText("December 2023")).toBeInTheDocument();
    });

    it("marks the selected day with aria-current", async () => {
      const user = userEvent.setup();
      render(
        <CustomRangeSelector
          selected="2024-01-10"
          onSelect={() => {}}
          anchorsState={successState()}
        />,
      );

      await openCalendar(user);

      expect(screen.getByRole("button", { name: "10" })).toHaveAttribute("aria-current", "date");
    });
  });

  describe("empty manifest (defensive, not expected in practice)", () => {
    it("falls back to the real current month when there are no published anchors", async () => {
      const user = userEvent.setup();
      render(
        <CustomRangeSelector selected={null} onSelect={() => {}} anchorsState={successState([])} />,
      );

      await openCalendar(user);

      const now = new Date();
      const expectedMonth = now.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
      });
      expect(screen.getByText(expectedMonth)).toBeInTheDocument();
    });
  });
});
