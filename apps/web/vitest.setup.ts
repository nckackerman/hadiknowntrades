import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "@testing-library/jest-dom/vitest";

// Testing Library's auto-cleanup-after-each-test only wires itself up
// automatically when it detects the test runner's globals (Jest, or
// Vitest with `test.globals: true`) -- this project imports
// describe/it/expect explicitly instead, so cleanup is registered by
// hand here. Without it, every component test after the first in a
// file renders on top of the previous test's leftover DOM.
afterEach(() => {
  cleanup();
});
