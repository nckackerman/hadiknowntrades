import { Suspense } from "react";

import { ResultsPage } from "@/components/ResultsPage";

// ResultsPage reads the selected range from the URL via useSearchParams,
// which requires a Suspense boundary around it -- see
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md's
// "Prerendering" section: without one, the whole client tree above it
// bails out of prerendering, not just this part of it.
export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center bg-[var(--background)]">
      <Suspense fallback={null}>
        <ResultsPage />
      </Suspense>
    </div>
  );
}
