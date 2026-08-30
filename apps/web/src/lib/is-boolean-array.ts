// A single source of truth for "is this an untrusted `unknown` value a
// real array of exactly `length` booleans" -- shared by order-storage.ts
// (a day's locked-slot flags) and lineup-storage.ts (a day's
// locked-column flags), both of which read a fixed-length boolean array
// back from localStorage and unconditionally index every slot once the
// rest of the record parses as valid, so an unexpectedly short array
// would silently read `undefined` (falsy) for the missing indices rather
// than fail validation outright.
export function isBooleanArray(value: unknown, length: number): value is boolean[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "boolean")
  );
}
