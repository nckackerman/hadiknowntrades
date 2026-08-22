"use client"; // Error boundaries must be Client Components (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md)

import { useEffect } from "react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Render-crash error boundary for everything under layout.tsx (issue
 * #46). `useResults`' loading/error/success state machine (see
 * use-results.ts, rendered via ResultsPanel.tsx) only ever sees *fetch*
 * failures -- a throw during render itself (a bad data shape slipping
 * past a type, a future regression like the past niceLogTicks bug, see
 * chart-scales.ts's own note, a null-deref in the intraday branch) was
 * previously uncaught by anything this app owns and fell through to
 * Next's default unstyled overlay. This file is the App Router
 * convention for catching that (a React error boundary Next wraps
 * around page.tsx et al.), not a component this app renders directly.
 *
 * Styled to match ResultsPanel's own fetch-error card (same
 * role="alert" pattern and visual language) so a crash still reads as
 * on-brand rather than broken. Deliberately doesn't surface
 * `error.message` in the UI -- same reasoning as ResultsPanel's
 * `errorCopy`, which never echoes raw fetch-error text back either, and
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
