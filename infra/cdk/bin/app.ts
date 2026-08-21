#!/usr/bin/env node
// CDK app entry point. Deliberately does NOT call `Stack`'s account/
// region resolution against a live AWS session (e.g. via
// `env.account: process.env.CDK_DEFAULT_ACCOUNT`) and does NOT use any
// context lookups (`Vpc.fromLookup`, AMI lookups, etc) -- both require
// live AWS credentials and would break `cdk synth` in an offline/CI
// environment. Region is pinned to a fixed placeholder matching the
// sandbox account's actual region (see infra/bootstrap/SETUP.md);
// account is left unset, making the stack account-agnostic until a
// real `cdk deploy` supplies one via `--profile`/`CDK_DEFAULT_ACCOUNT`.

import { App } from "aws-cdk-lib";

import { HadIKnownTradesStack } from "../lib/hadiknowntrades-stack.js";

const app = new App();

new HadIKnownTradesStack(app, "HadIKnownTradesStack", {
  env: {
    // Matches the sandbox IAM setup in infra/bootstrap/SETUP.md. A
    // fixed literal, not a live lookup -- safe to synth offline.
    region: "us-west-2",
  },
  description:
    "Had I Known Trades: S3 results/assets, CloudFront, web + pipeline Lambdas, nightly EventBridge schedule (issue #6).",
});
