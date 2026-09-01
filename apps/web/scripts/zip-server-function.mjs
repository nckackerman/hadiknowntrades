#!/usr/bin/env node
// Zips OpenNext's built server-function output
// (`.open-next/server-functions/default`) into
// `default.zip`, preserving symlinks -- run as the last step of
// `build:lambda`/`build:lambda:bypass` (see package.json), consumed by
// `infra/cdk/lib/hadiknowntrades-stack.ts`'s `Code.fromAsset(...)` call.
//
// Why this exists (real, deployed, reproduced bug -- see
// infra/CLAUDE.md's own "OpenNext server-function bundle must be
// zipped..." note for the full story): `Code.fromAsset(directory)`'s
// own zip-creation step DEREFERENCES pnpm's symlinked node_modules
// structure -- confirmed by downloading a real deployed Lambda's code
// package and inspecting it directly. pnpm places a package's own
// direct dependencies as *symlinked siblings* inside its
// `node_modules/.pnpm/<pkg>@<version>/node_modules/` folder (e.g.
// `@swc/helpers` lives there, next to `next` itself, since `next`
// depends on it). `apps/web/node_modules/next` is itself a symlink
// into that folder. When CDK's own zip step dereferences symlinks, it
// replaces `apps/web/node_modules/next` with a *disconnected* real
// copy of just the `next` package -- with no `@swc/helpers` sibling
// anywhere nearby -- so Next's own compiled code, which does
// `require("@swc/helpers/_/_interop_require_default")` from inside
// that copy, can no longer find it. This crashed the deployed Lambda
// at import time with `Cannot find module
// '@swc/helpers/_/_interop_require_default'` (a 502 on every request),
// even though `WebFunction`/its Function URL/every other stack
// resource deployed successfully.
//
// The fix: zip the directory ourselves, with symlinks preserved as
// real zip symlink entries (standard Unix zip encoding, which AWS
// Lambda's own deployment unzip step correctly reconstructs), and
// point `Code.fromAsset` at the resulting *file* instead of the raw
// directory -- `Code.fromAsset` accepts either and uploads a `.zip`
// input as-is, skipping its own (dereferencing) zip step entirely.
// Verified locally: unzipping this script's own output into a fresh
// directory and directly invoking the built handler (`import
// ("./index.mjs")`) resolves `@swc/helpers` correctly, where the
// same check against a plain `cp -r`/CDK-zipped copy fails.
//
// `archiver`'s `ZipArchive` (not the classic `archiver("zip")` factory
// -- this is archiver v8's newer class-based API) is what makes this
// possible: its directory-walk uses `lstat`, not `stat`, so it detects
// symlinks as symlinks (`stats.isSymbolicLink()`) and writes them as
// symlink zip entries instead of following them into their target's
// content -- confirmed by reading `archiver`'s own
// `_updateQueueTaskWithStats` source, not assumed from its docs.

import { createWriteStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..");
const SERVER_FUNCTION_DIR = path.join(WEB_DIR, ".open-next", "server-functions", "default");
const OUTPUT_ZIP = `${SERVER_FUNCTION_DIR}.zip`;

async function main() {
  if (!existsSync(SERVER_FUNCTION_DIR)) {
    throw new Error(
      `${SERVER_FUNCTION_DIR} does not exist -- run \`next build\` and \`open-next build\` first (see build:lambda/build:lambda:bypass).`,
    );
  }

  await new Promise((resolve, reject) => {
    const output = createWriteStream(OUTPUT_ZIP);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => console.warn("[zip-server-function] warning:", err));
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(SERVER_FUNCTION_DIR, false);
    archive.finalize();
  });

  console.log(`[zip-server-function] wrote ${OUTPUT_ZIP}`);
}

main().catch((err) => {
  console.error("[zip-server-function] failed:", err);
  process.exitCode = 1;
});
