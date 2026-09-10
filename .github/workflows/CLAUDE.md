# .github/workflows — working notes

`ci.yml`: `actions/setup-node`'s `node-version-file` claims `mise.toml`
support but actually mis-parses the `[tools]` table header as the
version string — the workflow extracts the version from `mise.toml`
itself via `grep`/`sed` instead. Don't "simplify" this back to
`node-version-file: mise.toml`, it's broken.

- **A dedicated "Build web lambda bundle" step (`pnpm --filter web
build:lambda`) runs before Test, separate from the generic `pnpm
build` step.** Required because `infra/cdk`'s stack test does a real
  `Code.fromAsset` read of `apps/web/.open-next/server-functions/
default.zip` (see `infra/CLAUDE.md`'s "web Lambda" note), which only
  `build:lambda`/`build:lambda:bypass` produce — plain `next build`
  (what the generic `build` step actually runs, via `pnpm -r
--if-present build`) doesn't. Without this step, every PR's CI
  fails with `CannotFindAsset` on a fresh checkout (real incident: broke
  main for ~10 days after PR #222, unnoticed because a stale
  `.open-next/` from an earlier manual build made it pass locally on a
  worked-in checkout). Don't fold this back into the generic `build`
  step or remove it as "redundant" — it's covering a gap the generic
  step genuinely doesn't.
