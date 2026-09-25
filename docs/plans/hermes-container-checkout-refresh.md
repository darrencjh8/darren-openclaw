# Advance the Hermes container's codex-router checkout

Issue: [#613](https://github.com/darrencjh8/darren-openclaw/issues/613)

## Context

The Hermes container keeps its own codex-router checkout at `/workspace/codex-router`,
and dev-loop sessions drive the gate from **that** copy
(`python3 /workspace/codex-router/codex/skills/dev-loop/scripts/loop.py`). The
codex-router reconciler only writes the skill roots, so the checkout can sit at an
old revision while the roots are current.

Measured read-only on production Hermes, 2026-09-25:

- checkout `HEAD` = `2e0fcfc` (#122), 6 commits behind `origin/main`; its
  `state.py` is `41bd2f9c…`, state schema **3**
- the three reconciled roots hold canonical `c80dfb8` bytes (`state.py`
  `1f1c9618…`, schema **5**), verified per-file and by the installer's directory hash
- `/opt/data/state.db`: the container checkout's `loop.py` path appears in 895
  message rows, latest `2026-09-25T01:58Z`; the shipped skill copy in 13 rows,
  latest `2026-09-21T13:55Z`
- the five parked dev-loop states in `/workspace/issue-*` are schema 3, the
  generation of that checkout

So a production dev-loop run executes a driver that predates #140, and the P0
retry-budget fix (#153) never reaches it.

## Change

1. **New `modules/hermes/scripts/refresh-codex-router-checkout.sh`** — the single
   writer for the checkout. It fetches the branch with gh's credential helper,
   fast-forwards to an optional target revision (default: the fetched head), and
   reports the resulting short SHA. It exits 0 without touching anything when the
   checkout is absent or dirty, and non-zero only when a clean checkout cannot
   fast-forward. It never stashes, resets, rebases, or forces.
2. **`modules/deploy.sh`** — inside the existing
   `should_deploy "codex-router" || should_deploy "hermes"` scope, copy the script
   into the container and run it as the checkout's owner with the revision this
   deploy checked out (`git -C "$ROOT/modules/codex-router" rev-parse HEAD`). A
   failure counts toward the deploy's `failed` total.
3. **`modules/hermes/50-seed-defaults`** — run the same script on boot as
   `hermes`, with no target so it tracks `origin/main`; a recreated container
   heals itself. Failure logs a warning and never fails the boot.
4. **Tests** — new behaviour suite
   `modules/hermes/tests/test-refresh-codex-router-checkout.sh` exercises the
   script against real repositories (up-to-date no-op, fast-forward, explicit
   target, dirty skip, diverged failure, absent skip) and pins both call sites;
   `modules/tests/test_deploy_workflow_router.py` gains
   `test_hermes_container_checkout_is_refreshed`, which pins the deploy block, the
   owning user, the script's dirty guard, and the boot call. The new suite is
   wired into the `hermes-scripts` job of `.github/workflows/test.yml`.

## Questions and answers

Q: When the checkout cannot be advanced, what should the deploy do?
A: Skip an absent or dirty checkout with a printed notice, and fail the deploy
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
A: The revision this deploy checked out (`git -C "$ROOT/modules/codex-router"
rev-parse HEAD`), not whatever `main` is at deploy time, so the running container,
the skill roots, and the checkout describe one revision. Boot has no such revision
available, so it tracks `origin/main`; a boot between deploys can be ahead of the
reconciled roots.

Q: Which identity runs the refresh?
A: The container's `hermes` user in both callers (`docker exec -u hermes`, `su -s
/bin/sh hermes -c`). Verified: the checkout is owned by `hermes`, running as root
trips git's `dubious ownership`, and root writes would leave objects the sessions
cannot extend when they create worktrees.

Q: How does the fetch authenticate?
A: An inline `-c credential.helper='!gh auth git-credential'` on the fetch,
because the image's git has no credential helper and gh is already authenticated.
Verified: `git ls-remote origin main` returns `c80dfb8` with that helper. Nothing
is persisted to git config.

Q: Can this disturb a session that is using the checkout?
A: No. The script operates on the base repository only, never on a worktree, and
skips a dirty checkout entirely; a fetch plus fast-forward leaves existing
worktrees and stashes untouched.

Q: Do other checkouts in the container need the same treatment?
A: No. Searching the session database for `dev-loop/scripts/loop.py` found this
checkout as the only repository-local driver source, plus the installed skill
copies.

## Out of scope

- The five parked schema-3 states under `/workspace/issue-*`: the current driver
  refuses them (`state schema version 3 is not 5 … archive … and run loop.py
  init`), and this change does not migrate them. They are untouched by this PR.
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
