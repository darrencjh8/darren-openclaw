# PII Wipe Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Remove every real PII literal from the `darren-openclaw` public repository — the own legal name, real account suffixes, a real transfer reference, a third-party name, and four real email addresses — sourcing the one behaviourally-load-bearing name from an env var instead of a hardcoded literal, and redact the 84 public issues/PRs that repeat them.

**Architecture:** Three independent surfaces, three different mechanisms.
(1) *Code/docs* — a deterministic one-shot remap of 17 real account suffixes to synthetic placeholders of identical digit length, plus removal of the real legal name from source comments, docstrings, README, and the Hermes skill. The one place where the name is *behaviour*, not prose, moves to a test fixture that reads `OWN_LEGAL_NAME` from the environment.
(2) *Issues/PRs* — a redaction script that rewrites 84 public bodies through `gh api`, replacing each PII literal with an explicit `[REDACTED]` marker while preserving every byte of surrounding technical text.
(3) *Prevention* — `scripts/check-no-pii.py` (written first, failing) wired into the existing `secrets-scan.yml` workflow, plus a commit-author-email gate, so a regression fails CI rather than waiting for the next audit.

**Tech Stack:** Node.js 22 / vitest (expense-tracker), Python 3.12 stdlib (CI script), `gh` CLI + REST API v3 (issue redaction), GitHub Actions, gitleaks 8.24.3.

---

## QUESTIONS

q: Does "wipe PII" include the 56 issue bodies that quote live money amounts and the 25 that name live budgets `Darren SGD` / `Darren MYR`? | a: No. You said the test files and partial account numbers are fine and asked only to shuffle the numbers; live figures stay. They are Medium, and the repo going private in Task 7 removes their public exposure. Recorded here so the reviewer does not read their absence as an oversight.
q: Are the real account suffixes to be deleted or remapped? | a: Remapped 1:1 to synthetic values of identical digit length (Task 2 table), so transfer-pair resolution and last-4 pairing relationships survive. Your answer: "can we shuffle the numbers?"
q: Must the own legal name still be *usable* by the code at runtime? | a: No production code path needs it. `normalizeIdentityName` (src/orchestrator.js:290) is pure string normalisation, and the legal-name *fact* is fetched at runtime from the private `friday-memory` repo (src/fetch-memory.js:14,43) — deliberately never from a literal. Only test fixtures need a name, and they read `OWN_LEGAL_NAME` (Task 4).
q: Should the real emails be scrubbed from commit history? | a: No. Explicitly out of scope; you chose "just set noreply identity and add a CI author-email gate" (Task 6).
q: Is flipping the repository to private part of this change? | a: Yes — you selected "Edit all 84 bodies to redact + flip repo private". Task 7 does it after the code merges, and it is a separate operator action, not a PR.
q: Does `chore/pii-wipe` conflict with in-flight work? | assumption: yes it might — issue-622, 624, 625, 629 branches and 12 other worktrees are live. This branch touches `modules/expense-tracker/tests/*` and `src/*`, so the driver must rebase onto whatever `origin/main` is at push time and re-run the full expense-tracker suite.

---

## Ground truth (verified, not assumed)

Everything below was measured on `origin/main` = `f37900e5` in a dedicated worktree at `/workspace/wt/pii-wipe` (branch `chore/pii-wipe`, clean tree).

| Surface | Count |
| --- | --- |
| Tracked-file PII literals (RED gate, current) | **43** |
| Own legal name sites in tracked files | 6 (src x3, tests x3+16 refs) |
| Real suffix occurrences in tracked files | 250 across 80 files |
| Public issues/PRs (all states) carrying PII | **84** |
| — with own legal name | 13 |
| — with third-party name `LEE ZHI WEI` | 1 (#263) |
| — with real Actual Budget UUIDs | 10 |
| — with real transfer reference | 2 (#598, #599) |
| codex-router issues/PRs carrying PII | **0** |
| Forbidden literals in git *history* | out of scope by decision |

The RED gate already exists and already fails correctly:

```
$ python3 scripts/check-no-pii.py
exit_code: 1
check-no-pii: FAIL — 43 PII literal(s) in tracked files
```

---

## Task 1: Commit the RED PII gate

**Objective:** Land the failing gate first, so every later task has an objective definition of "done" that is not my say-so.

**Files:**
- Create: `scripts/check-no-pii.py` (already written and verified RED at 43 hits — commit as-is)
- Modify: `.github/workflows/secrets-scan.yml`

**Step 1: Commit the gate alone**

```bash
cd /workspace/wt/pii-wipe
git add scripts/check-no-pii.py
git commit -m "test: add PII regression gate that fails on real literals

Scans tracked text files for 14 forbidden literals (own legal name, own
account suffixes, own transfer reference, third-party name, four real
emails). Numbers only match in an account context so test-count
assertions cannot masquerade as a leak. Exits 1 with a redacted report.
Currently RED at 43 hits; the wipe turns it green."
```

**Step 2: Wire it into CI as a required check**

Append to `.github/workflows/secrets-scan.yml`:

```yaml
    pii-literals:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v7
            - uses: actions/setup-python@v5
              with:
                  python-version: "3.12"
            - name: No real PII literals in tracked files
              run: python3 scripts/check-no-pii.py
```

**Step 3: Verify the workflow parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/secrets-scan.yml'))" && echo "YAML OK"
git add .github/workflows/secrets-scan.yml
git commit -m "ci: run the PII literal gate on every PR"
```

**Expected:** both commits clean; `python3 scripts/check-no-pii.py` still exits 1 (that is correct at this point — the gate is committed RED on purpose, and the driver re-records it as the mutation-command evidence).

---

## Task 2: Deterministic suffix remap, real -> synthetic

**Objective:** Replace all 250 real suffix occurrences with synthetic values, same digit length, no substring hazard, no collision with a value already in the repo.

**Files (80 files; the load-bearing ones):**
- Modify: `modules/expense-tracker/tests/bank-movement.test.js` (3255 x?, 869001, 310980, 9302, 4756, 5750)
- Modify: `modules/expense-tracker/tests/deterministic-orchestrator.test.js` (3255, 5750, 9001, 869001, 310980)
- Modify: `modules/expense-tracker/tests/production-incidents.test.js` (3461, 4380, 5750, 6445, 869001, 9223)
- Modify: `modules/expense-tracker/tests/suffix-facts.test.js`, `memory.test.js`, `hermes-skill.test.js`, `embedding-parity.test.js`, `ocbc-trust-transfer-hold.test.js`, `orchestrator.test.js`, `own-account-fast-transfer-598.test.js`
- Modify: `modules/expense-tracker/docs/transfer-inference-test-plan.md`
- Modify: `README.md`, `specs/001-gateway/spec.md`, `modules/hermes/skills/expense-tracker/SKILL.md`
- Modify: `docs/plans/issue-598-own-account-fast-transfer-pair.md`

**The mapping (already collision-checked, length-preserving, longest-first single pass):**

| Real | Synthetic | Real | Synthetic |
| --- | --- | --- | --- |
| 3255 | 7111 | 6445 | 2666 |
| 5750 | 7222 | 4756 | 2777 |
| 9001 | 7333 | 1149 | 2888 |
| 4380 | 7444 | 8901 | 2999 |
| 804380 | 155500 | 191149 | 344400 |
| 869001 | 166600 | 310980 | 355500 |
| 9302 | 1777 | 0980 | 3666 |
| 4605 | 1888 | | |
| 3461 | 2444 | | |
| 9223 | 2555 | | |

Two facts that make this safe, both already verified by `scripts/remap-suffixes.py` design run:
- 4 real values contain another real value as a substring (`804380`/`4380`, `869001`/`9001`, `191149`/`1149`, `310980`/`0980`) — so the script sorts longest-first and substitutes in one pass with `(?<!\d)…(?!\d)` guards, or the 6-digit leg gets truncated.
- No synthetic target contains another synthetic target, and none of the 16 targets already occurs anywhere in the repo (already-synthetic suffixes there are 1234, 1357, 2468, 4321, 5678, 9999, …).

**Step 1: Write the remap script as a reviewed, committed artifact (not a throwaway)**

Create `scripts/remap-suffixes.py`: a stdlib script holding the mapping as a literal dict, applying it longest-first with digit guards, restricted to `git ls-files` text files, idempotent (a second run is a no-op), and printing a per-token before/after count.

**Step 2: Run it and check the counts**

```bash
python3 scripts/remap-suffixes.py --dry-run     # prints the plan, changes nothing
python3 scripts/remap-suffixes.py               # applies
python3 scripts/check-no-pii.py                 # expect: 43 -> 43 minus the numeric-only hits
```

**Step 3: Run the full expense-tracker suite — this is the real check**

```bash
cd modules/expense-tracker && npm ci && npm test
```

**Expected:** the transfer-pair tests in `own-account-fast-transfer-598.test.js` still pass. They assert on the *pairing* (both legs share a reference, one leg reserves, no residual expense), not on 869001 specifically — that is why the remap preserves length and keeps the two legs distinct (`166600` vs `155500`, verified distinct).

**Step 4: Commit**

```bash
git add -A
git commit -m "test: remap real account suffixes to synthetic placeholders

17 real suffixes -> same-length synthetic values across 80 files
(250 occurrences). Longest-first with digit guards, so the 6-digit legs
(869001, 804380) are not truncated by their own 4-digit tails. Transfer-pair
resolution and last-4 pairing relationships are preserved."
```

---

## Task 3: Remove the real legal name from source, docs and the skill

**Objective:** Zero occurrences of the real name in prose, with the two genuinely illustrative examples rewritten so the code comment still teaches the rule.

**Files:**
- Modify: `modules/expense-tracker/src/bank-movement.js:340`
- Modify: `modules/expense-tracker/src/orchestrator.js:355,742,812`
- Modify: `README.md:67`
- Modify: `modules/hermes/skills/expense-tracker/SKILL.md:11,12,22,23,24`

**The three source sites are the only non-test references, and each is a comment:**

1. `bank-movement.js:340` — a verbatim DBS alert body in a block comment explaining the `To:`-mask heuristic. Rewrite the name to `ACCOUNT HOLDER`, which is the convention this repo already uses in `tests/production-incidents.test.js:6`, `tests/bank-movement.test.js:165`, and `tests/own-account-fast-transfer-598.test.js:40`:
   ```js
   //    From: ACCOUNT HOLDER
   //    To: Your DBS/ POSB account ending 4380"
   ```
2. `orchestrator.js:355` — the docstring for `masksOwnAccount`. The point is that `T*** U***` masks `Trust Bank`; the second example only needs to show a masked two-word person name, so:
   ```
   * `T*** U***` masks `Trust Bank`; `A*** B***` masks `Alice Bee`.
   ```
3. `orchestrator.js:742` — the `#592` comment describing the statement-password mnemonic. It must keep teaching the arrow-split, since `orchestrator.js:746` implements it. The mnemonic itself is PII and is separately removed in Task 4:
   ```
   // holder name, e.g. `Legal name: ACCOUNT HOLDER -> ACCOUNT (statement
   // password)`. Everything after an arrow is metadata, not part of the
   // name, so trim it before comparing or the holder never matches.
   ```

`README.md:67` and `SKILL.md:11-24` keep their worked example shape but move off the real suffix and name — Task 2 has already moved the suffix to 7111, so only the sentence shape needs review.

**Step 1: Verify no production behaviour depends on the literal**

```bash
grep -rn "CHONG JIN HENG\|Chong Jin Heng" modules/*/src/ modules/*/scripts/ 2>/dev/null
```

**Expected after the edit:** only the `normalizeIdentityName` docstring example in prose form. The gate in Task 1 is the real proof — it will go from 6 name hits to 0.

**Step 2: Run the hermes-skill test, which asserts the SKILL.md strings**

```bash
cd modules/expense-tracker && npx vitest run tests/hermes-skill.test.js
```

`tests/hermes-skill.test.js:54-55` asserts the exact strings `"Card ending 3255 belongs to Epsilon Nova Card"` and `"Account ending 5750 belongs to Epsilon Account"`. Task 2 changes the numbers, so this test **must be updated in the same commit** to the new suffixes or it goes RED. That is intended: the failing assertion is the evidence that the docs and the test move together.

**Step 3: Commit**

```bash
git add -A
git commit -m "docs: replace the real account-holder name in source comments and docs

The three source sites were illustrative examples in comments, not
behaviour: the alert-body example, the masksOwnAccount docstring, and the
#592 statement-password comment. Each is rewritten to the ACCOUNT HOLDER
convention already used by the production-incident fixtures, keeping the
rule each one teaches. No test reads these strings as literals."
```

---

## Task 4: Own legal name in tests comes from an env var, not a literal

**Objective:** The 16 test references to the real name resolve from `OWN_LEGAL_NAME` at test time, so the name is never in the repository while the tests that depend on holder-name matching still exercise real logic.

**Files:**
- Create: `modules/expense-tracker/tests/helpers/own-name.js`
- Modify: `modules/expense-tracker/tests/orchestrator.test.js` (11 sites: 2643, 2651, 2724, 2775, 2777, 2878, 2950, 3003, 3048, 3059, 3123)
- Modify: `modules/expense-tracker/tests/production-incidents.test.js:388`
- Modify: `modules/expense-tracker/.env.example`
- Modify: `modules/expense-tracker/vitest.config.js`

**Why an env var and not a constant:** the user asked for it explicitly, and it is the only mechanism that keeps the name out of git while the test still asserts against it. The fallback matters more than the variable: a test suite that fails when the var is unset is a CI red for every contributor, so the helper defaults to a synthetic name and *the assertion helpers use the same default*, meaning the tests stay deterministic in CI and self-hosted runs, and only a local run with the real var set exercises the real name.

**Step 1: Write the helper**

`modules/expense-tracker/tests/helpers/own-name.js`:

```js
/**
 * The account holder's legal name for tests.
 *
 * Real value comes from OWN_LEGAL_NAME in the environment; the default is a
 * synthetic stand-in so the suite stays green without the variable set. The
 * same constant is used by the fixture and by every assertion, so a run
 * without the variable still tests holder matching, just not against the real
 * name. Never hardcode a real name here.
 */
export const OWN_LEGAL_NAME = process.env.OWN_LEGAL_NAME || "ACCOUNT HOLDER";

/** A legal-name memory fact in the shape `orchestrator.js:739` parses. */
export const legalNameFact = (name = OWN_LEGAL_NAME, mnemonic = "ACCOUNT") =>
    `Legal name: ${name} -> ${mnemonic} (statement password)`;
```

**Step 2: Wire vitest so the env var is visible and the helper is imported**

`vitest.config.js` — no change strictly needed (vitest reads `process.env`), but add `env` so a `.env`-style local override is deterministic:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: { OWN_LEGAL_NAME: process.env.OWN_LEGAL_NAME || 'ACCOUNT HOLDER' },
  },
});
```

**Step 3: Convert the call sites**

`tests/orchestrator.test.js` — the 11 sites become:
```js
import { OWN_LEGAL_NAME, legalNameFact } from "./helpers/own-name.js";
// ...
results: [{ text: `${OWN_LEGAL_NAME} maps to Spotify payee`, score: 1 }],
// ...
merchant: OWN_LEGAL_NAME,
// ...
`You have received a PayNow/FAST transfer of SGD 1.00 from ${OWN_LEGAL_NAME} on 16-Sep-26 07:19 AM.`
```
`tests/production-incidents.test.js:388` — the comment plus the `legalFact` value both use the helper.

**Step 4: Document the variable**

Append to `modules/expense-tracker/.env.example`, under the existing "Logging & Personalization" block:

```
# Account holder's legal name, used by tests only. Leave unset in CI.
# OWN_LEGAL_NAME=
```

**Step 5: Verify RED-to-GREEN on the gate, and the suite**

```bash
cd /workspace/wt/pii-wipe
python3 scripts/check-no-pii.py     # name hits 6 -> 0
cd modules/expense-tracker && npm test
OWN_LEGAL_NAME="<redacted>" npm test  # same suite, real-name path
```

Both runs must be green. The second proves the env path works, not just the fallback.

**Step 6: Commit**

```bash
git add -A
git commit -m "test: source the account-holder name from OWN_LEGAL_NAME

The 11 orchestrator fixtures and the #592 production-incident fixture
hardcoded the real legal name. They now read it from OWN_LEGAL_NAME via
tests/helpers/own-name.js, defaulting to a synthetic name so the suite is
green in CI. The helper and the assertions share one constant, so a run
without the variable still exercises holder-name matching."
```

---

## Task 5: Redact the 84 public issues/PRs

**Objective:** No public issue or PR body repeats a real name, account suffix, transfer reference, third-party name, or real Actual Budget UUID.

**Files:**
- Create: `scripts/redact-issues.py` (committed, re-runnable, idempotent)
- Create: `docs/pii-redaction-map.md` (the audit trail: item -> class -> replacement, no real values)

**In scope, by class:**

| Class | Items | Replacement |
| --- | --- | --- |
| Own legal name | 13 | `[REDACTED: legal name]` |
| Third-party name | 1 (#263) | `[REDACTED: third-party name]` |
| Real transfer reference | 2 (#598, #599) | `[REDACTED: transfer ref]` |
| Real Actual Budget UUIDs | 10 | `[REDACTED: ab-object-id]` |
| Real account suffixes | 21 items, 16 distinct values | synthetic target from the Task 2 table |
| Live money amounts | 56 | **left as-is** (per QUESTIONS q1) |
| Live budget names | 25 | **left as-is** (per QUESTIONS q1) |

**Step 1: Write the script with a dry-run default**

`scripts/redact-issues.py` must:
- read the same `FORBIDDEN` table from `scripts/check-no-pii.py` (import it, single source of truth);
- enumerate issues **and** PRs across `open` and `closed` via `gh api --paginate`;
- apply, per class, a *contextual* replacement: suffixes only in an account context, so `5750 tests` in a test-count table survives; the name only as a whole-token match;
- **default to `--dry-run`**, writing a per-item diff to `docs/pii-redaction-map.md`;
- require `--apply` to mutate anything, and use `PATCH /repos/{owner}/{repo}/issues/{number}` (PRs are issues to that endpoint).

**Step 2: Dry-run and read every one of the 84 diffs**

```bash
python3 scripts/redact-issues.py --dry-run
```

**Step 3: Read the diff yourself before applying.** A redactor that silently mangles a reproduction case in issue #598 destroys the thing that made the bug report valuable. Every non-PII byte must be unchanged.

**Step 4: Apply, then verify against the API**

```bash
python3 scripts/redact-issues.py --apply
python3 - <<'PY'
import json,subprocess,re
out=subprocess.run(["gh","api","--paginate","/repos/darrencjh8/darren-openclaw/issues?state=all&per_page=100"],capture_output=True,text=True).stdout
bad=[i["number"] for i in json.loads(out) if re.search(r"(?i)chong\s+jin\s+heng|LEE ZHI WEI|2609230019902668",i.get("body") or "")]
print("residual:",bad or "none")
PY
```

**Honest limitation to state in the PR body:** GitHub retains issue edit history, and the pre-edit body remains retrievable through the timeline API. This reduces exposure; it does not erase it. Task 7 is what actually makes the residual non-public.

**Step 5: Commit**

```bash
git add scripts/redact-issues.py docs/pii-redaction-map.md
git commit -m "chore: add the issue/PR PII redactor and its audit map

84 public items carry real PII. The script defaults to --dry-run, imports
the forbidden-literal table from the CI gate so there is one source of
truth, and rewrites only the PII tokens. Money amounts and budget names are
deliberately untouched per the plan's recorded decision. The map records
item -> class -> replacement and contains no real values."
```

---

## Task 6: Stop the bleed at the source — noreply identity + CI email gate

**Objective:** No future commit carries a real author or committer email, and a PR that introduces one fails CI.

**Files:**
- Create: `scripts/check-author-emails.py`
- Modify: `.github/workflows/secrets-scan.yml`

**Step 1: Write the gate**

`scripts/check-author-emails.py` reads `git log origin/main..HEAD --format=%an|%ae|%cn|%ce` and fails on any email that is not `users.noreply.github.com`, with a report naming the offending commits. The local identity change is a host-level `git config`, not a repository file, so it cannot be committed — state that in the PR body and give Darren the exact command:

```bash
git config user.name  "Darren Chong"
git config user.email "darrencjh8@users.noreply.github.com"
git config --global user.email "darrencjh8@users.noreply.github.com"
```

**Step 2: Add the step to the existing `secrets-scan.yml` job group** (same pattern as Task 1's `pii-literals` job).

**Step 3: Prove the gate bites before trusting it**

```bash
git commit --allow-empty -m "test: author email gate probe"   # with the real email still configured
python3 scripts/check-author-emails.py                        # must FAIL, naming the probe commit
git config user.email "darrencjh8@users.noreply.github.com"
git reset --soft HEAD~1 && git commit -m "test: author email gate probe"
python3 scripts/check-author-emails.py                        # must PASS
```

**Step 4: Commit**

```bash
git add scripts/check-author-emails.py .github/workflows/secrets-scan.yml
git commit -m "ci: fail a PR whose commits carry a real author email

History is out of scope by decision (no filter-repo, no force-push), so
this gates the forward path: only users.noreply.github.com author or
committer emails pass. Identity change itself is a host-level git config and
is documented in the PR body rather than committed."
```

---

## Task 7: Flip the repository private (operator action, after merge)

**Objective:** The pre-redaction history, the unedited commit metadata, and the retained issue edit history stop being publicly reachable.

**Not a PR.** It is a repository setting and it happens after this branch merges, so CI has already proven the tree is clean.

```bash
gh repo edit darrencjh8/darren-openclaw --visibility private --accept-visibility-change-consequences
```

**Step 2: Verify**

```bash
gh api repos/darrencjh8/darren-openclaw --jq '.visibility'   # expect: private
```

**Note on reversibility:** this is reversible with the same flag set to `--visibility public`, and it does not touch git history, branches, or CI configuration. It does change who can read the repository, so if the public visibility was intentional for portfolio reasons, that trade-off is Darren's to make explicitly — I will not flip it unannounced.

---

## Files likely to change (summary)

| Path | Tasks | Why |
| --- | --- | --- |
| `scripts/check-no-pii.py` | 1 | the gate |
| `scripts/remap-suffixes.py` | 2 | the remap, committed not throwaway |
| `scripts/redact-issues.py` | 5 | the redactor, dry-run default |
| `scripts/check-author-emails.py` | 6 | the forward gate |
| `.github/workflows/secrets-scan.yml` | 1, 6 | two new jobs |
| `modules/expense-tracker/src/{orchestrator,bank-movement}.js` | 3 | comments only, 3 sites |
| `modules/expense-tracker/tests/*.test.js` (7 files) | 2, 4 | suffixes + env-sourced name |
| `modules/expense-tracker/tests/helpers/own-name.js` | 4 | new helper |
| `modules/expense-tracker/{vitest.config.js,.env.example}` | 4 | env plumbing |
| `README.md`, `SKILL.md`, `specs/001-gateway/spec.md`, `docs/**` | 2, 3 | suffix remap + name removal |
| `docs/pii-redaction-map.md` | 5 | audit trail |

**Test surface:** `modules/expense-tracker` `npm test` (the whole vitest suite, which is where every behavioural assertion lives), plus `python3 -m unittest discover -s modules/tests` and the hermes bash tests if `modules/hermes` is touched (it is not, except for the SKILL.md string that `hermes-skill.test.js` asserts).

## Risks and tradeoffs

1. **A test that asserts a literal suffix breaks.** `hermes-skill.test.js:54-55` is the known one. The remap must land with the assertion update in the same commit, and the full vitest run is the gate — not the PII script.
2. **A remap that truncates a 6-digit leg.** Mitigated by longest-first ordering and digit guards; `166600` vs `155500` verified distinct so transfer-pair tests still see two different accounts.
3. **The redactor damages a reproduction.** The dry-run default plus human review of all 84 diffs is the control. Issue #598's verbatim alert body is the highest-risk item and must be read line by line.
4. **Editing an issue body is not erasure.** Stated in the PR body; Task 7 is the actual mitigation.
5. **The gate has false positives.** Numeric tokens are matched only in account context, and substring tokens (`CHON` inside `CHONG JIN HENG`) are suppressed. If a legitimate test-count line trips it, the fix is to widen the context regex — never to weaken the token list.
6. **Scope disagreement on money amounts.** 56 items keep live figures by decision. If Darren later wants those too, `scripts/redact-issues.py` gains a class and re-runs; the code side is unaffected.
7. **Branch contention.** 12 live worktrees touch `modules/expense-tracker/tests/`. Expect rebase conflicts on the test files; resolve in favour of the newer `origin/main` content plus the remap, and re-run the full suite.

## Open questions for the operator

- Should `chore/pii-wipe` be split into (a) gate + remap + name, (b) issue redaction, (c) CI gates? Three smaller PRs review faster and Task 5 mutates 84 public items that deserve their own diff.
- Task 7 flips visibility. Confirm you want private, or say so and I will leave it public and mark Task 7 as your manual step.
- Should the private `friday-memory` repo be audited in the same pass? It holds the live legal-name fact and the real account map by design; out of scope here, but it is the one place the real name legitimately lives.
