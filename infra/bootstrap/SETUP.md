# Sandbox AWS setup

One-time steps to create the IAM identity Claude uses to build and deploy this
project, with guardrails so an agent mistake can't produce a surprise bill.
Do this in the AWS Console yourself — the credentials should never be typed
into a chat with Claude (including via the `!` shell-passthrough prefix).

## 1. Create the three IAM policies

In **IAM → Policies → Create policy → JSON**, paste each file below and save
with the given name.

| File | Policy name | Purpose |
|---|---|---|
| `deny-expensive-services.json` | `hadiknowntrades-deny-expensive` | Explicit `Deny` on always-on/hourly-billed resource types (EC2 instances, RDS, NAT gateways, EKS/ECS clusters, SageMaker, etc). An explicit `Deny` always wins over any `Allow`, so this makes the expensive stuff structurally impossible regardless of what else is granted. |
| `scoped-iam-for-cdk.json` | `hadiknowntrades-scoped-iam` | Narrow IAM permissions, only for role/policy/OIDC-provider resources named `hadiknowntrades-*` or `cdk-*`. `PowerUserAccess` deliberately excludes IAM management, and CDK needs to create Lambda execution roles — this adds that back without granting IAM access to anything else in the account. |
| `lockdown-policy.json` | `hadiknowntrades-lockdown` | **Not attached to the user directly.** This is the "kill switch" policy a Budget Action attaches automatically if spend crosses the threshold (step 3). A blanket `Deny *` on that one user, nothing else in the account is affected. |

## 2. Create the IAM user

**IAM → Users → Create user**

- Name: `hadiknowntrades-agent`
- No console access needed (programmatic access only)
- Attach permissions:
  - AWS managed policy: `PowerUserAccess`
  - Customer managed: `hadiknowntrades-deny-expensive`
  - Customer managed: `hadiknowntrades-scoped-iam`
- Do **not** attach `hadiknowntrades-lockdown` here — that one only gets attached automatically by the Budget Action.

Then **user → Security credentials → Create access key** → choose *Command Line Interface (CLI)* → download the CSV. Don't paste these values into the chat with Claude.

## 3. Set up the budget + automatic circuit breaker

**Billing and Cost Management → Budgets → Create budget**

- Type: Cost budget
- Amount: e.g. $15/month (adjust to taste)
- Alert: email you at 80% (belt-and-suspenders, in addition to the action below)
- **Add an action:**
  - Action type: *Apply an IAM policy*
  - Target: the `hadiknowntrades-agent` user
  - IAM policy: `hadiknowntrades-lockdown`
  - Threshold: e.g. 100% of budget (or lower if you want it to trip earlier)
  - Execution type: **Automatic** (not "requires approval") — this is what makes it a real circuit breaker instead of just another alert

Once tripped, the user is denied everything until you manually detach the
lockdown policy in the IAM console.

## 4. Wire up local credentials

In your own terminal (not through Claude):

```
aws configure
```

Enter the Access Key ID / Secret Access Key from step 2, a default region
(e.g. `us-east-1`), and output format `json`. This writes to
`~/.aws/credentials` — Claude can then use the AWS CLI/SDK without ever
seeing the raw secret.

## 5. GitHub Actions (later, issue #6)

CI deploys should use OIDC federation instead of these long-lived keys —
an IAM role that trusts `token.actions.githubusercontent.com`, no secrets
stored in GitHub at all. The `scoped-iam-for-cdk` policy above already
includes permission to create that OIDC provider when we get there.
