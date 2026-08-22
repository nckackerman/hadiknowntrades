import { useState } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StartingCapitalInput } from "./StartingCapitalInput";

/** A real controlled wrapper, not a static `value`/`vi.fn()` pairing --
 * needed to reproduce the mid-keystroke resync bug below, since that bug
 * only shows up once `onChange`'s payload actually round-trips back into
 * the `value` prop the way ResultsPage's real useStartingCapital-backed
 * usage does. */
function ControlledStartingCapitalInput({ initialValue }: { initialValue: number }) {
  const [value, setValue] = useState(initialValue);
  return <StartingCapitalInput value={value} onChange={setValue} />;
}

describe("StartingCapitalInput", () => {
  it("renders the committed value", () => {
    render(<StartingCapitalInput value={20} onChange={vi.fn()} />);

    expect(screen.getByRole("spinbutton")).toHaveValue(20);
  });

  it("calls onChange with the parsed number as the user types a valid value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StartingCapitalInput value={20} onChange={onChange} />);

    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "500");

    expect(onChange).toHaveBeenLastCalledWith(500);
  });

  it("does not call onChange while the field is cleared/mid-edit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StartingCapitalInput value={20} onChange={onChange} />);

    await user.clear(screen.getByRole("spinbutton"));

    expect(onChange).not.toHaveBeenCalled();
    // The draft stays visibly blank, not snapped back to "20" mid-edit.
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });

  it("reverts the visible text to the last committed value on blur if left invalid", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StartingCapitalInput value={20} onChange={onChange} />);

    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.tab(); // blur

    expect(input).toHaveValue(20);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps a parsed value that exceeds the allowed range before committing it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StartingCapitalInput value={20} onChange={onChange} />);

    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "9999999999999");

    expect(onChange).toHaveBeenLastCalledWith(1_000_000_000);
  });

  it("updates the visible text when `value` changes from outside (not from this input's own onChange) -- regression test for a real bug caught in live verification, not the unit tests: use-starting-capital.ts's post-mount localStorage-hydration correction changes `value` without this component ever calling its own onChange, and the field kept showing its stale initial text forever without this", () => {
    const { rerender } = render(<StartingCapitalInput value={20} onChange={vi.fn()} />);

    rerender(<StartingCapitalInput value={5000} onChange={vi.fn()} />);

    expect(screen.getByRole("spinbutton")).toHaveValue(5000);
  });

  it('does not clobber the user\'s own typed text mid-edit when a keystroke\'s round-tripped onChange changes the parsed value -- regression test for a real bug found in code review: typing "020" got silently snapped to "20" mid-keystroke (stripping the leading zero just typed) because the component couldn\'t distinguish an external correction from the round-trip of its own just-fired onChange', () => {
    // Driven by fireEvent.change per keystroke, not userEvent.type -- the
    // latter has its own well-documented quirks simulating text entry
    // into `<input type="number">` in jsdom (it computes each keystroke
    // against its own tracked caret/selection state rather than purely
    // dispatching the raw `input`/`change` events a real keypress would),
    // which papers over the exact bug this test exists to catch. A plain
    // fireEvent.change per character is what actually reproduces "the
    // user typed X, so the DOM's change event fires with the field's new
    // full text."
    render(<ControlledStartingCapitalInput initialValue={20} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "0" } }); // parses to null (0 <= 0) -- no commit yet
    fireEvent.change(input, { target: { value: "02" } }); // parses to 2 -- commits onChange(2), round-trips `value` back to 2
    fireEvent.change(input, { target: { value: "020" } }); // parses to 20 -- commits onChange(20), round-trips `value` back to 20

    // Not "20" -- the leading zero the user actually typed must still be
    // visible, even though each of the last two keystrokes round-tripped
    // a freshly-committed `value` back into this component along the way.
    expect(input.value).toBe("020");
  });

  it("still resyncs an external value change that happens to arrive between a user's own keystrokes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<StartingCapitalInput value={20} onChange={onChange} />);
    const input = screen.getByRole("spinbutton");

    await user.clear(input);
    await user.type(input, "5"); // commits onChange(5), draft becomes "5"
    expect(onChange).toHaveBeenLastCalledWith(5);

    // An external reset to a *different* value than what this input just
    // emitted (e.g. a "reset to default" action elsewhere on the page) --
    // must still resync the visible draft, unlike the self-round-trip
    // case above.
    rerender(<StartingCapitalInput value={100} onChange={onChange} />);

    expect(input).toHaveValue(100);
  });
});
