# Testing

`.github/workflows/test.yml` (`Unit Tests`) is the gate. It triggers on
`pull_request` **targeting `main`** — not on PRs aimed at other branches — and
`deploy.yml` also calls it via `workflow_call` before deploying on non-push
events, gating on that result not being a `failure`. Every job below is a real job
in that workflow — keep this page in step with it. One job is
`continue-on-error`, so "CI is green" is not the same as "every suite passed"; the
table says which.

## The jobs

| Job | Working directory | Command | Needs |
|---|---|---|---|
| `expense-tracker` | `modules/expense-tracker` | `npm test` (`vitest run`) | `poppler-utils`, `qpdf` (apt) |
| `actual-api` | `modules/actual-api` | `npm test` (`jest`) | — |
| `portfolio-tracker` | `modules/portfolio-tracker` | `npm test` (`vitest run`) | — (job is `continue-on-error`: it needs IBKR keys and live services, so a red result does **not** block the merge — read it, but do not report it as blocking) |
| `pp-cli` | `modules/portfolio-tracker/pp-cli` | `mvn test` | the Portfolio Performance model JAR, installed to the local Maven repo first |
| `compose-config` | repo root | `docker compose config` on each compose file | Docker Compose |
| `hermes-scripts` | repo root | `shellcheck`, then ten `modules/hermes/tests/*.sh` scripts, then three `unittest` modules | `shellcheck` (apt), PyYAML |
| `image-gen` | `modules/image-gen` | `node --test __tests__/server.test.js` | — |

Two more workflows guard things that are not unit tests: `secrets-scan.yml`
(gitleaks) and `codex-router-ci.yml` (the separate router repository's suite —
see [operations.md](operations.md)).

There are eleven `*.sh` files in `modules/hermes/tests/` but only ten run in
CI: `test-skills-backup-restore.sh` is not wired into a step, so a change to it
can pass review with nothing exercising it.

## Running them locally

Run one module's suite from its own directory; `npm ci` first if `node_modules`
is missing:

```bash
cd modules/expense-tracker && npm ci && npm test
cd modules/actual-api      && npm ci && npm test
cd modules/portfolio-tracker && npm ci && npm test
cd modules/image-gen       && node --test __tests__/server.test.js
```

The Python suites are plain `unittest`, so point them at the repo root so the
`modules.hermes.tests` package path resolves:

```bash
python -m unittest discover -s modules/tests -p 'test_*.py'
python -m unittest modules.hermes.tests.test_slack_platform -v
python -m unittest modules.hermes.tests.test_log_issue_triage_collect \
                  modules.hermes.tests.test_log_issue_triage_cron -v
```

The Hermes bash suites are standalone and self-checking:

```bash
bash modules/hermes/tests/test-deploy.sh
bash modules/hermes/tests/test-50-seed-defaults.sh
bash modules/hermes/tests/test-codex-router-skills-sync.sh
```

`pp-cli` needs the model JAR in the local Maven repo before `mvn test`; copy
the install step from the `pp-cli` job in `test.yml` rather than guessing it.

## Conventions

- **JavaScript suites** are `vitest` (except `actual-api`, which is `jest`).
  Fixtures are checked into `__tests__/` and `tests/`.
- **Python suites** are stdlib `unittest`; no pytest, no third-party runner.
  Dependencies are limited to PyYAML, which is what parses the Hermes YAML.
- **Bash suites** print their own result and exit non-zero on failure, so they
  can be run directly as a CI step with no wrapper.
- **Product dependencies belong in a Dockerfile.** If a test needs a tool that
  is missing locally, add it to the relevant `Dockerfile` and let CI/CD deploy
  it rather than installing it by hand.

## Fixture policy

Transaction tests use verbatim production email and statement bodies, including
real UIDs, account suffixes and reference numbers, because a synthesised alert
does not exercise the parser that a real one hits. Redaction, when it is
applied, preserves the shape that makes the test work: names, amounts and
suffixes stay, and a redacted account keeps its last four digits so pair-matching
still resolves.
