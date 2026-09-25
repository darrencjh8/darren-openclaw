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
  no credentials, but a rewritten one could break it.

So a production dev-loop run executes a driver that predates #140, and the P0
retry-budget fix (#153) never reaches it.

## Change

### 1. New `modules/hermes/scripts/refresh-codex-router-checkout.sh`

One writer for the checkout. Inputs and interface, exactly:

- `CHECKOUT=${CODEX_ROUTER_CHECKOUT:-/workspace/codex-router}` — the path override
  the behaviour suite drives the script through.
- `BRANCH=${CODEX_ROUTER_BRANCH:-main}` — the only branch it will move; the suite
  hard-codes `main`.
- `LOCK_WAIT_SECONDS=${CODEX_ROUTER_LOCK_WAIT_SECONDS:-120}` — the lock bound.
- `TARGET_REV="$1"`, optional. With it, the checkout must end at that revision;
  without it, at the fetched head.

Order of operations, which is the whole contract:

1. If `$CHECKOUT/.git` is not a directory, print `no checkout at <path>; skipping`
   and exit 0. The lock file lives inside `.git`, so this guard must come first:
   acquiring the lock before it would fail the redirection and exit non-zero for a
   path the script promises to skip.
2. Acquire `flock` on `$CHECKOUT/.git/codex-router-checkout.lock`, waiting up to
   `LOCK_WAIT_SECONDS` (inside `.git`, so it never appears as untracked work). On
   timeout: print `another writer held <path> for <n>s; giving up` and exit 1,
   leaving every ref untouched. Taking the lock here — after the checkout is known
   to be a repository, before any state is read — is what makes the next two checks
   act on state no other writer can move.
3. Inside the lock, re-read the state: a dirty checkout (`git status --porcelain`
   non-empty) prints `<path> is dirty; leaving it alone` and exits 0; a checkout
   whose `git symbolic-ref --quiet --short HEAD` is not `BRANCH` prints
   `<path> is on '<branch>', not <branch>; leaving it alone` and exits 0. Both are
   a live session's state and are never stashed, reset, rebased, or forced.
4. Fetch: `git -c credential.helper='!gh auth git-credential' fetch --quiet origin
   "$BRANCH"`. This updates `refs/remotes/origin/$BRANCH` and writes `FETCH_HEAD`;
   the no-argument case below advances to `FETCH_HEAD`, i.e. the head of that
   branch at fetch time. A fetch failure exits 1.
5. Move `HEAD`, only by fast-forward:
   - with a target: a target that is not a commit in the fetched history
     (`git cat-file -e "$TARGET^{commit}"`) exits 1; a target `HEAD` already
     contains (`git merge-base --is-ancestor "$TARGET" HEAD`) is a no-op that exits
     0, because boot can already have advanced past the revision a later deploy
     pins; otherwise `git merge --ff-only --quiet "$TARGET"`, and its failure exits
     1;
   - without a target: `git merge --ff-only --quiet FETCH_HEAD`, and its failure
     exits 1.
6. Print the resulting `git rev-parse --short HEAD` so a deploy log shows what the
   container is on (the verification step below reads it).

It runs as the container's `hermes` user, never touches a worktree, and contains no
`reset`, `stash`, `rebase`, `checkout -f`, `push --force`, or `worktree` verb.

### 2. `modules/deploy.sh`

A new block marked `# ---- Hermes container codex-router checkout ----`, inside the
existing `should_deploy "codex-router" || should_deploy "hermes"` scope (the same
scope as the skill reconcile, so the 5-minute `sync-codex-router.yml` router-only
dispatch reaches it). It:

- guards the host-side checkout (`[ ! -d "$ROOT/modules/codex-router" ]`), the
  script, and the container (`docker inspect hermes`), each printing a notice and
  skipping — in CI a missing checkout counts toward `failed`;
- waits for the container the way the sibling block above does (up to 15 × 2s
  `docker exec hermes true`), because a `hermes` deploy recreates it and `docker
  exec` during init returns non-zero; the sibling's own poll is not enough, its
  result is not reused here;
- copies the script in (`docker cp` to `/tmp`) and runs it as the checkout's owner
  (`docker exec -u hermes hermes sh /tmp/refresh-codex-router-checkout.sh
  "$CHECKOUT_TARGET"`), with `CHECKOUT_TARGET=$(git -C "$ROOT/modules/codex-router"
  rev-parse HEAD)`;
- counts any failure toward `failed` unconditionally, matching the sibling block's
  counter; production deploys always run in CI, so this is the same outcome on the
  path that matters, and a local run still reports it;
- removes the copied script afterwards.

The environment is therefore **advanced to at least the deployed revision**: the
container checkout is never behind what the deploy shipped, but a boot between
deploys can leave it ahead of the reconciled roots, which is why the target case
treats an already-contained revision as satisfied rather than as an error.

### 3. `modules/hermes/50-seed-defaults`

Run the same refresh on boot as `hermes` (`su -s /bin/sh hermes -c`), with no target
so it tracks `origin/main`; a recreated container heals itself. It runs the
image-baked copy `/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh`
(`COPY scripts/` in the Dockerfile, plus `chmod +x`): that copy changes exactly when
the hermes image is rebuilt, which is when this hook changes, while the deploy's own
`docker cp` copy is what refreshes the container between rebuilds. The call carries
a fallback (`|| echo "WARNING: could not advance the codex-router checkout …"`), so
a failed refresh logs and never fails the boot, and it appends to the same
`/opt/data/logs/codex-router-skills-sync.log` the reconcile writes.

### 4. Tests and docs

`modules/hermes/tests/test-refresh-codex-router-checkout.sh` drives the script
against real repositories through `CODEX_ROUTER_CHECKOUT`:
up-to-date no-op; fast-forward to `FETCH_HEAD`; an explicit target that must land
`HEAD` on that revision and *away* from the fetched head; a target `HEAD` already
contains (no-op); dirty skip with the work intact; wrong-branch skip; diverged
failure; a target missing from the fetched history; and a busy lock
(`CODEX_ROUTER_LOCK_WAIT_SECONDS=1` with the lock held) that must exit non-zero
with every ref unchanged. It also pins both call sites, with the scope and marker
assertions kept out of the sibling block's text.

`modules/tests/test_deploy_workflow_router.py::test_hermes_container_checkout_is_refreshed`
pins the deploy block (scope, marker, guards, readiness poll, `rev-parse HEAD`
target, `docker exec -u hermes`, `failed` counter), the script (executable; dirty,
branch and lock guards; `--ff-only`; `credential.helper`; no destructive or
`worktree` verb), and the boot call (owner, baked path, never-fail-the-boot
fallback). The new suite is wired into the `hermes-scripts` job of
`.github/workflows/test.yml`, and `DEPLOY.md`'s inventory of the scripts that
reconcile the container gains the refresh.

## Questions and answers

Q: When the checkout cannot be advanced, what should the deploy do?
Assumption: Skip an absent, dirty, or other-branch checkout with a printed notice,
and fail the deploy when a clean checkout cannot reach the target — including a lock
that stays held past `LOCK_WAIT_SECONDS`, which exits non-zero because a silent skip
would report success with nothing verified. (Planner-inferred: the operator selected
the boot-parity and scope questions and left this one to this recommendation.)

Q: Should the refresh also run at container boot?
A: Yes. (Operator-selected.) The boot hook runs the same script as `hermes` with no
target, tracking `origin/main`, so a recreated container heals itself.

Q: Which deploys refresh the checkout?
A: Both a router-only deploy (`components=codex-router`) and a `hermes` deploy.
(Operator-selected.) That is the same scope as the skill reconcile.

Q: Which revision does the deploy target?
Assumption: The revision this deploy checked out (`git -C
"$ROOT/modules/codex-router" rev-parse HEAD`), not whatever `main` is at deploy
time, so the checkout is advanced to at least the deployed revision — not to exactly
one revision, because boot may already have moved it ahead of the reconciled roots.
(Planner-inferred, not operator-confirmed.)

Q: Which identity runs the refresh?
Assumption: The container's `hermes` user in both callers (`docker exec -u hermes`,
`su -s /bin/sh hermes -c`). (Planner-inferred, not operator-confirmed.) Verified: the
checkout is owned by `hermes`, running as root trips git's `dubious ownership`, and
root writes would leave objects the sessions cannot extend when they create
worktrees.

Q: How does the fetch authenticate?
Assumption: An inline `-c credential.helper='!gh auth git-credential'` on the fetch,
because the image's git has no credential helper and gh is already authenticated.
(Planner-inferred, not operator-confirmed.) Verified: `git ls-remote origin main`
returns `c80dfb8` with that helper. Nothing is persisted to git config.

Q: Can this disturb a session that is using the checkout?
Assumption: No. (Planner-inferred, not operator-confirmed.) The script operates on
the base repository only, never on a worktree, skips a dirty or other-branch
checkout entirely, and holds its lock across the fetch and the merge; a fetch plus
fast-forward leaves existing worktrees and stashes untouched.

Q: Do other checkouts in the container need the same treatment?
Assumption: No. (Planner-inferred, not operator-confirmed.) Searching the session
database for `dev-loop/scripts/loop.py` found this checkout as the only
repository-local driver source, plus the installed skill copies.

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
- `DEPLOY.md` names the refresh beside the other container-reconciling scripts
- after merge the deploy log must print the checkout's new short SHA, and a fresh
  session's driver path must resolve to the deployed revision
