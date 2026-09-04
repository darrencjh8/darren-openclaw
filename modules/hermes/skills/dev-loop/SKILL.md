---
name: dev-loop
description: >
  Use when running TDD, reviews, CI, and protected merges.
---

# Dev Loop

Strict development loop: fresh base, TDD, adversarial review, CI, protected merge.

## Communication

Load `caveman` first. Use **ultra** for agent and subagent prose.
Keep code, commands, commit text, review schema, IDs, numbers, and errors exact.
Use normal prose for user-facing PRs, issues, commits, docs, and other persisted human artifacts.

## Hard rules

- Repo rules override this skill.
- One code-reviewer process maximum at any moment. Never parallelize reviewers.
- Review profile: `code-reviewer`; the dev-loop caller selects the reviewer model each round from the allowed set `gpt-5.6-terra`, `glm-5.2`, `deepseek-v4-flash` (no account suffix; DeepSeek `deepseek-v4-flash` only, never `deepseek-v4-pro`).
- If a relevant specification exists, it must pass the `spec-auditor` gate before code review.
- No production code before a failing assertion test.
- Any repository change resets review clean streak to zero.
- Never direct-push default branch.
- Never manually build, restart, or deploy production. CI/CD deploys only after protected merge.
- Fail closed: unresolved prerequisite, reviewer/profile/skill failure, review-budget exhaustion, CI-budget exhaustion, or uncertain required checks means no merge.
- Own the loop through completion. After each review or CI result, fix validated issues, re-run required gates, repeat review as required, and continue through protected merge. Report only after merge or a defined fail-closed exit condition; never hand the next step back to the user merely because a review or check completed.

## State

Persist state outside the disposable feature worktree: `<durable-main-checkout>/.dev-loop/state.md`.
Verify `.dev-loop/` is ignored in the durable checkout before creating it. If it is not ignored, add the minimal ignore rule before starting implementation and verify it is excluded from `git status`.
Write atomically: write a same-directory temporary file, then rename it. Never store secrets.

```markdown
# dev-loop state
- repo: <owner/name>
- branch: <feature branch>
- base_branch: <branch>
- base_sha: <SHA>
- head_sha: <SHA>
- issue_ref: <#N or none>
- pr_number: <number or none>
- commands: <test/lint/build commands and versions>
- phase: <0|1|2|3>
- tdd_cycles: <N>
- review_round: <N>
- clean_round_shas: <SHA list>
- spec_path: <path, issue/plan reference, or none>
- spec_audit_verdict: <PASS|DRIFT|GAP|SKIPPED>
- findings: <IDs, evidence, trigger, severity, disposition>
- accepted_risks: <PR-visible rationale, owner, follow-up issue>
- review_lenses: <round number, A|B, HEAD SHA, verdict>
- ci_attempts: <N>
- last_run_id: <GitHub Actions run ID>
- updated_at: <ISO timestamp>
```

Resume only when repo, branch, base SHA, and HEAD SHA match state.
Reset stale state before work. Any new commit invalidates clean-round SHA list.
Retain state through PR lifecycle. Archive review evidence in PR. Remove transient state/worktree after merge or abandonment.

## Phase 0 - Bootstrap

1. Read repository instruction files and delivery rules.
2. Identify the durable default-branch checkout. Record its current branch and worktree path.
3. Fetch `origin/<default-branch>` and run `git pull --ff-only origin <default-branch>` in the durable checkout before planning or creating feature work. Halt before either command if it is dirty, detached, on another branch, or cannot fast-forward cleanly.
4. Verify the durable checkout is now exactly at `origin/<default-branch>`, then resolve the repository, base SHA, tests, lint, build, required CI checks, branch protection, merge queue, and required approvals.
5. Verify `.dev-loop/` is ignored in the durable checkout and run applicable baseline local gates before first RED.
6. Create a new isolated `feat/...` or `fix/...` worktree and branch from that verified `origin/<default-branch>` SHA. Never implement in the durable checkout.
7. Create/update durable state outside the feature worktree by atomic write.
8. Halt if any prerequisite cannot be resolved from live repository state.

## Phase 1 - TDD

### RED

1. Read nearby source and 2-3 related tests.
2. Add one minimal test for next behavior.
3. Run it. It must fail by assertion, not setup/import failure.

### GREEN

1. Make smallest production change.
2. Run targeted test, then full affected suite.

### REFACTOR

1. Refactor only with green tests.
2. Re-run targeted and full affected suite.
3. Run applicable lint/build/security gates.
4. Commit only when all required local gates pass.

### Exceptions

Docs, workflow, dependency, configuration, and test-only changes may skip RED only when no executable behavior changes.
Record reason and run relevant validation: syntax, config parsing, lint, build, or targeted tests.

## Phase 1.5 - Specification audit gate

If a relevant specification exists, invoke `spec-auditor` before code review.
A relevant specification may be a repository `spec.md` or `dd.md`, an approved
implementation plan, or an approved issue body supplied as the change contract.
Record its stable path or reference in state. If no relevant specification
exists, record `SKIPPED` and continue to Phase 2.

Run one fresh isolated Hermes process with the full specification, exact
`merge-base(base, HEAD)..HEAD` diff, changed-file list, repository instructions,
and test evidence:

```bash
cd <worktree>
HERMES_HOME=<hermes-home> hermes chat \
  --profile spec-auditor \
  -t terminal \
  -Q \
  --max-turns 20 \
  --query-file <spec-audit-prompt-outside-repo>
```

Require the auditor to load `caveman`, then `spec-auditor`, remain read-only,
and return exactly one verdict: `PASS`, `DRIFT`, or `GAP`.

- `PASS`: record verdict and continue to Phase 2.
- `DRIFT`: correct implementation through TDD, run required local gates,
  commit, then rerun a fresh spec audit.
- `GAP`: fail closed and request a human specification decision. Do not enter
  code review until the specification is resolved and a fresh audit passes.
- Auditor/profile failure: fail closed. Do not replace the independent audit
  with developer self-review.

Before and after the auditor run, verify repository status and diff hash are
unchanged. Any auditor mutation is a hard failure.

## Phase 2 - Review gate

### Reviewer process

One fresh isolated Hermes process per round. No second reviewer until first exits.

```bash
cd <worktree>
HERMES_HOME=<hermes-home> hermes chat \
  --profile code-reviewer \
  -t terminal \
  -Q \
  --max-turns 20 \
  --query-file <review-prompt-outside-repo>
```

Before launch verify `hermes chat --help` supports the exact invocation, the launch routes to the caller-selected reviewer model (one of `gpt-5.6-terra`, `glm-5.2`, `deepseek-v4-flash`), and `caveman`/`code-reviewer` skills exist in that profile.
Fail closed if the launch cannot be made to route to the selected model. The `code-reviewer` profile default is `glm-5.2`, so selecting `gpt-5.6-terra` or `deepseek-v4-flash` requires a per-run model override or a profile whose default equals the selection. Never run a different allowed model and record it as the selected model. Do not silently substitute a model or profile.

Run one review round using the required `code-reviewer` profile, choosing one lens:
- **A:** end-to-end behavior, callers, persistence, compatibility, and tests.
- **B:** adversarial failure paths, lifecycle mutation, security/logging, concurrency, CI/merge, and rollback.

Reviewer prompt must require:

- Load `caveman`, ultra intensity; then load `code-reviewer`.
- Run under the caller-selected reviewer model from the allowed set (`gpt-5.6-terra`, `glm-5.2`, `deepseek-v4-flash`); report the exact model as evidence. Do not substitute a model outside the allowed set.
- Read-only isolation: no edits, commits, branches, config changes, external write APIs, or network writes.
- Review exact `merge-base(base, HEAD)..HEAD`, surrounding callers, configuration, tests, and lifecycle paths.
- Output stable finding IDs, severity, file/line, evidence, concrete trigger for Critical/High, remediation, and verdict.

Before and after each reviewer run, record `git status --short` and a hash of `git diff --binary <base>...HEAD`.
Any reviewer mutation is a hard failure.

### Finding disposition

For every reported Critical/High, record evidence, trigger, severity rationale, and disposition.
The fixing agent may not self-dismiss a finding. A rejection requires either a follow-up finding disposition from the next fresh reviewer round or explicit human approval, with proof of false reachability, duplicate, or invalid trigger.
Unresolved or insufficiently adjudicated Critical/High blocks clean status.
Fix every validated Critical/High.
Fix trivial Medium/Low findings before the next review. Otherwise record PR-visible accepted risk, rationale, owner, and follow-up issue if actionable.

### Clean round

A round is clean only when all apply:

- Reviewer exits successfully with `VERDICT: APPROVE`.
- Zero unresolved Critical/High findings.
- Every reported Critical/High has recorded disposition.
- Required local test/lint/build/security gates pass.
- State records exact base SHA and HEAD SHA.

Gate passes after one clean round from a fresh session on the **same unchanged HEAD SHA**.
Any file, commit, dependency, generated artifact, configuration, or Medium/Low fix after a review verdict resets streak to zero and requires applicable tests plus a new full gate.

Maximum five total review rounds, including every re-review. Exhaustion is automatic NO-GO. No loop override.

## Phase 3 - PR, CI, merge

1. Push feature branch. Create non-draft PR.
2. Put tests, review rounds, accepted risks, no-deployment rule, and issue reference in PR body.
3. Resolve required checks from live branch protection; save the protection/check snapshot and bind every observed check to exact PR HEAD SHA.
4. Monitor required checks. Treat a newer workflow run, changed HEAD, or changed branch-protection snapshot as stale; re-resolve and re-evaluate or fail closed.
5. On any failing required check, obtain logs, diagnose, fix locally, run equivalent local gates, commit, and push.
6. Every CI-fix commit - behavioral or otherwise - resets review gate and requires full local gates plus Phase 2 within the same five-round total review budget.
7. Maximum three CI fix attempts. On exhaustion, mark the PR draft when permitted, persist state and decisive logs, then halt and escalate to the user. Never merge.

Merge only when exact PR HEAD SHA has:

- All required checks green.
- Branch protection satisfied.
- Required approvals present.
- Review conversations resolved.
- Non-draft, mergeable PR.
- Current base branch or required merge queue position.

Revalidate these immediately before squash merge.
Merge only through protected GitHub path and only when repository/user authorization permits.

## Completion

Report TDD cycles, clean-review SHA rounds, finding dispositions, CI attempts, required-check status, PR/merge status, and deployment ownership.

## Exit conditions

| Condition | Action |
|---|---|
| One clean round, CI green, protected merge complete | Report success |
| Review reaches five rounds | NO-GO; ask user |
| CI reaches three fix attempts | NO-GO; ask user |
| Required check stalls about 30 min | Investigate then halt |
| Prerequisite, auth, profile, skill, or infrastructure failure | Fail closed; ask user |
