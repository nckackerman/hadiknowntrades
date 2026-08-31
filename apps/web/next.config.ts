import type { NextConfig } from "next";

// Set only for the temporary CloudFront-bypass build
// (`pnpm run build:lambda:bypass`, see package.json) -- see
// infra/cdk/lib/hadiknowntrades-stack.ts's own `bypassCloudFront` doc
// comment for the full "why" (AWS's CloudFront account-verification
// block, and the workaround). `assetPrefix` has to be baked in at
// `next build` time, before the deployed bucket even exists, so this is
// a fixed value rather than something read from a live stack output --
// it must match that same file's own `WEB_ASSETS_PUBLIC_BUCKET_NAME`
// constant exactly, and the region matches `infra/CLAUDE.md`'s
// documented deployment region. Left `undefined` for every other build
// (the normal, CloudFront-fronted case, and plain `next dev`/`next
// build`/`next start`), which is the same as omitting `assetPrefix`
// entirely -- static assets resolve relative to whatever host actually
// served the page, which is exactly right once CloudFront's own
// path-based `/_next/static/*` routing is what's serving them.
const WEB_ASSETS_PUBLIC_BUCKET_URL =
  "https://hadiknowntrades-web-assets-public.s3.us-west-2.amazonaws.com";

const nextConfig: NextConfig = {
  assetPrefix:
    process.env.OPENNEXT_BYPASS_CLOUDFRONT === "true" ? WEB_ASSETS_PUBLIC_BUCKET_URL : undefined,
};

export default nextConfig;
