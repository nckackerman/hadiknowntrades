# infra — working notes

`bootstrap/` is one-time sandbox AWS/IAM setup (docs + policies), not the
CDK app. `cdk/` is the actual AWS infrastructure as code (issue #6, deployed
2026-08-21 -- see "Current deployment state" below for what's actually live).
Read this before re-investigating something below - if a fact here turns out
to be stale, fix the fact here too, not just the code.

- **Never deploy or touch real AWS resources without the user's explicit
  go-ahead**, independent of anything else in this file — that agreement
  predates and overrides any process shortcut described here.
- Sandbox IAM already set up per `bootstrap/SETUP.md`: three policies
  (deny-list on expensive/always-on services, scoped IAM for
  CDK-created roles, a lockdown policy) attached to IAM user
  `hadiknowntrades-agent`, region **us-west-2**.
- **The full automatic budget circuit breaker (SETUP.md step 3) is still
  not set up.** As of 2026-08-21 the user created a $20/month AWS Budget
  _alert_ only (email notification) -- not the Budget Action that
  auto-attaches the `hadiknowntrades-lockdown` policy. This was a
  deliberate, informed choice ("that's enough for me ATM"), not an
  oversight -- don't silently "fix" it by wiring up the full lockdown
  without asking first. Still true either way: no automatic spend cap
  beyond the IAM deny-list once the alert threshold is crossed.
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

## Current deployment state (2026-08-21)

`cdk bootstrap`'d and `cdk deploy`'d for real, in account `245271560881`,
region `us-west-2`. 19 of 20 resources are CREATE_COMPLETE; only the
CloudFront `Distribution` is CREATE_FAILED, so the overall stack status
reads `UPDATE_FAILED` -- that's expected, not alarming, don't assume the
whole stack is broken from that status alone. See the facts below for why,
and how to actually get anything deployed here at all.

- **CloudFront is blocked by AWS's own account verification, not a bug
  here.** New/low-usage AWS accounts get a hard `AccessDenied` on
  `AWS::CloudFront::Distribution` creation ("Your account must be
  verified before you can add new CloudFront resources") until AWS
  Support manually clears it -- a real, well-documented anti-fraud gate
  (see e.g. https://repost.aws/questions/QUwuoclRJlQ7Gw5qjrlTAi4w), not
  anything wrong with this stack's CDK code. Fix is an AWS Support case
  (Account and billing -> Service limit increase -> CloudFront
  Distributions), filed by the user in the Console -- nothing to
  troubleshoot in code. Typical turnaround is same-day to a couple of
  days, not instant. Once cleared, a plain `cdk deploy` (no special
  flags) picks up just the missing Distribution; everything else is
  already live.
- **Deploying `cdk deploy`/`cdk bootstrap` from Claude Code's own Bash
  tool doesn't work non-interactively.** CDK's own security-sensitive-
  changes prompt ("Do you wish to deploy these changes (y/n)?") can't be
  answered without a real TTY, which a Bash tool call doesn't have --
  it aborts safely rather than assuming yes. `--require-approval never`
  looks like the fix but gets blocked by the harness's own auto-mode
  safety classifier as an outward-facing, hard-to-reverse action. The
  actual working pattern: the user runs the `cdk bootstrap`/`cdk deploy`
  command themselves, in their own real terminal (e.g. a tmux pane, or
  via the `!` shell-passthrough prefix so output lands in the chat) --
  Claude Code can watch a tmux pane for completion
  (`tmux display-message -p -t <session>:<window>.<pane> -F
'#{pane_current_command}'` to poll a _specific_ pane; plain
  `list-panes -t <session>:<window>.<pane>` resolves to the whole
  _window_ and returns every pane in it, a real gotcha that silently
  breaks a same-pane-only poll loop) but can't run the deploy directly.
- **`--no-rollback` is the practical way to get partial infra live when
  one resource is externally blocked** (like CloudFront here) instead
  of it every time tearing down everything that _did_ succeed. Without
  it, a single resource failure rolls the whole stack back to nothing
  on every attempt -- with it, only the failed resource(s) stay
  unresolved and a later retry only needs to create what's still
  missing.
- **`NodejsFunction` creates an explicit, fixed-name `AWS::Logs::LogGroup`
  resource per Lambda** (not just relying on Lambda's own implicit
  first-invocation log group). If a rollback ever leaves one of these
  orphaned (observed once, from the very first deploy attempt before
  CloudFront's block was understood: the log group survived the
  rollback that tore down everything else), the next deploy attempt
  fails with "already exists" on that specific `AWS::Logs::LogGroup` --
  not a real infra problem, just delete the stray log group
  (`aws logs delete-log-group --log-group-name /aws/lambda/<function-name>`)
  and retry.
- **`cdk bootstrap` defaults the `CloudFormationExecutionRole` to AWS-
  managed `AdministratorAccess`.** This is a separate role CloudFormation
  itself assumes during a deploy, broader than the deploying
  `hadiknowntrades-agent` user's own scoped permissions -- worth knowing
  as the actual real-world security boundary, not just the narrower
  `hadiknowntrades-scoped-iam` policy on the user. Standard CDK default,
  not something this project changed; `--cloudformation-execution-policies`
  on `cdk bootstrap` would narrow it if that's ever wanted.
- Real deployed identifiers, for quick reference instead of re-querying
  CloudFormation: results bucket
  `hadiknowntradesstack-resultsbucketa95a2103-zojk0g4bxppr`, pipeline
  function `hadiknowntrades-pipeline`, both in `us-west-2`. Bucket/role
  names are otherwise CDK-auto-generated per the note below -- these are
  today's actual values, not guaranteed stable across a stack
  replacement.
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
- **The web Lambda is still the placeholder** (`cdk/lambda/web-placeholder/`),
  not a real OpenNext build -- this is now the main gap, not apps/web's
  own code. apps/web itself is a real app as of issues #7/#8/#10 (the
  results API, the range/chart/trade-list UI, the on-site methodology
  section) and has been live-verified against this exact deployed S3
  bucket -- the placeholder Lambda is purely an infra-side gap (no
  `open-next.config.ts`, no OpenNext build step, nothing in
  `webAssetsBucket`), not a reflection of apps/web's own state. See
  that file's header comment for exactly what needs to change (add
  `open-next.config.ts` + a build step to apps/web, then point the
  stack's `entry`/`code` at the real build output and sync
  `.open-next/assets` into `webAssetsBucket`).
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
- **Pipeline Lambda `memorySize` bumped 1024MB -> 2048MB in code (issue
  #29, 1-minute bars for 1M), not yet deployed.** Proactive, not
  reactive to an observed OOM -- see `apps/pipeline/CLAUDE.md`'s
  "1-minute path" section and `packages/core/CLAUDE.md`'s "1-minute
  intraday bars" section for the corrected memory estimate behind the
  number. Same "code lands, real-AWS deploy needs the user's separate
  go-ahead" pattern as #28's still-pending schema-bump rollout above --
  don't deploy this without asking first, and once it is deployed,
  confirm the real measured memory usage against this estimate (same
  discipline as how 903MB was itself established, not just trusted from
  an estimate).
