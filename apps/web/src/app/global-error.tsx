"use client"; // Error boundaries must be Client Components (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md)

import { useEffect } from "react";

interface GlobalErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Root-layout crash boundary (issue #46 follow-up). `error.tsx` catches
 * render-time throws in page.tsx and everything else nested under
 * layout.tsx, but per Next's own file-convention docs it does **not**
 * wrap layout.tsx (or template.tsx) in its own segment -- so a throw
 * inside RootLayout itself (its `next/font/google` calls, its
 * `<html>`/`<body>` JSX in layout.tsx) would still fall through to
 * Next's default unstyled overlay with nothing here to catch it.
 * `global-error.tsx` is the dedicated convention for exactly that
 * remaining gap: it wraps and replaces the root layout when it fires,
 * which per Next's docs is why it must render its own `<html>`/`<body>`
 * rather than relying on layout.tsx's (this file *is* the document when
 * it's rendering).
 *
 * Deliberately does NOT import "./globals.css" or rely on layout.tsx's
 * `next/font` setup -- if the root layout itself is what crashed, the
 * failure could be in its font loading or its module graph, and this
 * file's whole job is to still render something legible when that's
 * true. Per Next's own docs ("global-error and the built-in 500 page
 * render their own document and do not include your global styles"),
 * styling here is a small self-contained inline style prop instead
 * of the app's normal Tailwind/CSS-custom-property pipeline -- the
 * color values below are copied from globals.css's
 * --status-critical/--background/etc. tokens rather than referencing
 * them, since those custom properties live on a :root this document
 * doesn't share. Dark is this app's only theme (issue #76) -- these are
 * globals.css's dark values directly, unconditional, no
 * prefers-color-scheme swap.
 *
 * Same visual language and copy as error.tsx (role="alert" card, same
 * heading/body text, same reset()-not-retry() reasoning -- see that
 * file's own doc comment) so a root-layout crash still reads as
 * on-brand rather than broken, even though the two files can't actually
 * share markup (different host document, no Tailwind classes available
 * here).
 */
export default function GlobalError({ error, reset }: GlobalErrorPageProps) {
  useEffect(() => {
    // No error reporting service wired up yet -- console is the only sink.
    console.error(error);
  }, [error]);

  return (
    // colorScheme: "dark" (mirroring globals.css's own `color-scheme: dark`,
    // see its doc comment) keeps this standalone document's own native
    // UA chrome -- scrollbars, any future native control -- dark too,
    // not just the custom-painted card below.
    <html lang="en" style={{ colorScheme: "dark" }}>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: "#0a0a0a",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "48rem",
            display: "flex",
            flexDirection: "column",
            gap: "2rem",
            padding: "4rem 1.5rem",
            boxSizing: "border-box",
          }}
        >
          <div
            role="alert"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "0.5rem",
              borderRadius: "0.5rem",
              border: "1px solid rgba(230, 103, 103, 0.3)",
              background: "rgba(230, 103, 103, 0.05)",
              padding: "1rem 1.25rem",
            }}
          >
            <p style={{ margin: 0, fontWeight: 600, color: "#e66767" }}>Something went wrong</p>
            <p style={{ margin: 0, fontSize: "0.875rem", color: "#c3c2b7" }}>
              This page hit an unexpected error while rendering. This is a bug on our end, not
              something you did.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: "0.5rem",
                borderRadius: "9999px",
                border: "none",
                background: "#3987e5",
                padding: "0.375rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                color: "#ffffff",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
