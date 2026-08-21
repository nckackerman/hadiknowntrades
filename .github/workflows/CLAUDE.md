# .github/workflows — working notes

`ci.yml`: `actions/setup-node`'s `node-version-file` claims `mise.toml`
support but actually mis-parses the `[tools]` table header as the
version string — the workflow extracts the version from `mise.toml`
itself via `grep`/`sed` instead. Don't "simplify" this back to
`node-version-file: mise.toml`, it's broken.
