"use client"; // Error boundaries must be Client Components (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md)

import { useEffect } from "react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Render-crash error boundary for page.tsx and everything else nested
 * under layout.tsx (issue #46) -- but not layout.tsx itself. Per Next's
 * own error.js convention
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md),
 * a segment's error.tsx wraps that segment's page.js/loading.js/nested
 * layout.js, but does **not** wrap the layout.js (or template.js) in its
 * own segment -- so a throw inside RootLayout itself (its font loading,
 * its <html>/<body> JSX) would still fall through to Next's default
 * unstyled overlay with nothing here to catch it. `global-error.tsx`
 * (sibling file, same directory) is the dedicated convention for that
 * remaining gap: between the two files, every segment has a catching
 * boundary -- this one for the tree under the root layout, that one for
 * the root layout itself.
 *
 * `useResults`' loading/error/success state machine (see use-results.ts,
 * rendered via ResultsPanel.tsx) only ever sees *fetch* failures -- a
 * throw during render itself (a bad data shape slipping past a type, a
 * future regression like the past niceLogTicks bug, see
 * chart-scales.ts's own note, a null-deref in the intraday branch) was
 * previously uncaught by anything this app owns and fell through to
 * Next's default unstyled overlay. This file is the App Router
 * convention for catching that (a React error boundary Next wraps
 * around page.tsx et al.), not a component this app renders directly.
 *
 * Styled to match ResultsPanel's own fetch-error card (same
 * role="alert" pattern and visual language) so a crash still reads as
 * on-brand rather than broken. Deliberately never surfaces
 * `error.message` in the UI, unlike ResultsPanel's `errorCopy`: two of
 * its six cases (`invalid_range` and its `default` fallback) *do* return
 * the API's own message text verbatim as `body`, since that text is a
 * fixed, app-authored string from this app's own API route (see
 * results-api.ts / use-results.ts), not an arbitrary caught exception's
 * message. A render-time throw has no such guarantee on its content, and
 * per this file's own doc comment above, Server Component errors arrive
 * here with a generic message anyway (the real detail is server-side,
 * keyed by `error.digest`).
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // No error reporting service wired up yet -- console is the only sink.
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center bg-[var(--background)]">
      <div className="flex w-full max-w-3xl flex-col gap-8 px-6 py-16 sm:px-8">
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/5 px-5 py-4"
        >
          <p className="font-semibold text-[var(--status-critical)]">Something went wrong</p>
          <p className="text-sm text-[var(--text-secondary)]">
            This page hit an unexpected error while rendering. This is a bug on our end, not
            something you did.
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-2 rounded-full bg-[var(--series-1)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
