// Pure local CloudFormation-template assertions (aws-cdk-lib/assertions
// Template.fromStack) -- no network calls, no AWS credentials needed.
// Verifies the stack synthesizes the resources issue #6 calls for:
// S3 buckets, CloudFront, both Lambdas, the EventBridge rule + target,
// and minimally-scoped IAM.

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { HadIKnownTradesStack } from "../lib/hadiknowntrades-stack.js";

/**
 * `cdk.json`'s own `context` block (the aws-cdk-lib feature flags this
 * project's own real `cdk deploy`/`cdk synth` always pick up) --
 * `new App()` with no explicit `context` prop does NOT load this file
 * automatically outside the real CDK CLI's own process wrapping (real
 * bug, found empirically, not assumed): confirmed live that a plain
 * `new App()` here returns `undefined` for
 * `@aws-cdk/aws-s3:publicAccessBlockedByDefault` even though it's set
 * in cdk.json, and that this genuinely changes S3 `Bucket` construct
 * validation behavior -- `BlockPublicAccess.BLOCK_ACLS` paired with
 * `publicReadAccess: true` synthesized cleanly under this test suite's
 * old context-less `App()` calls, but threw
 * `CannotGrantPublicAccessWhenBlockPublicPolicyEnabled` under the real
 * `cdk deploy` CLI, which does load this file. Every `App` construction
 * in this suite now explicitly merges this file's context in, so a
 * future feature-flag-dependent bug like that one actually fails a test
 * instead of only surfacing at real-deploy time.
 */
const CDK_JSON_CONTEXT: Record<string, unknown> = JSON.parse(
  readFileSync(path.join(__dirname, "..", "cdk.json"), "utf-8"),
).context;

function synthTemplate(context: Record<string, unknown> = {}): Template {
  const app = new App({ context: { ...CDK_JSON_CONTEXT, ...context } });
  const stack = new HadIKnownTradesStack(app, "TestStack", {
    env: { region: "us-west-2" },
  });
  return Template.fromStack(stack);
}

describe("HadIKnownTradesStack", () => {
  // The stack's input never varies between these assertions, so synth
  // (including two real, uncached esbuild Lambda bundles) only needs to
  // run once for the whole suite instead of once per `it()`.
  let template: Template;
  beforeAll(() => {
    template = synthTemplate();
  });

  it("creates exactly two S3 buckets, both private with SSL enforced", () => {
    template.resourceCountIs("AWS::S3::Bucket", 2);
    template.allResourcesProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    // enforceSSL: true renders as a bucket policy denying any request
    // that isn't over SecureTransport, one per bucket.
    template.resourceCountIs("AWS::S3::BucketPolicy", 2);
    template.allResourcesProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("creates a CloudFront distribution with a Lambda default origin and an S3 static-asset behavior", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
        }),
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: "/_next/static/*" })]),
      }),
    });
    // Both origins (the web Lambda Function URL and the assets bucket)
    // go through Origin Access Control, not a public bucket/open URL.
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
  });

  it("creates the pipeline Lambda wired to RESULTS_BUCKET and a matching nightly EventBridge rule", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "hadiknowntrades-pipeline",
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          RESULTS_BUCKET: Match.anyValue(),
        }),
      },
    });

    template.resourceCountIs("AWS::Events::Rule", 1);
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({
            "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp("^PipelineFunction")]),
          }),
        }),
      ]),
    });

    // EventBridge's resource-based permission to invoke the Lambda,
    // scoped to this specific rule's ARN (not a wildcard).
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "events.amazonaws.com",
      SourceArn: Match.objectLike({
        "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp("^NightlyPipelineSchedule")]),
      }),
    });
  });

  it("creates the web Lambda with an IAM-authenticated Function URL, wired to RESULTS_BUCKET and the OpenNext S3 incremental cache", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "hadiknowntrades-web",
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          RESULTS_BUCKET: Match.anyValue(),
          CACHE_BUCKET_NAME: Match.anyValue(),
          CACHE_BUCKET_KEY_PREFIX: "cache",
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
    });
  });

  it("bypassCloudFront=true flips the Function URL public and the web-assets bucket to a fixed public name -- everything else is unaffected", () => {
    // Goes through synthTemplate (cdk.json's own context merged in, see
    // that helper's own doc comment) rather than a hand-rolled `new
    // App()` -- this exact test previously used one and passed locally
    // while the real `cdk deploy` CLI threw
    // `CannotGrantPublicAccessWhenBlockPublicPolicyEnabled`, precisely
    // because a hand-rolled App skipped cdk.json's
    // `publicAccessBlockedByDefault` flag.
    const bypassTemplate = synthTemplate({ bypassCloudFront: "true" });

    bypassTemplate.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
    bypassTemplate.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "hadiknowntrades-web-assets-public",
    });
    // The CloudFront Distribution itself is completely unaffected by the
    // flag -- it stays declared, unchanged, ready to pick up on a plain
    // `cdk deploy` the moment AWS unblocks it (see this stack's own
    // bypassCloudFront doc comment).
    bypassTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("bypassCloudFront=true drops the web-assets bucket's CloudFront OAC grant, so its bucket policy never depends on Distribution", () => {
    // Regression test for a real, previously-shipped bug (found live, not
    // in review): every bypassCloudFront=true deploy left webAssetsBucket
    // with NO bucket policy at all -- `withOriginAccessControl` bundles a
    // CloudFront-service-principal grant, scoped via a Condition that
    // embeds `Ref: <Distribution's logical id>`, into the SAME
    // AWS::S3::BucketPolicy resource as the public-read grant this mode
    // actually needs. CloudFormation computes a resource's dependencies
    // from every statement inside it, not per statement -- so as long as
    // that CloudFront grant was present at all, the whole policy (public
    // read included) could never be created until Distribution itself
    // finished, which it never does during the bypass window. See this
    // stack's own webAssetsOrigin doc comment for the full story.
    const bypassTemplate = synthTemplate({ bypassCloudFront: "true" });

    // Only one OAC left (the web Lambda's Function URL keeps AWS_IAM/OAC
    // in the *non*-bypass template only -- in bypass mode it's NONE-authed
    // and uses a plain FunctionUrlOrigin instead, see webFnOrigin above --
    // so the only OAC left here, if any, would have to be the assets
    // bucket's, and this asserts there isn't one).
    bypassTemplate.resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);

    // No AWS::S3::BucketPolicy statement anywhere in this template grants
    // CloudFront's own service principal read access -- the actual shape
    // of the grant that created the circular dependency.
    const policies = bypassTemplate.findResources("AWS::S3::BucketPolicy");
    const allStatements = Object.values(policies).flatMap(
      (policy) =>
        (
          policy as {
            Properties: { PolicyDocument: { Statement: Array<{ Principal?: unknown }> } };
          }
        ).Properties.PolicyDocument.Statement,
    );
    for (const statement of allStatements) {
      expect(statement.Principal).not.toEqual({ Service: "cloudfront.amazonaws.com" });
    }

    // The public-read grant bypassCloudFront actually needs is still
    // there -- confirms the fix didn't accidentally drop this too while
    // removing the CloudFront grant.
    bypassTemplate.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "s3:GetObject",
            Principal: { AWS: "*" },
          }),
        ]),
      },
    });
  });

  it("scopes the pipeline Lambda's S3 permission to the results/ prefix only", () => {
    // Bucket.grantPut() expands to the put-object action family (plain
    // put + the legal-hold/retention/tagging/multipart-abort variants
    // that go with actually writing an object) -- not a single literal
    // "s3:PutObject" string. What matters here is the *resource* scope
    // (results/* only) and that it stops short of read/delete/bucket-
    // level actions (checked separately below).
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:PutObject"]),
            Effect: "Allow",
            Resource: Match.objectLike({
              "Fn::Join": Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp("/results/\\*$")]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  it("does not grant the pipeline Lambda's own role broader S3 access than PutObject on its prefix", () => {
    // Scoped to the pipeline Lambda's own execution role specifically
    // -- the stack also contains an unrelated CDK-managed IAM policy
    // for the S3 auto-delete-objects custom resource (with its own,
    // broader S3 actions), which isn't what this test is about.
    // Its logical ID is "PipelineFunctionRole..." (its own explicit
    // `Role` construct id, given a real name so it falls under the
    // sandbox account's scoped IAM policy -- see the stack's
    // ScopedIamRoleNames aspect), not CDK's default
    // "PipelineFunctionServiceRole..." naming for an unnamed role.
    const pipelineRoleLogicalId = Object.keys(template.findResources("AWS::IAM::Role")).find((id) =>
      id.startsWith("PipelineFunctionRole"),
    );
    expect(pipelineRoleLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: Match.objectLike({
        Roles: Match.arrayWith([Match.objectLike({ Ref: pipelineRoleLogicalId })]),
      }),
    });
    const policyList = Object.values(policies) as Array<{
      Properties: { PolicyDocument: { Statement: Array<{ Action?: string | string[] }> } };
    }>;
    expect(policyList).toHaveLength(1);

    const s3Actions = policyList[0]!.Properties.PolicyDocument.Statement.flatMap((statement) =>
      Array.isArray(statement.Action)
        ? statement.Action
        : statement.Action
          ? [statement.Action]
          : [],
    ).filter((action) => action.startsWith("s3:"));

    // grantPut()'s put-object action family, and nothing broader
    // (no read, no delete, no bucket-level actions like
    // PutBucketPolicy -- those belong only to the separate, CDK-owned
    // auto-delete-objects custom resource role, not this Lambda).
    expect(s3Actions.sort()).toEqual(
      [
        "s3:Abort*",
        "s3:PutObject",
        "s3:PutObjectLegalHold",
        "s3:PutObjectRetention",
        "s3:PutObjectTagging",
        "s3:PutObjectVersionTagging",
      ].sort(),
    );
  });

  it("names every IAM role hadiknowntrades-* or cdk-*, matching the sandbox account's scoped IAM policy", () => {
    // The deploying IAM user (infra/bootstrap/scoped-iam-for-cdk.json)
    // can only create/manage roles named `hadiknowntrades-*` or
    // `cdk-*` -- CDK's own default (unnamed) execution roles get a
    // CloudFormation-generated name that matches neither prefix, which
    // would fail with AccessDenied on the first real deploy. This
    // covers every role the stack creates, including ones CDK builds
    // internally (e.g. the S3 autoDeleteObjects custom resource's
    // shared role) as a raw L1 escape hatch rather than the typed
    // CfnRole class.
    const roles = template.findResources("AWS::IAM::Role");
    const roleNames = Object.values(roles).map(
      (role) => (role as { Properties: { RoleName: string } }).Properties.RoleName,
    );

    expect(roleNames.length).toBeGreaterThan(0);
    for (const name of roleNames) {
      expect(name).toEqual(expect.stringMatching(/^(hadiknowntrades-|cdk-)/));
    }
  });
});
