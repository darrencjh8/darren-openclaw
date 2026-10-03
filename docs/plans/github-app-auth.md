# Plan: Transparent GitHub App auth for `gh`

## Goal

Make GitHub CLI authentication inside the Hermes container transparently use the
`friday-coder-bot` GitHub App installation wherever the App credentials are
configured, while preserving the existing PAT only for the separate legacy
codex-router checkout refresh. Keep all changes reviewable and deployable through
PR and CI/CD.

## Questions and decisions

- App tokens are installation-scoped and cannot enumerate `/user/repos`; all CLI
  calls must remain repository-explicit.
- Installation tokens are short-lived; GitHub caps their lifetime, so Hermes
  refreshes them through a 15-minute no-agent cron job.
- Archived repositories are in scope. Installation access is verified against
  each explicitly named repository, including `openclaw-module-ktmb`.
- The legacy codex-router checkout refresh remains PAT-backed, but the PAT is
  scoped to that one boot command rather than exported as `GH_TOKEN` for every
  Hermes process.

## Implementation

1. Refactor the existing helper around one safe refresh path:
   - exit 0 with a skip log and no alert when App configuration is incomplete (any of GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY unset); return non-zero only on attempted-but-failed mint/auth/parse (bad key, malformed API response, failed gh login);
   - validate all required App variables before making a request;
   - mint a JWT with the configured App ID and private key;
   - request an installation token by sending the JWT as the HTTP authorization bearer credential on the wire (redact the JWT value only in log output) and parse `token` plus `expires_at` from the response;
   - authenticate the `hermes` user via `su -s /bin/sh hermes -c "gh auth login --with-token"`, never log the token, and keep credential files mode `0600` owned by hermes — exact files: the hermes user's gh `hosts.yml` plus `/opt/data/.gh_token` if retained (write via `install -o hermes -g hermes -m 600` or chown after write); remove or rotate the stale mode-644 `/opt/data/.gh_token` regardless of owner;
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
5. Prevent credential precedence regressions:
   - remove `GH_TOKEN=${FRIDAY_PAT}` from the Hermes service environment because gh gives it precedence over stored App credentials;
   - pass `FRIDAY_PAT` only to the baked codex-router checkout refresh command;
   - pin the auth helper to `HOME=/opt/data/home` and its matching `GH_CONFIG_DIR`, then explicitly switch gh to the App login after `gh auth login --with-token`.

## Verification

- RED control test ids (must fail at base, pass at HEAD): `T-precedence` (App-first, PAT not invoked when App vars complete), `T-atomic-replace` (flat-file temp-plus-rename, no partial write), `T-no-secret-output` (token never printed). Run via `bash modules/hermes/tests/test-github-auth.sh` and `bash modules/hermes/tests/test-50-seed-defaults.sh` with temporary HOME/data paths and fake API/gh executables; pin `shellcheck` and `bash -n` on changed shell files.
- Verify Compose does not export ambient `GH_TOKEN`, the boot refresh scopes `FRIDAY_PAT`, and the helper selects the App account.
- Advisory only (not CI evidence): one live run of the helper with the configured App in the isolated worktree/container environment, verifying the installation endpoint and one repository-scoped `gh` command without printing token material.
- Inspect the final diff for credentials, unsafe permissions, and PAT-overwrite regressions.

## Non-goals

- Do not create a long-lived GitHub access token; installation tokens remain GitHub-capped short-lived credentials.
- Do not change GitHub branch protection or author identity behavior.
- Do not deploy or restart production manually; CI/CD remains the deployment path.
