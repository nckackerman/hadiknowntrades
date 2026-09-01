// OpenNext build config for AWS Lambda deployment (issue #6's real web
// Lambda, replacing infra/cdk/lambda/web-placeholder). This app has
// exactly one ISR route -- /api/og/[range]'s `revalidate: 86400` -- and
// calls neither `revalidateTag` nor `revalidatePath` anywhere (confirmed
// via a repo-wide grep before writing this config), so there's no
// on-demand revalidation to justify OpenNext's default DynamoDB tag-cache
// table or SQS revalidation queue. `tagCache: "dummy"` and
// `queue: "direct"` are OpenNext's own documented overrides for exactly
// this shape: time-based-only ISR, backed by S3 alone (the default
// `incrementalCache`, left unset here on purpose). Smaller IAM surface,
// fewer AWS resources -- see infra/CLAUDE.md's own "Current deployment
// state" section for the CDK side of this.
import type { OpenNextConfig } from "@opennextjs/aws/types/open-next.js";

const config = {
  default: {
    override: {
      tagCache: "dummy",
      queue: "direct",
    },
  },
} satisfies OpenNextConfig;

export default config;
