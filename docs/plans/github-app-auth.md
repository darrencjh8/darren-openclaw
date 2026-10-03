QUESTIONS
q: Should refresh scheduling run inside the Docker container rather than host cron? | a: Yes; use Hermes cron with a script-only job because Hermes cron state is persisted under /opt/data and the scheduler runs in the container.
q: Should App credentials take precedence over FRIDAY_PAT at boot? | a: Yes; when all three GH_APP_* variables are present, App auth is authoritative; FRIDAY_PAT is fallback only when App configuration is incomplete.
q: Should a stale existing gh credential block App refresh? | a: No; boot and refresh must replace the gh credential atomically after successfully minting a new installation token.
q: Which repositories should the installation cover? | a: All repositories in Darren's account, including the archived KTMB repository; GitHub may still enforce archived-repository write restrictions.

# GitHub App authentication for Hermes

## Goal

Make GitHub CLI authentication transparent inside the Hermes container, using the existing GitHub App installation token flow with automatic renewal. Preserve a PAT fallback for environments where the App configuration is incomplete, but never let a configured App be silently overwritten by `FRIDAY_PAT`.

## Change scaffold

- `modules/hermes/scripts/github-auth.sh`: existing App JWT and installation-token helper; extend it to authenticate the `hermes` user's gh CLI configuration safely and idempotently.
- `modules/hermes/50-seed-defaults`: replace the unconditional PAT boot login with App-first initialization and fallback behavior; seed the refresh cron job.
- `modules/hermes/tests/test-github-auth.sh`: add deterministic tests for missing/incomplete configuration, token parsing, expiry handling, and credential replacement without contacting GitHub.
- `modules/hermes/tests/test-50-seed-defaults.sh`: add seed assertions for App-first auth and the script-only refresh job.
- `modules/docker-compose.yml` and `.github/workflows/deploy.yml`: only change if validation shows the already-present GH_APP variables are not delivered to the Hermes runtime; do not duplicate secrets.

## Implementation

1. Refactor the existing helper around one safe refresh path:
   - validate all required App variables before making a request;
   - mint a JWT with the configured App ID and private key;
   - request an installation token and parse `token` plus `expires_at` from the response;
   - feed the token to `gh auth login --with-token` as the actual runtime user, never log it, and keep credential files mode `0600`;
   - use a temporary file in the target directory and an atomic replace where a file is written;
   - return non-zero on malformed responses or failed authentication so cron records the failure.
2. Make boot initialization idempotent and precedence-aware:
   - App configuration complete: run the App helper and do not invoke PAT login;
   - App configuration incomplete and `FRIDAY_PAT` present: retain the PAT fallback;
   - neither usable: leave existing credentials untouched and emit a safe warning.
3. Seed a Hermes cron job named `github-app-auth-refresh`:
   - every 15 minutes;
   - `no_agent: true`, `script: github-auth.sh`, `deliver: local`;
   - update an existing job in place so the schedule and script cannot drift after redeploy;
   - do not include a prompt or token output.
4. Keep GitHub CLI call sites repository-explicit. Do not introduce `/user` calls that an installation token cannot authorize.

## Verification

- Run the shell tests for `github-auth.sh` and `50-seed-defaults` using temporary HOME/data paths and fake API/gh executables; assert no secret is printed and replacement is atomic.
- Run the real helper once with the configured App in the isolated worktree/container environment, verify the installation endpoint and one repository-scoped `gh` command, and do not print token material.
- Run repository validation for the changed shell/config files and inspect the final diff for credentials, unsafe permissions, and PAT-overwrite regressions.
- Use the latest canonical dev-loop from `codex-router` commit `89871726252ce72083c6cbf31f850c2d799383c6`; obtain plan approval, RED/GREEN tests, two exact-HEAD independent review approvals, CI, and merge through the normal PR path.

## Non-goals

- Do not create a long-lived GitHub access token; installation tokens remain GitHub-capped short-lived credentials.
- Do not change GitHub branch protection or author identity behavior.
- Do not deploy or restart production manually; CI/CD remains the deployment path.
