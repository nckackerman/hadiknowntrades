// AWS Lambda entry point for the nightly pipeline, invoked on a
// schedule by infra/cdk's EventBridge rule (see
// infra/cdk/lib/hadiknowntrades-stack.ts). A thrown error here fails
// the Lambda invocation, which is what we want for now: EventBridge and
// Lambda's own failure visibility (CloudWatch Logs, Lambda error
// metrics) is enough for this project's stakes -- no custom
// retry/alerting wired up here (see infra/CLAUDE.md re: the
// deliberately-deferred budget circuit breaker for the general "not
// adding extra ops machinery yet" stance).
//
// Not exercised against a real Lambda invocation yet -- that requires
// issue #6's infrastructure to actually be deployed.

import { runNightlyPipeline } from "./run.js";

export const handler = (): Promise<void> => runNightlyPipeline();
