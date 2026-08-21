# infra — working notes

`bootstrap/` is one-time sandbox AWS/IAM setup (docs + policies), not the
CDK app. `cdk/` is the actual AWS infrastructure as code (issue #6, not
built yet). Read this before re-investigating something below — if a
fact here turns out to be stale, fix the fact here too, not just the
code.

- **Never deploy or touch real AWS resources without the user's explicit
  go-ahead**, independent of anything else in this file — that agreement
  predates and overrides any process shortcut described here.
- Sandbox IAM already set up per `bootstrap/SETUP.md`: three policies
  (deny-list on expensive/always-on services, scoped IAM for
  CDK-created roles, a lockdown policy) attached to IAM user
  `hadiknowntrades-agent`, region **us-west-2**.
- **A budget circuit breaker was deliberately deferred** by the user's
  own choice — there is currently no automatic spend cap beyond the
  IAM deny-list. Worth raising again before any real `cdk deploy` in
  issue #6.
- If a custom domain + HTTPS ever gets added to CloudFront: the ACM
  certificate for that specifically must be requested in **us-east-1**
  regardless of the region everything else lives in — a CloudFront/ACM
  quirk, not a reason to move the whole app.
