QUESTIONS
q: Should refresh scheduling run inside the Docker container rather than host cron? | a: Yes; use Hermes cron with a script-only job because Hermes cron state is persisted under /opt/data and the scheduler runs in the container.
q: Should App credentials take precedence over FRIDAY_PAT at boot? | a: Yes; when all three GH_APP_* variables are present, App auth is authoritative; FRIDAY_PAT is fallback only when App configuration is incomplete.
q: Should a stale existing gh credential block App refresh? | a: No; boot and refresh must replace the gh credential after successfully minting a new installation token.
q: Which repositories should the installation cover? | a: All repositories in Darren's account, including the archived KTMB repository; GitHub may still enforce archived-repository write restrictions.

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
   - define App configuration as complete only when `GH_APP_ID` and `GH_APP_INSTALLATION_ID` are non-empty decimal integers and `GH_APP_PRIVATE_KEY` is non-empty and contains a valid PEM private-key header; empty, non-numeric, or malformed values are incomplete and use the PAT fallback when available;
   - exit 0 with a skip log and no alert when App configuration is incomplete and no PAT is present; return non-zero only after a valid App configuration is selected and mint/auth/parse fails;
   - validate all required App variables before making a request;
   - mint a JWT with the configured App ID and private key;
   - request an installation token by sending the JWT as the HTTP authorization bearer credential on the wire (redact the JWT value only in log output) and parse `token` plus `expires_at` from the response;
   - authenticate the `hermes` user via `su -s /bin/sh hermes -c "gh auth login --with-token"`, never log the token, and keep gh-managed `hosts.yml` mode `0600` and hermes-owned;
   - do not retain `/opt/data/.gh_token`: feed the minted token only through the protected stdin login path and remove any stale legacy file before successful completion; no caller reads that file;
   - never hand-edit gh-managed `hosts.yml` and never use an in-place credential rewrite.
2. Make boot initialization idempotent and precedence-aware:
   - valid complete App configuration: run the App helper and do not invoke PAT login;
   - incomplete or invalid App configuration with non-empty `FRIDAY_PAT`: retain the PAT fallback;
   - neither usable: leave existing credentials untouched and emit a safe warning.
3. Seed a Hermes cron job named `github-app-auth-refresh`:
   - every 15 minutes;
   - `no_agent: true`, `script: github-auth.sh`, `deliver: local`;
   - update in place following the existing portfolio-job migration pattern, so the schedule and script cannot drift after redeploy;
   - rewrite the stale hardcoded `github-auth-refresh`/50m insert-only snippet in `test-50-seed-defaults.sh` to the new name/interval plus migration assertions;
   - do not include a prompt or token output.
4. Inventory the scoped GitHub CLI call sites before implementation. For every `gh` invocation in `modules/hermes/scripts/`, `modules/hermes/50-seed-defaults`, and related tests, either require an explicit `--repo`/`-R owner/repository` or document why it is local authentication plumbing rather than a repository operation. Ban `/user`, `/user/repos`, `gh repo list`, and current-directory repository inference for installation-token paths. Add fake-`gh` assertions for each repository operation, including `darrencjh8/codex-router`, `darrencjh8/friday-memory`, and archived `darrencjh8/openclaw-module-ktmb` where applicable.
5. Prevent credential precedence regressions:
   - remove `GH_TOKEN=${FRIDAY_PAT}` from the Hermes service environment because gh gives it precedence over stored App credentials;
   - pass `FRIDAY_PAT` only to the baked codex-router checkout refresh command;
   - pin the auth helper to `HOME=/opt/data/home` and its matching `GH_CONFIG_DIR`, then explicitly switch gh to the App login after `gh auth login --with-token`.

## Verification

- RED control mapping, each required to fail at base and pass at HEAD: `T-precedence` = `test_app_config_validation_and_pat_fallback` plus `test_app_account_selected` in `modules/hermes/tests/test-github-auth.sh`; `T-atomic-replace` = `test_atomic_credential_install` in that same harness; `T-no-secret-output` = `test_token_never_appears_in_output` there. The command is `bash modules/hermes/tests/test-github-auth.sh`; expected exit is non-zero at base and zero at HEAD. Also run `bash modules/hermes/tests/test-50-seed-defaults.sh`, `python3 modules/hermes/tests/test-seed-app-cron.py`, `bash modules/hermes/tests/test-docker-compose-env.sh`, and `bash modules/hermes/tests/test-refresh-codex-router-checkout.sh` at HEAD. Run `bash -n` on every changed shell file and pin the shellcheck version printed by `shellcheck --version` in the evidence.
- Verify Compose does not export ambient `GH_TOKEN`, the boot refresh scopes `FRIDAY_PAT`, the helper selects the App account, invalid App values take the PAT fallback, and no `.gh_token` file is retained after success or failure.
- Verify every inventory entry from step 4 with fake-`gh` argument capture; repository operations must carry an explicit owner/repository target and no captured operation may use `/user` or `/user/repos`.
- Advisory only (not CI evidence): one live run of the helper with the configured App in the isolated worktree/container environment, verifying the installation endpoint and one repository-scoped `gh` command without printing token material.
- Inspect the final diff for credentials, unsafe permissions, PAT-overwrite regressions, and stale `.gh_token` consumers.

## Non-goals

- Do not create a long-lived GitHub access token; installation tokens remain GitHub-capped short-lived credentials.
- Do not change GitHub branch protection or author identity behavior.
- Do not deploy or restart production manually; CI/CD remains the deployment path.
