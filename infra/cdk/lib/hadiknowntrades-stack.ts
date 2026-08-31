// The stack for issue #6: S3 buckets, CloudFront, Lambda hosting for
// the web app and the nightly pipeline, EventBridge schedule, and the
// minimally-scoped IAM those resources need.
//
// Deliberately NOT wired up here (see the issue #6 PR description for
// the full list and rationale):
//   - A budget circuit breaker beyond the sandbox account's existing
//     IAM deny-list (infra/bootstrap/SETUP.md) -- deferred by the
//     user's own choice; worth reconsidering before any real deploy.
//   - A custom domain / ACM certificate -- not in scope, no custom
//     domain requested yet. If one is added later, remember the ACM
//     cert for CloudFront must be requested in us-east-1 regardless of
//     the region everything else lives in.
//
// The web Lambda now runs a real OpenNext build of apps/web (issue #6's
// original placeholder is gone -- see git history for
// lambda/web-placeholder/handler.ts if that stub is ever needed for
// reference again). Run `pnpm --filter web run build:lambda` (or
// `build:lambda:bypass`, see WEB_ASSETS_PUBLIC_BUCKET_NAME below) before
// `cdk synth`/`cdk deploy` -- there's no build step wired into the CDK
// deploy itself, matching this stack's existing pattern of the pipeline
// Lambda bundling from already-checked-out source rather than building
// it.

import { fileURLToPath } from "node:url";
import * as path from "node:path";

import {
  Aspects,
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  type IAspect,
  type StackProps,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { CfnRole, ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket, HttpMethods } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct, IConstruct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root, resolved relative to this file (infra/cdk/lib/) rather
// than process.cwd() -- `cdk synth`/`cdk deploy` can be invoked from
// anywhere, but this file's location in the tree is fixed.
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const PNPM_LOCK_FILE = path.join(REPO_ROOT, "pnpm-lock.yaml");
const PIPELINE_LAMBDA_ENTRY = path.join(REPO_ROOT, "apps", "pipeline", "src", "lambda-handler.ts");
// Real OpenNext build output -- produced by `pnpm --filter web run
// build:lambda` (or `build:lambda:bypass`), not built by this CDK app
// itself. See this file's own top-of-file comment.
const WEB_SERVER_FUNCTION_DIR = path.join(
  REPO_ROOT,
  "apps",
  "web",
  ".open-next",
  "server-functions",
  "default",
);
const WEB_ASSETS_DIR = path.join(REPO_ROOT, "apps", "web", ".open-next", "assets");

// Static asset paths CloudFront routes straight to S3 instead of
// through the web Lambda. `_next/static/*` is Next.js's own
// fingerprinted, immutable build output; `/favicon.ico` is the one
// other real path the real OpenNext build actually produces at the
// bucket root (confirmed by inspecting a real `.open-next/assets`
// build -- the create-next-app starter's other unused `public/*` SVGs
// were left out deliberately, since apps/web's own code never
// references them).
const STATIC_ASSET_PATH_PATTERNS = ["/_next/static/*", "/favicon.ico"];

// Must match apps/web/next.config.ts's own hardcoded
// `WEB_ASSETS_PUBLIC_BUCKET_URL` constant exactly -- see
// `webAssetsBucket`'s own doc comment below for why a fixed bucket name
// (not this stack's usual CDK-auto-generated one) is needed here,
// specifically only while bypassing CloudFront.
const WEB_ASSETS_PUBLIC_BUCKET_NAME = "hadiknowntrades-web-assets-public";

// The sandbox account's deploying IAM user has no general IAM access --
// PowerUserAccess deliberately excludes it (infra/bootstrap/SETUP.md) --
// only the narrow `hadiknowntrades-scoped-iam` policy, which permits
// iam:CreateRole/PutRolePolicy/etc solely for role names matching
// `hadiknowntrades-*` or `cdk-*` (infra/bootstrap/scoped-iam-for-cdk.json).
// CDK's own default (unnamed) execution roles get CloudFormation-generated
// names that match neither prefix, which would fail with AccessDenied on
// the first real `cdk deploy`. Every role this stack creates -- explicitly
// or via a construct's internals -- must carry this prefix.
const ROLE_NAME_PREFIX = "hadiknowntrades-";

/**
 * Catches any IAM role left with no explicit name -- specifically the
 * shared custom-resource execution role CDK's S3 `autoDeleteObjects`
 * support creates internally (aws-cdk-lib/aws-s3 exposes no prop to name
 * it directly). Both Lambda execution roles in this stack, and the
 * `BucketDeployment` construct's own execution role (see
 * `webAssetsDeploymentRole` below), are already given explicit
 * `hadiknowntrades-*` names via their own constructor props, so in
 * practice this only ever touches that one S3-internal role -- but doing
 * it as an Aspect means any other CDK-internal role added later is
 * covered too, without having to special-case each construct that
 * happens to create one.
 *
 * **`BucketDeployment` deliberately gets an explicit `role` passed in
 * (see below), not left for this Aspect to patch after the fact** --
 * found empirically while first adding that construct, not assumed:
 * `BucketDeployment`'s own default auto-created role is a singleton
 * `CfnRole` built by a `CustomResourceProvider` factory whose own
 * internal Cfn-property derivation discards a `roleName` set here
 * *both* via a plain assignment *and* via `addPropertyOverride` --
 * confirmed by direct synth-and-inspect that this Aspect's own `visit()`
 * genuinely runs and the override genuinely "takes" at that moment, yet
 * the final synthesized template has no `RoleName` regardless. Passing
 * an explicit, already-named role into the construct up front sidesteps
 * that internal machinery entirely instead of fighting it after the
 * fact -- worth remembering before assuming this Aspect alone is enough
 * for a future CDK-internal-role case; check whether the construct
 * accepts its own `role` prop first.
 */
class ScopedIamRoleNames implements IAspect {
  private count = 0;

  visit(node: IConstruct): void {
    if (node instanceof CfnRole) {
      // Typed roles (this stack only creates these via an explicit
      // `new Role(...)` with a name already set) -- nothing to do, but
      // handled for completeness in case one is ever added without one.
      if (node.roleName === undefined) node.addPropertyOverride("RoleName", this.nextName());
      return;
    }
    // CDK's `CustomResourceProvider` framework -- what S3's
    // `autoDeleteObjects: true` uses internally to create its shared
    // cleanup-Lambda execution role -- builds it as a raw L1
    // `CfnResource` escape hatch rather than the typed `CfnRole` class,
    // so it never matches the branch above. There's no public prop
    // anywhere to name it directly, hence patching it here via property
    // override instead.
    if (node instanceof CfnResource && node.cfnResourceType === "AWS::IAM::Role") {
      node.addPropertyOverride("RoleName", this.nextName());
    }
  }

  private nextName(): string {
    this.count += 1;
    // IAM role names are capped at 64 characters; a short incrementing
    // suffix keeps this well under that regardless of how deeply nested
    // the construct that created the role is.
    return `${ROLE_NAME_PREFIX}cdk-internal-role-${this.count}`;
  }
}

export class HadIKnownTradesStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- CloudFront-bypass workaround toggle -----------------------------
    // AWS blocks new CloudFront Distribution creation on low-usage
    // accounts pending a manual AWS Support account-verification case --
    // see infra/CLAUDE.md's "Current deployment state" (the Distribution
    // resource below is CREATE_FAILED for exactly this reason, filed and
    // pending as of this writing, not a bug in this stack). This flag is
    // a temporary, single-toggle workaround: `cdk deploy -c
    // bypassCloudFront=true` exposes the web Lambda's own Function URL
    // directly (public, no CloudFront) and serves static assets from a
    // genuinely public S3 bucket instead of CloudFront's own S3 origin.
    // Every place this flag is read is called out explicitly below --
    // nothing else in this stack branches on it. Revert is just
    // redeploying with the flag omitted (the default, `false`) once AWS
    // Support clears the account -- the *same*, already-declared
    // Distribution resource then completes on a plain `cdk deploy`, and
    // everything below reverts to its normal, locked-down shape
    // automatically.
    const bypassCloudFront = this.node.tryGetContext("bypassCloudFront") === "true";

    // --- S3: precomputed results -------------------------------------
    // Written by the pipeline Lambda as `results/{RANGE}.json` (see
    // apps/pipeline/CLAUDE.md). Idempotent fixed-key overwrites, not
    // accumulated dated copies -- no versioning/lifecycle rules needed.
    const resultsBucket = new Bucket(this, "ResultsBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Sandbox/learning project (see root CLAUDE.md): results are
      // regenerated nightly from scratch, so nothing here is
      // irreplaceable. Destroying the bucket on stack teardown avoids
      // manual cleanup of an orphaned bucket after a `cdk destroy`.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- S3: static web assets -----------------------------------------
    // Holds the OpenNext build's static output (`.open-next/assets`:
    // fingerprinted `_next/static/*` JS/CSS, favicon.ico, etc), normally
    // served straight from S3 via CloudFront's own S3 origin rather than
    // round-tripping through the web Lambda.
    //
    // While bypassing CloudFront (see `bypassCloudFront` above), this
    // bucket instead needs to be reachable directly, and needs a *known*
    // name -- Next's own `assetPrefix` (apps/web/next.config.ts, gated on
    // the same `OPENNEXT_BYPASS_CLOUDFRONT` env var the bypass build
    // sets) has to be baked into the app at `next build` time, before
    // this bucket even exists, so its name can't be the usual
    // CDK-auto-generated one in that mode.
    // `WEB_ASSETS_PUBLIC_BUCKET_NAME` is that fixed name; both flip
    // together, only under `bypassCloudFront`. Outside it (the normal
    // case) this bucket keeps its usual CDK-auto-generated name and
    // stays fully private, unchanged from before this workaround
    // existed. `BLOCK_ACLS_ONLY` (not `BLOCK_ALL`) is required for
    // `publicReadAccess: true` to actually take effect -- it blocks
    // ACL-based public access while still allowing the bucket-policy-
    // based public read this construct adds. **Not `BLOCK_ACLS`, a real
    // bug caught only by the real `cdk deploy` CLI, not this file's own
    // vitest suite (fixed, see that suite's own updated setup for why):
    // `BLOCK_ACLS` is a deprecated preset that still leaves
    // `blockPublicPolicy: true`, which throws
    // `CannotGrantPublicAccessWhenBlockPublicPolicyEnabled` the moment
    // `publicReadAccess: true` tries to attach a public bucket policy --
    // `BLOCK_ACLS_ONLY` is the current preset that actually sets
    // `blockPublicPolicy: false` alongside blocking ACLs.**
    const webAssetsBucket = new Bucket(this, "WebAssetsBucket", {
      bucketName: bypassCloudFront ? WEB_ASSETS_PUBLIC_BUCKET_NAME : undefined,
      blockPublicAccess: bypassCloudFront
        ? BlockPublicAccess.BLOCK_ACLS_ONLY
        : BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: bypassCloudFront,
      // Browsers loading a fingerprinted chunk from this bucket's own
      // domain (not the page's own origin) need this for the fetch-based
      // parts of Next's client runtime (dynamic import()) -- plain
      // <script src>/<link href> loads don't need it, but not every
      // asset load goes through those tags. GET-only, matches this
      // bucket's own read-only role in the bypass.
      cors: bypassCloudFront
        ? [{ allowedMethods: [HttpMethods.GET], allowedOrigins: ["*"], allowedHeaders: ["*"] }]
        : undefined,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Lambda: nightly pipeline ---------------------------------------
    // Bundles apps/pipeline's real source (lambda-handler.ts, a thin
    // wrapper around the same runPipeline() the CLI entry point uses)
    // with esbuild at synth time -- no Docker, no network calls beyond
    // what a normal local build needs.
    const pipelineFnRole = new Role(this, "PipelineFunctionRole", {
      // Explicit name (not CDK's default auto-generated one) so it falls
      // under the sandbox account's scoped IAM policy -- see
      // ROLE_NAME_PREFIX above.
      roleName: `${ROLE_NAME_PREFIX}pipeline-fn-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    const pipelineFn = new NodejsFunction(this, "PipelineFunction", {
      functionName: "hadiknowntrades-pipeline",
      role: pipelineFnRole,
      entry: PIPELINE_LAMBDA_ENTRY,
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      // Fetches ~500 tickers' full history with bounded concurrency
      // (apps/pipeline/CLAUDE.md) then runs the DP optimizer 5x
      // (one per preset range) -- comfortably needs more than the
      // default 3s/128MB, well under Lambda's 15-minute ceiling.
      // Bumped 1024 -> 2048 for issue #29 (1-minute bars for 1M): a real
      // measured invocation already showed 903MB/1024MB used *before*
      // this issue (apps/pipeline/CLAUDE.md), and #29's back-of-envelope
      // estimate (corrected during its plan review -- see
      // docs/plans/issue-29-plan.md's addendum) puts the new 1-minute
      // fetch's added memory at roughly ~350-450MB on top of that
      // baseline. That 2048MB estimate has since been live-disproven:
      // a real full-universe run (short-selling mode, chained per-day
      // capital, and more granularity overrides had all landed by
      // then, none accounted for in the #29 estimate) genuinely
      // OOM'd at 2048MB (twice -- once container-killed, once a real V8
      // heap OOM). **Bumped again, 2048 -> 3008, confirmed against a
      // real measured run**: a full 503-ticker run with
      // `computeCustomAnchors: true` (1,255 real anchors) completed
      // successfully at 3008MB, peaking at 2686MB -- 3008 is this
      // account's actual Lambda memory ceiling (a service quota below
      // the documented 10,240MB max), not a chosen headroom target, so
      // there's no further proactive bump available if usage keeps
      // growing -- watch this if a future feature adds real memory
      // pressure. 3008MB was deployed directly (real-AWS action,
      // approved) via `update-function-code` +
      // `update-function-configuration` rather than a full `cdk deploy`,
      // since the stack was (and, as of this writing, still is) paused
      // in `UPDATE_FAILED` by the known CloudFront account-verification
      // block (see infra/CLAUDE.md's "Current deployment state") --
      // this code-level value is updated to match so the *next* real
      // `cdk deploy`, whenever the stack is unstuck, doesn't silently
      // regress the deployed memory back to 2048 and reintroduce the
      // OOM.
      memorySize: 3008,
      timeout: Duration.minutes(15),
      environment: {
        RESULTS_BUCKET: resultsBucket.bucketName,
      },
      depsLockFilePath: PNPM_LOCK_FILE,
      bundling: {
        sourceMap: true,
      },
    });
    // Scoped to exactly what S3ResultStore does (PutObject) on exactly
    // the prefix the pipeline writes to (results/{RANGE}.json) -- not
    // a blanket grantWrite/grantReadWrite on the whole bucket.
    resultsBucket.grantPut(pipelineFn, "results/*");

    // --- EventBridge: nightly schedule -> pipeline Lambda ----------------
    // 06:00 UTC is a placeholder: comfortably after US market close and
    // typical EOD-data settlement, not tuned against any real Yahoo
    // data-availability SLA. Revisit once the pipeline has run for real.
    new events.Rule(this, "NightlyPipelineSchedule", {
      ruleName: "hadiknowntrades-nightly-pipeline",
      description: "Triggers the nightly precompute pipeline Lambda once a day.",
      schedule: events.Schedule.cron({ minute: "0", hour: "6" }),
      targets: [new targets.LambdaFunction(pipelineFn)],
    });

    // --- Lambda: web app --------------------------------------------------
    // Real OpenNext build output. Not a NodejsFunction: OpenNext already
    // produces a fully bundled Lambda package (its own node_modules
    // included), so this points Code.fromAsset at that output directory
    // rather than having esbuild re-bundle a TS source entry the way the
    // pipeline Lambda does.
    const webFnRole = new Role(this, "WebFunctionRole", {
      roleName: `${ROLE_NAME_PREFIX}web-fn-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    const webFn = new LambdaFunction(this, "WebFunction", {
      functionName: "hadiknowntrades-web",
      role: webFnRole,
      code: Code.fromAsset(WEB_SERVER_FUNCTION_DIR),
      handler: "index.handler",
      runtime: Runtime.NODEJS_22_X,
      // Starting guesses for a real Next SSR cold start -- not yet
      // measured against real CloudWatch numbers (unlike the pipeline
      // Lambda's own memory, tuned against three real OOMs, see below).
      // Revisit once this is actually invoked for real.
      memorySize: 1024,
      timeout: Duration.seconds(30),
      // A real ceiling on cost/abuse exposure while `bypassCloudFront`
      // makes this Lambda's own Function URL public and CloudFront-
      // uncached, with no automatic AWS Budget Action lockdown on this
      // account (infra/CLAUDE.md's own "budget circuit breaker" note) --
      // a deliberate choice for a low-traffic personal project, not a
      // technical requirement. Applies regardless of `bypassCloudFront`
      // -- harmless once CloudFront is the only way in, since real
      // traffic here will never come close to it.
      reservedConcurrentExecutions: 5,
      environment: {
        RESULTS_BUCKET: resultsBucket.bucketName,
        // OpenNext's own S3-backed incremental cache -- apps/web's
        // open-next.config.ts sets tagCache: "dummy"/queue: "direct"
        // specifically so this is the *only* extra AWS dependency ISR
        // needs here (no DynamoDB, no SQS), matching apps/web's own one
        // real ISR route (/api/og/[range], time-based revalidate only,
        // no revalidateTag/revalidatePath calls anywhere in this app).
        // Reuses webAssetsBucket under its own prefix rather than a
        // third bucket.
        CACHE_BUCKET_NAME: webAssetsBucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: "cache",
        CACHE_BUCKET_REGION: this.region,
      },
    });
    resultsBucket.grantRead(webFn, "results/*");
    webAssetsBucket.grantReadWrite(webFn, "cache/*");
    // AWS_IAM normally (not NONE): CloudFront's Origin Access Control
    // signs requests to the function URL with SigV4, and Lambda checks
    // that signature against the resource policy CloudFront's origin
    // setup grants it -- this is what stops the function URL from being
    // invokable directly, bypassing CloudFront. Flipped to NONE (public,
    // no auth at all) only under `bypassCloudFront` -- see this file's
    // own `bypassCloudFront` doc comment above.
    const webFnUrl = webFn.addFunctionUrl({
      authType: bypassCloudFront ? FunctionUrlAuthType.NONE : FunctionUrlAuthType.AWS_IAM,
    });

    // Syncs the OpenNext build's static output into webAssetsBucket as
    // part of the same `cdk deploy` -- no separate manual `aws s3 sync`
    // step needed either way (normal or bypass).
    //
    // Explicit `role`, not BucketDeployment's own default auto-created
    // one (real bug, found empirically, not assumed from CDK's docs):
    // its default role is a singleton `CfnRole` shared across every
    // `BucketDeployment` in a stack, built by a `CustomResourceProvider`
    // factory whose own re-derivation of that role's Cfn properties
    // during synthesis discards a plain `roleName` assignment *and* an
    // `addPropertyOverride("RoleName", ...)` applied via the
    // ScopedIamRoleNames Aspect below -- confirmed by direct synth-and-
    // inspect: the Aspect's own visit() genuinely runs and the override
    // genuinely "takes" at that moment, but the final synthesized
    // template has no RoleName regardless. Supplying an explicit,
    // already-named Role up front (the same pattern webFnRole/
    // pipelineFnRole already use) sidesteps that internal machinery
    // entirely rather than trying to patch its output after the fact --
    // BucketDeployment still grants this role whatever S3 permissions it
    // needs, the same as if it had created the role itself.
    const webAssetsDeploymentRole = new Role(this, "WebAssetsDeploymentRole", {
      roleName: `${ROLE_NAME_PREFIX}web-assets-deployment-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    new BucketDeployment(this, "WebAssetsDeployment", {
      sources: [Source.asset(WEB_ASSETS_DIR)],
      destinationBucket: webAssetsBucket,
      role: webAssetsDeploymentRole,
    });

    // --- CloudFront -------------------------------------------------------
    // Computed once and reused across every static-asset behavior below
    // (real bug, found by an unexpected third AWS::CloudFront::
    // OriginAccessControl showing up in the synthesized template once
    // STATIC_ASSET_PATH_PATTERNS grew a second entry): `withOriginAccessControl`
    // creates a fresh Origin *and* a fresh OAC resource on every call, even
    // for the identical bucket -- calling it once per path pattern inside
    // the .map() below silently created one redundant origin+OAC pair per
    // extra pattern instead of sharing the one this bucket actually needs.
    const webAssetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(webAssetsBucket);
    // CDK itself refuses to synthesize `FunctionUrlOrigin.withOriginAccessControl`
    // paired with anything but an AWS_IAM-authed Function URL (a real,
    // synth-time error caught while first testing bypassCloudFront=true,
    // not a hypothetical): OAC signs its requests with SigV4, and an
    // origin CloudFront can't actually authenticate against with that
    // signature is a genuine misconfiguration CDK is right to reject
    // outright, even though this specific Distribution won't actually
    // deploy either way during the bypass window (AWS blocks its
    // creation at the account level regardless of its own config, see
    // this file's own bypassCloudFront doc comment) -- the plain,
    // non-OAC `FunctionUrlOrigin` constructor is what a NONE-authed
    // Function URL actually needs to stay a valid declaration.
    const webFnOrigin = bypassCloudFront
      ? new origins.FunctionUrlOrigin(webFnUrl)
      : origins.FunctionUrlOrigin.withOriginAccessControl(webFnUrl);
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "hadiknowntrades",
      defaultBehavior: {
        origin: webFnOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // SSR responses are dynamic and per-request; caching is left to
        // whatever the web app's own Cache-Control headers say once
        // it's real, not CloudFront's default heuristics.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: Object.fromEntries(
        STATIC_ASSET_PATH_PATTERNS.map((pattern) => [
          pattern,
          {
            origin: webAssetsOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          },
        ]),
      ),
    });

    // Must run after every construct above exists, since it walks the
    // whole stack's construct tree looking for roles CDK created without
    // an explicit name (see ScopedIamRoleNames' own doc comment).
    Aspects.of(this).add(new ScopedIamRoleNames());

    // --- Outputs ------------------------------------------------------
    new CfnOutput(this, "ResultsBucketName", { value: resultsBucket.bucketName });
    new CfnOutput(this, "WebAssetsBucketName", { value: webAssetsBucket.bucketName });
    new CfnOutput(this, "PipelineFunctionName", { value: pipelineFn.functionName });
    new CfnOutput(this, "DistributionDomainName", { value: distribution.distributionDomainName });
    // Harmless to always emit -- only actually reachable when
    // bypassCloudFront is true (AWS_IAM auth otherwise rejects a direct
    // request). See this file's own bypassCloudFront doc comment above.
    new CfnOutput(this, "WebFunctionUrl", { value: webFnUrl.url });
  }
}
