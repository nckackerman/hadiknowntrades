---
name: manage-issues
description: This skill should be used when the user asks to "act as manager", "delegate issues to child sessions", "run the delegation flow", "manage the issue queue", or gives a bare instruction like "let's work through the backlog" for the hadiknowntrades repo. Reconstructs the confirmed multi-agent delegation workflow (spawn one worker per issue, independent plan review for high-stakes work, triage escalations, hold merge on infra, verify persisted learnings) without re-deriving it from git log and memory each time.
---

# Managing the hadiknowntrades issue queue

Acting as manager means orienting on the repo, picking issues that are
actually ready, delegating each to an isolated child session, and
verifying the result before merging — not writing the code directly.
Full rationale for this shape lives in the `agent-delegation-manager-pattern`
memory; this skill is the checklist, not a replacement for reading it.

## 1. Orient

- `git log --oneline -20`, `git branch -a`, `git worktree list`, `git status`
  — catch up on what merged and spot leftover worktrees/branches from a
  prior round that never got cleaned up.
- `gh issue list --state open` (with labels + milestone) and
  `gh api repos/:owner/:repo/milestones` — current queue.
- Read `MEMORY.md` and any `*-project-state.md` / `*-manager-pattern.md`
  memory files for this repo before re-deriving anything.
- Root `CLAUDE.md`'s "Issue tracking conventions" section defines what
  `enhancement`/`backlog`/`wontfix` mean here — don't delegate a
  `backlog`-labeled issue without the user opting in; it's a deferred
  idea, not a queued task.

**Before touching anything stale**: a locked worktree isn't necessarily
abandoned. Check `ps -p <pid>` on the lock holder before force-removing —
a live `claude` process on a real `pts/N` tty is likely someone's open
terminal, not a crashed session. Leave it and tell the user, don't kill it.

**Check for issues whose PR merged without closing them** — a PR body
using "Implements #N" instead of "Closes #N" doesn't auto-close. Cross
check recently merged PRs against issue state and close manually with a
comment pointing at the PR/commits.

**Don't trust a single suspicious file read at face value.** If a fact
found via one tool call (e.g. a version constant, a line count) looks like
it contradicts recent commits/PR descriptions, re-read the file fresh
and check `git status`/`git diff` before concluding there's a real bug —
a stale or glitched read is more likely than the codebase and its tests
being silently inconsistent. Confirm with a second read before acting.

## 2. Pick delegation candidates

An issue is ready to delegate when: it's `enhancement` (or the user
explicitly wants a `backlog` one pulled forward), its stated dependencies
are actually merged to `main`, and it reads as self-contained per this
repo's own "agent-ready" bar (Goal, background with file paths, Scope,
Out of scope, Acceptance criteria — see CLAUDE.md's examples). If an
issue doesn't meet that bar, that's a reason to improve the issue first,
not to hand it to a worker with a thin brief.

Flag file-overlap risk between issues picked for the same round (e.g. two
issues touching the same client/schema file) — running them in parallel
means one PR rebases on the other after merge; running sequentially costs
wall-clock time instead. This is a real tradeoff worth a quick
`AskUserQuestion`, not a silent default, unless the user has already
stated a preference for this kind of case.

Present the candidate list and the plan (worktree count, review effort,
any file-overlap or infra-touching call) before spawning anything —
spawning several parallel child sessions is not free and not trivially
reversible.

## 3. Delegate

Per issue: spawn one worker in an isolated git worktree
(`isolation: "worktree"` on the `Agent` tool), with the issue's own body
as the spec.

- **Real design/schema/blast-radius stakes** (touches the stored data
  shape, deploy ordering, or a genuinely ambiguous product call): have
  the worker draft a written plan first and stop, no implementation.
  Send that plan to a **second, fresh instance with no shared context**
  to independently review it against the actual code (not just the
  prose). Then, as manager, triage the review's open questions
  yourself: genuine product/design calls go to the user as one batched
  `AskUserQuestion` with a recommended default; engineering-judgment
  calls get resolved by the implementer and documented, not escalated.
- **Narrower/lower-stakes issues**: let the worker go straight to
  implementation.
- Every worker's brief should say explicitly: capture newly discovered
  non-obvious facts in the repo's own nested `CLAUDE.md` files (not just
  the PR body) — that's what makes them cheap to rediscover next round.
- Tell every worker to watch its own CI run (`gh run watch`) rather than
  trusting the workflow file looks right, per the repo's working
  agreement.

## 4. Verify and merge

- Run `/code-review` at `high` effort per PR (not `xhigh` — this repo's
  working agreement reserves `xhigh` for one genuinely highest-stakes
  file per epic). Don't auto-retry a failed multi-agent review from
  scratch; fall back to `high` or a manual read.
- Confirm the worker actually wrote its non-obvious findings into the
  relevant `CLAUDE.md`, not only the PR description, before merging.
- Merge code-only PRs once tests + review are clean — standing
  permission for `gh pr merge` already exists. **Anything touching real
  AWS/infra needs the user's explicit go-ahead first, every time**,
  regardless of how clean the diff is — hold that merge/deploy step
  yourself and raise it explicitly rather than doing it.
- Clean up the worktree and branch after merge (checking for a live
  process first, per step 1).

## 5. Close the loop

Update (don't duplicate) the project's `*-project-state.md` memory with
what shipped, what's newly unblocked, and what's still waiting on the
user — so the next round starts from the current state instead of
re-deriving it from git log.
