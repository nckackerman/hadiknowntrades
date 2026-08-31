// Pure local CloudFormation-template assertions (aws-cdk-lib/assertions
// Template.fromStack) -- no network calls, no AWS credentials needed.
// Verifies the stack synthesizes the resources issue #6 calls for:
// S3 buckets, CloudFront, both Lambdas, the EventBridge rule + target,
// and minimally-scoped IAM.

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";

import { HadIKnownTradesStack } from "../lib/hadiknowntrades-stack.js";

function synthTemplate(): Template {
  const app = new App();
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
    // Context has to be supplied when the App itself is constructed
    // (read by tryGetContext's own scope-walking lookup) -- matches how
    // a real `cdk deploy -c bypassCloudFront=true` actually supplies it.
    const bypassApp = new App({ context: { bypassCloudFront: "true" } });
    const bypassStack = new HadIKnownTradesStack(bypassApp, "TestStack", {
      env: { region: "us-west-2" },
    });
    const bypassTemplate = Template.fromStack(bypassStack);

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
