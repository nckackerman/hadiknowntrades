# infra — working notes

`bootstrap/` is one-time sandbox AWS/IAM setup (docs + policies), not the
CDK app. `cdk/` is the actual AWS infrastructure as code (issue #6, built
but **never actually deployed** — see below). Read this before
re-investigating something below — if a fact here turns out to be stale,
fix the fact here too, not just the code.

- **Never deploy or touch real AWS resources without the user's explicit
  go-ahead**, independent of anything else in this file — that agreement
  predates and overrides any process shortcut described here.
- Sandbox IAM already set up per `bootstrap/SETUP.md`: three policies
  (deny-list on expensive/always-on services, scoped IAM for
  CDK-created roles, a lockdown policy) attached to IAM user
  `hadiknowntrades-agent`, region **us-west-2**.
- **A budget circuit breaker was deliberately deferred** by the user's
  own choice — there is currently no automatic spend cap beyond the
  IAM deny-list. Worth raising again before any real `cdk deploy`.
- If a custom domain + HTTPS ever gets added to CloudFront: the ACM
  certificate for that specifically must be requested in **us-east-1**
  regardless of the region everything else lives in — a CloudFront/ACM
  quirk, not a reason to move the whole app.

## `cdk/` (issue #6)

Single stack, `HadIKnownTradesStack` (`cdk/lib/hadiknowntrades-stack.ts`):
two private S3 buckets (results + web static assets, both OAC-only via
CloudFront, `RemovalPolicy.DESTROY` + auto-delete since this is a
sandbox project regenerating its data nightly), a CloudFront
distribution (Lambda Function URL default origin via OAC, S3 origin for
`/_next/static/*`), the pipeline Lambda + a nightly EventBridge rule
targeting it, and a placeholder web-hosting Lambda.

- **Never actually deployed against real AWS** — `cdk synth` and the
  `aws-cdk-lib/assertions` unit tests (`cdk/test/`) are the only things
  that have run. Don't assume any of this has been exercised for real.
- `bin/app.ts` is deliberately account-agnostic and pins `region:
"us-west-2"` as a literal (not a live lookup) so `cdk synth` works
  fully offline, with no AWS credentials — this is required, not
  incidental; don't add context lookups (`Vpc.fromLookup`, AMI lookups,
  etc) or live `Stack.account` resolution.
- Both Lambdas are `NodejsFunction` (esbuild, bundled locally at synth
  time, no Docker) — the pipeline one bundles apps/pipeline's real
  `src/lambda-handler.ts` directly (cross-package `entry:` path into
  `apps/pipeline/src`), not a copy. `esbuild` needs to be resolvable
  from the repo root (pnpm's `require.resolve` walk for `NodejsFunction`
  bundling lands there via `depsLockFilePath` pointing at the root
  `pnpm-lock.yaml`) — it's a devDependency of **both** the root
  `package.json` and `infra/cdk/package.json` for that reason; don't
  remove either without re-verifying `cdk synth` still bundles locally
  instead of falling back to (unavailable) Docker.
- **Every IAM role the stack creates has an explicit `hadiknowntrades-*`
  name** - required, not cosmetic. The sandbox account's deploying user
  has no general IAM access (`hadiknowntrades-scoped-iam` only permits
  `iam:CreateRole`/etc for role names matching `hadiknowntrades-*` or
  `cdk-*`); CDK's own default auto-generated role names match neither
  prefix and would fail with AccessDenied on the first real deploy. Both
  Lambda execution roles are explicit `Role` constructs with a
  `roleName` set. The one role this stack doesn't create directly - the
  shared execution role for S3's `autoDeleteObjects: true` custom
  resource - is patched by a stack-level `Aspects.of(this).add(...)`
  (`ScopedIamRoleNames` in the stack file) since `aws-cdk-lib/aws-s3`
  exposes no prop to name it, and it's built internally as a raw L1
  `CfnResource` escape hatch rather than the typed `CfnRole` class (so
  an `instanceof CfnRole` check alone misses it - verified by
  synthesizing and inspecting the template's `AWS::IAM::Role`
  resources directly, not assumed). If a `cdk synth`/`assertions` test
  ever needs to find a role by logical ID, note the pipeline Lambda's
  role construct id is `PipelineFunctionRole` (its own explicit `Role`),
  not CDK's default `PipelineFunctionServiceRole` naming for an unnamed
  one.
- **The web Lambda is a placeholder** (`cdk/lambda/web-placeholder/`),
  not a real OpenNext build — apps/web (issues #7/#8) is still just the
  default Next.js starter scaffold, there's no `.open-next` build
  output to deploy yet. See that file's header comment for exactly what
  needs to change (add `open-next.config.ts` + a build step to
  apps/web, then point the stack's `entry`/`code` at the real build
  output and sync `.open-next/assets` into `webAssetsBucket`) once
  apps/web has actual routes.
- Env var contract the pipeline Lambda expects: `RESULTS_BUCKET` (set
  by the stack from the actual `resultsBucket.bucketName` token — no
  hardcoded bucket name anywhere). Bucket names themselves are
  CDK-auto-generated, not fixed strings — issue #7's thin API (built
  concurrently on a different branch) needs to read the real bucket
  name from stack outputs/SSM/env, not assume a literal.
- Nightly schedule is `cron(0 6 * * ? *)` (06:00 UTC) — a placeholder
  guess at "safely after EOD data settles", not tuned against any real
  Yahoo data-availability SLA. Revisit once the pipeline has actually
  run on a schedule.
