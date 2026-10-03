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
- `modules/docker-compose.yml` and `.github/workflows/deploy.yml`: expected outcome is no change — all three GH_APP vars are already wired (compose L232-234, deploy L127/166-167). Close this conditional with `grep -n GH_APP_ID modules/docker-compose.yml .github/workflows/deploy.yml` only; do not duplicate secrets.

## Implementation

1. Refactor the existing helper around one safe refresh path:
   - exit 0 with a skip log and no alert when App configuration is incomplete (any of GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY unset); return non-zero only on attempted-but-failed mint/auth/parse (bad key, malformed API response, failed gh login);
   - validate all required App variables before making a request;
   - mint a JWT with the configured App ID and private key;
   - request an installation token by sending `Authorization: Bearer $JWT` on the wire (redact the value only in log output) and parse `token` plus `expires_at` from the response;
   - authenticate the `hermes` user via `su -s /bin/sh hermes -c "gh auth login --with-token"`, never log the token, and keep credential files mode `0600` — exact files: the hermes user's gh `hosts.yml` plus `/opt/data/.gh_token` if retained; remove or rotate the stale mode-644 root-owned `/opt/data/.gh_token`;
   - restrict atomic temp-file-plus-rename replacement to flat files only (e.g. `/opt/data/.gh_token`); never hand-edit gh-managed `hosts.yml` — write it only through `gh auth login`, which owns that format.
2. Make boot initialization idempotent and precedence-aware:
   - App configuration complete: run the App helper and do not invoke PAT login;
   - App configuration incomplete and `FRIDAY_PAT` present: retain the PAT fallback;
   - neither usable: leave existing credentials untouched and emit a safe warning.
3. Seed a Hermes cron job named `github-app-auth-refresh`:
   - every 15 minutes;
   - `no_agent: true`, `script: github-auth.sh`, `deliver: local`;
   - update in place following the existing portfolio-job migration pattern, so the schedule and script cannot drift after redeploy;
   - rewrite the stale hardcoded `github-auth-refresh`/50m insert-only snippet in `test-50-seed-defaults.sh` (currently L44-69) to the new name/interval plus migration assertions;
   - do not include a prompt or token output.
4. Keep GitHub CLI call sites repository-explicit. Do not introduce `/user` calls that an installation token cannot authorize.

## Verification

- RED control test ids (must fail at base, pass at HEAD): `T-precedence` (App-first, PAT not invoked when App vars complete), `T-atomic-replace` (flat-file temp-plus-rename, no partial write), `T-no-secret-output` (token never printed). Run via `bash modules/hermes/tests/test-github-auth.sh` and `bash modules/hermes/tests/test-50-seed-defaults.sh` with temporary HOME/data paths and fake API/gh executables; pin `shellcheck` and `bash -n` on changed shell files.
- Advisory only (not CI evidence): one live run of the helper with the configured App in the isolated worktree/container environment, verifying the installation endpoint and one repository-scoped `gh` command without printing token material.
- Inspect the final diff for credentials, unsafe permissions, and PAT-overwrite regressions.

## Non-goals

- Do not create a long-lived GitHub access token; installation tokens remain GitHub-capped short-lived credentials.
- Do not change GitHub branch protection or author identity behavior.
- Do not deploy or restart production manually; CI/CD remains the deployment path.
