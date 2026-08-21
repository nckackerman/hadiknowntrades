// PLACEHOLDER web-hosting Lambda. apps/web (issues #7/#8) is still just
// the default Next.js starter scaffold -- there's no real OpenNext
// build output (`.open-next/server-functions/default`) to deploy yet.
// This stub stands in for that server function so the rest of the
// architecture (CloudFront -> Lambda Function URL, IAM, static-asset
// bucket + behavior) can be built and tested end to end now.
//
// To swap in the real thing once apps/web has actual routes:
//   1. Add OpenNext build config to apps/web (`open-next.config.ts`)
//      and a build step that runs `next build && open-next build`,
//      producing `.open-next/server-functions/default` and
//      `.open-next/assets`.
//   2. In lib/hadiknowntrades-stack.ts, point the web Lambda's
//      `entry`/`code` at that build output instead of this file, and
//      sync `.open-next/assets` into webAssetsBucket (e.g. via a
//      `BucketDeployment` or a CI step).
// See the PR description for issue #6 for the full note.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const BODY = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Had I Known Trades</title>
  </head>
  <body>
    <h1>Had I Known Trades</h1>
    <p>Infrastructure is up. The web app itself is not deployed yet.</p>
  </body>
</html>
`;

export const handler = (_event: APIGatewayProxyEventV2): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: BODY,
});
