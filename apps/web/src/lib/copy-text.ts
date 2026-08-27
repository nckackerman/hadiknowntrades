// One defensive clipboard write (issue #133), in the same spirit as
// local-storage.ts's defensive read/write: the async Clipboard API is not
// something a page can assume it has.
//
// It is genuinely absent or refused in real, ordinary situations, not just
// exotic ones -- any non-secure context (plain http, which includes some
// LAN/dev setups), a browser whose clipboard permission the user denied, an
// embedded webview, and an SSR pass where there is no `navigator` at all.
// A recap that silently did nothing in those cases would look broken, so
// this reports failure honestly and the caller (DailyRitual.tsx) falls back
// to a select-it-yourself textarea rather than pretending the copy worked.

/**
 * Writes `text` to the system clipboard. Resolves `true` when the write
 * actually happened, `false` when the API is unavailable or the write was
 * refused -- never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  // Read through an optional chain rather than `"clipboard" in navigator`:
  // the property exists but is `undefined` in non-secure contexts in some
  // browsers, and `writeText` itself can be missing on older ones.
  const write = navigator.clipboard?.writeText;
  if (typeof write !== "function") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
