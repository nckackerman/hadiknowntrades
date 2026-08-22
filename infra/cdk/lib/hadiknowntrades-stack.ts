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
//   - The real OpenNext build for apps/web -- see
//     lambda/web-placeholder/handler.ts for what stands in for it and
//     how to swap in the real thing once apps/web has actual routes.

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
import { FunctionUrlAuthType, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct, IConstruct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root, resolved relative to this file (infra/cdk/lib/) rather
// than process.cwd() -- `cdk synth`/`cdk deploy` can be invoked from
// anywhere, but this file's location in the tree is fixed.
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const PNPM_LOCK_FILE = path.join(REPO_ROOT, "pnpm-lock.yaml");
const PIPELINE_LAMBDA_ENTRY = path.join(REPO_ROOT, "apps", "pipeline", "src", "lambda-handler.ts");
const WEB_PLACEHOLDER_LAMBDA_ENTRY = path.join(
  __dirname,
  "..",
  "lambda",
  "web-placeholder",
  "handler.ts",
);

// Static asset paths CloudFront routes straight to S3 instead of
// through the web Lambda. `_next/static/*` is Next.js's own
// fingerprinted, immutable build output -- the one path pattern that's
// stable regardless of what routes apps/web ends up with. Once the real
// OpenNext build exists, this will likely need more entries (e.g. a
// `/favicon.ico` or public/* passthrough) -- left minimal for now since
// there's no real static output to serve yet either.
const STATIC_ASSET_PATH_PATTERNS = ["/_next/static/*"];

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
 * it directly). Both Lambda execution roles in this stack are already
 * given explicit `hadiknowntrades-*` names below, so in practice this
 * only ever touches that one internal role -- but doing it as an Aspect
 * means any other CDK-internal role added later is covered too, without
 * having to special-case each construct that happens to create one.
 */
class ScopedIamRoleNames implements IAspect {
  private count = 0;

  visit(node: IConstruct): void {
    if (node instanceof CfnRole) {
      // Typed roles (this stack only creates these via an explicit
      // `new Role(...)` with a name already set) -- nothing to do, but
      // handled for completeness in case one is ever added without one.
      if (node.roleName === undefined) node.roleName = this.nextName();
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
    // fingerprinted `_next/static/*` JS/CSS, images, etc), served
    // straight from S3 via CloudFront rather than round-tripping
    // through the web Lambda. Empty until apps/web has a real OpenNext
    // build to sync into it (see lambda/web-placeholder/handler.ts).
    const webAssetsBucket = new Bucket(this, "WebAssetsBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
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
      // baseline, on a Lambda that already had only ~121MB of headroom
      // -- very likely to exceed 1024MB without a bump. 2048MB is a
      // proactive starting point (2x current), not yet confirmed against
      // a real measured run with this issue's code -- see the PR for
      // issue #29. This is a code-only change: deploying it is a
      // separate, explicit-go-ahead action per this repo's real-AWS
      // working agreement, not performed as part of landing this code.
      memorySize: 2048,
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

    // --- Lambda: web app (PLACEHOLDER, see lambda/web-placeholder) ------
    const webFnRole = new Role(this, "WebFunctionRole", {
      roleName: `${ROLE_NAME_PREFIX}web-fn-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    const webFn = new NodejsFunction(this, "WebFunction", {
      functionName: "hadiknowntrades-web",
      role: webFnRole,
      entry: WEB_PLACEHOLDER_LAMBDA_ENTRY,
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      depsLockFilePath: PNPM_LOCK_FILE,
      bundling: {
        sourceMap: true,
      },
    });
    // AWS_IAM (not NONE): CloudFront's Origin Access Control signs
    // requests to the function URL with SigV4, and Lambda checks that
    // signature against the resource policy CloudFront's origin setup
    // grants it -- this is what stops the function URL from being
    // invokable directly, bypassing CloudFront.
    const webFnUrl = webFn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

    // --- CloudFront -------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "hadiknowntrades",
      defaultBehavior: {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(webFnUrl),
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
            origin: origins.S3BucketOrigin.withOriginAccessControl(webAssetsBucket),
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
  }
}
