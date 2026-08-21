// Pure local CloudFormation-template assertions (aws-cdk-lib/assertions
// Template.fromStack) -- no network calls, no AWS credentials needed.
// Verifies the stack synthesizes the resources issue #6 calls for:
// S3 buckets, CloudFront, both Lambdas, the EventBridge rule + target,
// and minimally-scoped IAM.

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { HadIKnownTradesStack } from "../lib/hadiknowntrades-stack.js";

function synthTemplate(): Template {
  const app = new App();
  const stack = new HadIKnownTradesStack(app, "TestStack", {
    env: { region: "us-west-2" },
  });
  return Template.fromStack(stack);
}

describe("HadIKnownTradesStack", () => {
  it("creates exactly two S3 buckets, both private with SSL enforced", () => {
    const template = synthTemplate();

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
    const template = synthTemplate();

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
    const template = synthTemplate();

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

  it("creates the web Lambda with an IAM-authenticated Function URL", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "hadiknowntrades-web",
      Handler: "index.handler",
    });
    template.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
    });
  });

  it("scopes the pipeline Lambda's S3 permission to the results/ prefix only", () => {
    const template = synthTemplate();

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
    const template = synthTemplate();
    const pipelineRoleLogicalId = Object.keys(template.findResources("AWS::IAM::Role")).find((id) =>
      id.startsWith("PipelineFunctionServiceRole"),
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
});
