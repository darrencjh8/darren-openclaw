# Advance the Hermes container's codex-router checkout

Issue: [#613](https://github.com/darrencjh8/darren-openclaw/issues/613)

## Context

The Hermes container keeps its own codex-router checkout at `/workspace/codex-router`,
and dev-loop sessions drive the gate from **that** copy
(`python3 /workspace/codex-router/codex/skills/dev-loop/scripts/loop.py`). The
codex-router reconciler only writes the skill roots, so the checkout can sit at an
old revision while the roots are current.

Measured read-only on production Hermes, 2026-09-25 (the defect evidence; a reviewer
cannot re-run it, and the committed RED below only proves the guard was absent at
base, so this measurement is what the change is justified by):

- checkout `HEAD` = `2e0fcfc` (#122), 6 commits behind `origin/main`; its
  `state.py` is `41bd2f9c…`, state schema **3**
- the three reconciled roots hold canonical `c80dfb8` bytes (`state.py`
  `1f1c9618…`, schema **5**), verified per-file and by the installer's directory hash
- `/opt/data/state.db`: the container checkout's `loop.py` path appears in 895
  message rows, latest `2026-09-25T01:58Z`; the shipped skill copy in 13 rows,
  latest `2026-09-21T13:55Z`
- the five parked dev-loop states in `/workspace/issue-*` are schema 3, the
  generation of that checkout
- the checkout's remote is `https://github.com/darrencjh8/codex-router.git`, owned
  by the container's `hermes` user, whose git has no credential helper; gh is
  authenticated there (`GH_TOKEN` is in the hermes service environment), and
  `git -c credential.helper='!gh auth git-credential' ls-remote origin main`
  returns `c80dfb8`. Because that helper only runs for an HTTPS remote, the fetch
  depends on the remote staying HTTPS — a `git://` or `file://` remote would need
  no credentials but a rewritten one could break it.

So a production dev-loop run executes a driver that predates #140, and the P0
retry-budget fix (#153) never reaches it.

## Change

1. **New `modules/hermes/scripts/refresh-codex-router-checkout.sh`** — the single
   writer for the checkout. It:
   - holds an exclusive lock (`flock` on `$CHECKOUT/.git/codex-router-checkout.lock`,
     bounded wait) across the fetch and the merge, because a `hermes` deploy
     recreates the container and the boot hook then runs this script while the
     deploy is still running it;
   - skips, with a printed notice and exit 0, when the checkout is absent, dirty, or
     on a branch other than the expected one (`git symbolic-ref --quiet --short
     HEAD`), because a live session owns those states;
   - fetches the branch with gh's credential helper, then moves `HEAD` to the
     requested revision: a target `HEAD` already contains is a no-op, a target
     `HEAD` is an ancestor of is a fast-forward, and anything else — a diverged
     checkout, or a target missing from the fetched history — exits non-zero
     without forcing;
   - with no argument, tracks the fetched head;
   - never stashes, resets, rebases, or forces, and never touches a worktree.
2. **`modules/deploy.sh`** — a new `# ---- Hermes container codex-router checkout ----`
   block inside the existing
   `should_deploy "codex-router" || should_deploy "hermes"` scope. It guards what
   the sibling skills block guards: the host-side checkout
   (`[ ! -d "$ROOT/modules/codex-router" ]`), the script, and
   `docker inspect hermes`, each printing a notice and skipping outside CI; in CI a
   missing checkout or a refresh failure counts toward `failed`. It copies the
   script into the container and runs it as `hermes` with the revision this deploy
   checked out (`git -C "$ROOT/modules/codex-router" rev-parse HEAD`), so the
   running container, the skill roots, and the checkout describe one revision.
3. **`modules/hermes/50-seed-defaults`** — run the refresh on boot as `hermes`
   (`su -s /bin/sh hermes -c`), with no target so it tracks `origin/main`; a
   recreated container heals itself. It runs the image-baked copy
   `/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh`: that path only
   changes when the hermes image is rebuilt, which is exactly when this file
   changes, and the deploy's own copy is what refreshes the container between
   rebuilds. Failure logs a warning and never fails the boot.
4. **Tests** — new behaviour suite
   `modules/hermes/tests/test-refresh-codex-router-checkout.sh` exercises the
   script against real repositories: up-to-date no-op, fast-forward, an explicit
   target that must move `HEAD` to that revision and away from the fetched head, a
   target `HEAD` already contains (no-op), dirty skip, wrong-branch skip, diverged
   failure, and absent skip; it also pins both call sites, scoped to the new deploy
   block where the sibling block would otherwise satisfy the same text.
   `modules/tests/test_deploy_workflow_router.py` gains
   `test_hermes_container_checkout_is_refreshed`, which pins the deploy block, the
   checkout marker, the owning user, the script's dirty and branch guards, the
   absence of destructive git verbs, and the boot call's "never fail the boot"
   shape. The new suite is wired into the `hermes-scripts` job of
   `.github/workflows/test.yml`.

## Questions and answers

Q: When the checkout cannot be advanced, what should the deploy do?
Assumption: Skip an absent or dirty checkout with a printed notice, and fail the deploy
when a clean checkout cannot fast-forward. A dirty checkout is normal — a live
session is mid-work — and must never break an unrelated deploy; a clean checkout
that cannot move means the environment disagrees with what was shipped, which is
the failure this issue exists to make loud. (Operator selected the other two
questions and left this one to the recommendation.)

Q: Should the refresh also run at container boot?
A: Yes. The boot hook runs the same script as `hermes` with no target, tracking
`origin/main`, so a recreated container heals itself.

Q: Which deploys refresh the checkout?
A: Both a router-only deploy (`components=codex-router`) and a `hermes` deploy —
the same scope as the skill reconcile.

Q: Which revision does the deploy target?
Assumption: The revision this deploy checked out (`git -C "$ROOT/modules/codex-router"
rev-parse HEAD`), not whatever `main` is at deploy time, so the running container,
the skill roots, and the checkout describe one revision. Boot has no such revision
available, so it tracks `origin/main`; a boot between deploys can be ahead of the
reconciled roots.

Q: Which identity runs the refresh?
Assumption: The container's `hermes` user in both callers (`docker exec -u hermes`, `su -s
/bin/sh hermes -c`). Verified: the checkout is owned by `hermes`, running as root
trips git's `dubious ownership`, and root writes would leave objects the sessions
cannot extend when they create worktrees.

Q: How does the fetch authenticate?
Assumption: An inline `-c credential.helper='!gh auth git-credential'` on the fetch,
because the image's git has no credential helper and gh is already authenticated.
Verified: `git ls-remote origin main` returns `c80dfb8` with that helper. Nothing
is persisted to git config.

Q: Can this disturb a session that is using the checkout?
Assumption: No. The script operates on the base repository only, never on a worktree, and
skips a dirty checkout entirely; a fetch plus fast-forward leaves existing
worktrees and stashes untouched.

Q: Do other checkouts in the container need the same treatment?
Assumption: No. Searching the session database for `dev-loop/scripts/loop.py` found this
checkout as the only repository-local driver source, plus the installed skill
copies.

## Out of scope

- The five parked schema-3 states under `/workspace/issue-*`: the current driver
  refuses them (`state schema version 3 is not 5 … archive … and run loop.py
  init`). Before this change they resumed under the old driver; after it they
  cannot resume at all, which is the intended direction but an operator decision
  this change cannot make. Tracked in
  [#614](https://github.com/darrencjh8/darren-openclaw/issues/614), which archives
  or re-inits each state that is still wanted.
- The dev-loop plan pack's Change scaffold: it looks for
  `.github/workflows/tests.yml`, reports "no test command" and "no test files" for
  this repository, and was bound to a dangling commit in round 1. Regenerating the
  pack here is automatic (the next `plan` run does it), but the filename assumption
  is a driver defect, tracked in
  [codex-router#161](https://github.com/darrencjh8/codex-router/issues/161).
- `/opt/data/home/.codex/skills` (September generation). It is inert — no `codex`
  binary exists in the container — and the reconciler's shadow list does not cover
  that root. Cleaning it up is a separate decision.

## Verification

- `bash modules/hermes/tests/test-refresh-codex-router-checkout.sh`
- `python -m unittest modules.tests.test_deploy_workflow_router`
- `bash modules/hermes/tests/test-dev-loop-skill.sh`,
  `bash modules/hermes/tests/test-codex-router-skills-sync.sh`,
  `bash modules/hermes/tests/test-50-seed-defaults.sh`,
  `bash modules/hermes/tests/test-deploy.sh`
- `shellcheck modules/hermes/scripts/*.sh modules/hermes/50-seed-defaults`
- after merge the deploy log must print the checkout's new short SHA, and a fresh
  session's driver path must resolve to the deployed revision
