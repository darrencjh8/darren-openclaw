QUESTIONS
q: Fix pull() or move signal? | a: Fix pull() - it alone hardcodes "ok".
q: Skip sheet write on pull fail? | assumption: No - out of scope; see #627.
q: Test asserting "ok" on failure? | a: It enshrines the bug; becomes RED.
q: Fix MCP text surface too? | a: Yes - pull/push line in formatSyncResult.
q: Non-zero exit on dead leg? | assumption: No - visibility only; alerting in #627.

## Question detail

Full reasoning for the five declared questions above, kept out of the `QUESTIONS` prefix so the
judged window stays short.

**1. Fix `pull()` status, or keep `"ok"` and move the signal elsewhere?**
Fix the status. `push()` two methods below already derives `status` from `result.success`
(`java_bridge.js:428`), and the MCP `pp-pull` / `pp-push` tool handlers do the same
(`tools.js:665`, `tools.js:676`). `pull()` is the only path in the module that hardcodes `"ok"`
regardless of the outcome, so this is an inconsistency rather than a design decision. The
`catch` branch two lines below already returns `"error"`, so a thrown exception and a returned
failure are meant to agree.

**2. Should `_computeSyncAll()` skip the taxonomy export when the pull fails?**
Assumption: no, and deliberately out of scope. Aborting would mean a failed grant leaves
yesterday's cell values in place with no new write at all. That is a larger change to the job's
contract than this defect requires, and it needs its own decision about whether a stale cell or
no cell is the lesser evil, plus how the user is told. This fix makes the failure *visible and
machine-readable*; suppressing the write is a separate follow-up recorded in issue #627.

**3. The test at `java_bridge.test.js:351` currently asserts the defect. Update it?**
Yes, and it is the RED case. It asserts `status: "ok"` for a failed pull, so leaving it would
make the correct behaviour a test failure. It is corrected to expect `"error"` and fails against
the unfixed `java_bridge.js`, which is exactly the RED proof required. A second case asserts the
successful pull still reports `ok` / `downloaded`, so the fix cannot be satisfied by always
returning `"error"`.

**4. Should the MCP interactive text surface be fixed in this change?**

Yes. Round 1 established that `formatSyncResult()` (`mcp-server.js:15-43`) reads only `summary`,
`flex_import` and `sync_targets`, and its line-37 early return on `raw.analysis.message_body`
discards everything built before it. The corrected `pull` status would therefore never reach the
user through `portfolio_sync` — the one surface a human reads, and the one through which this
whole incident was reported. Fixing only the cron log would leave the user-visible symptom intact,
so the round stays dirty unless this is either fixed or declared out loud. It is fixed: the error
line is prepended to the *returned* analysis string, so healthy output is unchanged. Round 2
showed why the insertion point alone is not enough — see step 3.

**5. Should `portfolio-sync.sh` exit non-zero when a leg fails?**

Assumption: no, and deliberately so. The script ends in `log "sync complete"` and exits 0 today,
and the job is `deliver: local` with `no_agent: true`, so a non-zero exit surfaces as a cron error
string rather than an alert anyone reads. Changing the exit contract is a separate decision about
alerting (delivery channel, cadence) that this defect does not require; it is recorded in issue
#627. Declared here so the choice is auditable rather than made in passing.

**Note on how this step was arrived at.** Three consecutive rounds each found a real defect in
this one code block — round 2 cleared a variant, round 3 found a parse failure, round 4 found a
silent runtime failure plus a test that certified it. Every one of those rounds inspected the
block as text and reasoned about quoting. The lesson is recorded because it generalises past this
plan: for a change that moves code across a language or process boundary, the reviewable unit is
the boundary, and the only trustworthy check is executing the real thing. `bash -n` did not catch
the silent failure, the snippet-as-text review did not catch it, and a test that re-executed the
extracted block did not catch it either. What caught it was stubbing `python3` and reading the
`argv` the shell actually handed it. Step 5's test is now written to that standard for the same
reason.

**Note on the plan-approval route.** The live dev-loop `policy.json` under the agent config
directory (outside this repository; there is no `policy.json` in this worktree, and it is
untracked here) sets `human_approval_allow_agent_authored_comment: true`
and `human_approval_allow_self: true`, so the approval comment may be posted by the agent against
the driver account. It is recorded as an agent-authored / self-attested approval so the bypass
stays visible in the audit trail.

## Change scaffold

- **Files to be changed:** `modules/portfolio-tracker/src/java_bridge.js`, `modules/portfolio-tracker/src/mcp-server.js`, `modules/portfolio-tracker/tests/java_bridge.test.js`, `modules/portfolio-tracker/tests/mcp-server.test.js`, `modules/hermes/scripts/portfolio-sync.sh`, `.github/workflows/test.yml`, plus a new `modules/hermes/tests/test-portfolio-sync-output.sh`. (These are the files this change will touch, not the files that differ base..HEAD — at the plan commit the only difference is this plan file.)
- **Repository test command:** `cd modules/portfolio-tracker && npm ci && npm test` (package.json `"test": "vitest run"`). `npm ci` is required because a fresh worktree has no `node_modules`; a bare `npx vitest run` would fetch a floating vitest instead of the pinned dependency.
- **Test files in scope:** `modules/portfolio-tracker/tests/java_bridge.test.js` (existing `describe("pull")` block, lines 343-366), `modules/portfolio-tracker/tests/mcp-server.test.js`, and the new `modules/hermes/tests/test-portfolio-sync-output.sh`.
- **CI caveat:** the `portfolio-tracker` job in `.github/workflows/test.yml:42-44` carries `continue-on-error: true` ("needs IBKR keys + running services, fixing separately"). That suite is therefore a **local** gate for this change, not a CI gate — CI will stay green even if the corrected assertion regresses. The new hermes shell test is the CI-enforced one, but only once step 5 adds its step to `test.yml`; that edit is part of this change, not something the repo already does.
- **Spec in scope:** `specs/003-portfolio-tracker/spec.md` — "Taxonomy Export" (line ~372) documents that the taxonomy is written to Sheets. It does not specify pull-failure behaviour, so this change adds behaviour the spec does not yet describe.
- **Tracked issue:** #627.

## The defect

`PpJavaBridge.pull()` hardcodes `status: "ok"` and varies only `detail`:

```js
// modules/portfolio-tracker/src/java_bridge.js:343-353
async pull() {
    try {
        const result = await pullFromOneDrive();
        return {
            status: "ok",                                    // never "error" here
            detail: result.success ? "downloaded" : result.error,
        };
    } catch (e) {
        return { status: "error", detail: e.message };
    }
}
```

The consequence is not cosmetic. `_computeSyncAll()` (`tools.js:800-1076`) calls
`this._ppBridge.pull()` at line 808, logs the result, and never inspects `status`. The taxonomy
export then queries whatever stale `Portfolio.portfolio` is on disk and writes it to `B4` /
`G2:G5`. Production evidence in issue #627, with the grant expired:

```
{"event":"pp-pull","result":{"status":"ok","detail":"Token HTTP 400"}}
{"event":"pp-push","result":{"status":"error","detail":"Token HTTP 400"}}
```

One minute apart, same underlying failure. The cash-total cell was written from a frozen file in
which the loan balance was materially understated — a round-figure shortfall, consistent with a
tranche drawn or restructured after that copy was last written. The loan was always summed; it was
summed from an out-of-date balance. The whole bug is a correct formula over stale inputs.

The daily job `portfolio-daily-sync` runs `no_agent: true` with `deliver: local`, so nothing
alerted. Its output prints only `sync_targets`, and those three Actual Budget-fed accounts
reported `delta=0` precisely *because* the round trip was broken — a healthy run and a broken run
printed the same thing.

## Root cause, not symptom

The shared defect is "a failed OneDrive round trip is indistinguishable from a successful one at
the boundary." That is asserted in **three** places, so all three are fixed:

1. `java_bridge.js` `pull()` — the status value itself.
2. `portfolio-sync.sh` — the status never reaches the operator-visible job log.
3. `mcp-server.js` `formatSyncResult()` — the status never reaches the interactive
   `portfolio_sync` output, because the `raw.analysis.message_body` early return at line 37
   discards it. This is the surface a human actually reads.

Fixing only (1) would leave the cron output identical, because the script does not print the
`pull` key. Fixing only (2) would print `status: "ok"` for a failed pull. Fixing (1) and (2)
still leaves the interactive surface blind. All three are one-or-two-line changes at the
correct layer; no deeper refactor is warranted. Fixing (3) is a change to the *return shape*,
not an insertion above the early return — see step 3 for why that distinction is the whole fix.

## Implementation

### 1. `java_bridge.js` — derive the status

```js
return {
    status: result.success ? "ok" : "error",
    detail: result.success ? "downloaded" : result.error,
};
```

### 2. `portfolio-sync.sh` — print the round-trip status

The `pull` and `push` objects are already in the response body; the existing parse block just does
not print them. Extend that block with the same loop — **inside the quoted heredoc, not inside the
`python3 -c "` string** (the hazard is spelled out immediately below, and the Critical round-4
finding was this snippet being read as the code to write):

```python
# this text lives between `read -r -d '' PARSE_PROG <<'PARSE_EOF' || true`
# and `PARSE_EOF`, and is handed to python as one argument: python3 -c "$PARSE_PROG".
# Every remote leg goes in this tuple, not just the two below: pull, push,
# flex_pull, flex_import, taxonomy_export, portfolio_status. A leg the operator
# cannot see failing is the #627 defect, and enumerating only the legs one already
# knew about is how this branch produced four rounds of it. tests/leg-coverage.test.js
# pins this tuple against the payload the producer actually returns.
for leg in ('pull', 'push', 'flex_pull', 'flex_import', 'taxonomy_export',
            'portfolio_status'):
    r = data.get(leg) or {}
    print(f'  {leg}: {r.get("status", "?")} ({r.get("detail", "")})')
```

Written here the way `python3 -c "` would deliver it — that is, with the double quotes stripped —
this loop is a `SyntaxError` (`r.get(status, ?)`), and `2>/dev/null || true` would swallow it, so the
script would exit 0 having printed nothing. Pasting the plain form above into that shell string is
precisely the defect; the heredoc is the fix, not a style preference.

**The block must move out of the shell string, and this is a structural change, not a quoting
one.** `portfolio-sync.sh:29` opens `python3 -c "`, so the Python program is a shell argument and
bash performs quote removal on it before Python ever sees the text. Every quote character inside
that string is therefore destroyed or reinterpreted, and *which* way it fails depends on the form:

| form in the block | what Python actually receives | outcome |
|---|---|---|
| `print(f"  {leg}: …")` | string closes early | `bash -n` fails, script exit 2 |
| `print(f'  {leg}: {r.get("status", "?")} …')` | `r.get(status, ?)` | `SyntaxError`, swallowed, silent |

Both rows were confirmed by running the shipped script with a stub `python3` on `PATH` capturing
real `argv`. The middle row is the dangerous one: it raises a `SyntaxError`, but
`portfolio-sync.sh:41` ends in `2>/dev/null || true`, so the script exits 0 having printed
**nothing**. The change would delete a signal that works today and replace it with silence.
`bash -n` does not catch it, because bash successfully splits the string; it never validates the
Python.

A third form — writing the dict keys single-quoted inside a single-quoted f-string — looks like
the way out, and is worth ruling out explicitly, because it is not a quoting problem at all:

```python
print(f'  {leg}: {r.get('status', '?')} ({r.get('detail', '')})')
```

Those inner single quotes **close the f-string**. Nested same-quote expressions in f-strings are
PEP 701, valid only from Python 3.12; the module container runs **3.11.2**, so the line is a
`SyntaxError` there regardless of how bash handles the surrounding string. The identical line
compiles on this host's 3.13.5, which is exactly how it can look correct in review and break in
production. So the inline route needs a quoting form that is simultaneously legal Python on 3.11
and intact after bash's quote removal, and that constraint is fragile in a way that reads as
style.

The program is therefore read into a variable by a **quoted heredoc**, which performs no expansion
and no quote removal, and then passed to Python as one argument:

```bash
read -r -d '' PARSE_PROG <<'PARSE_EOF' || true
import sys, json
try:
    … the existing block, unchanged, plus the two lines above …
except Exception as e:
    print(f'  (parse error: {e})')
PARSE_EOF
echo "$BODY" | python3 -c "$PARSE_PROG" 2>/dev/null || true
```

`read -d ''` returns non-zero at EOF, hence the `|| true`; the variable is assigned regardless.
Verified end to end: the snippet reaches Python byte-identical (`r.get("status", "?")` intact),
and the same block that printed nothing under `-c "` now prints `pull: error (Token HTTP 400)`.
The body is read on the program's own stdin, so no argv placeholder is needed.

Two details that are easy to get wrong and are pinned by the test in step 5:

- `data.get(leg) or {}` rather than `data.get(leg, {})`. The response can be partial — a leg that
  never ran is absent, and `data.get(leg, {})` returns `None` for an explicit JSON `null`, so
  `r.get(...)` would raise. `or {}` makes the absent case render as `pull: ? ()` instead of
  collapsing into the block's `except`, which prints `(parse error: ...)` and hides every target
  line above it.
- The defaults `'?'` and `''` are load-bearing for the same reason: a leg present but missing
  `status` must not raise.

Failures become visible in the job output without changing the script's exit code or the
`deliver: local` contract, so no alerting change is implied.

**Ordering: step 2 must land, and be `bash -n`-clean, before step 5.** Step 5's test extracts and
executes this very block, so it inherits any parse error here and cannot go green until step 2 is
correct. The rest of the ordering is already stated in step 1: the bridge fix has to precede steps 2
and 3, or both would report `status: "ok"` for a failed pull.

### 3. `mcp-server.js` — surface the status *in the returned string*

The OneDrive error lines go in their own array, `onedriveErrs`, kept separate from `lines`.
That separation is load-bearing, not cosmetic: `lines` holds the sync summary and the
target errors, and the existing test at `mcp-server.test.js:275` asserts a healthy run
contains no sync header. Prepending `lines` to the analysis body would reintroduce it.

```js
const onedriveErrs = [];
for (const leg of ["pull", "push"]) {
    const r = raw[leg];
    if (r && r.status === "error") {
        onedriveErrs.push(`⚠️ OneDrive ${leg}: ${r.detail || "failed"}`);
    }
}
```

and the return becomes a **shape change**, not an insertion point:

```js
if (raw.analysis?.message_body) {
    return onedriveErrs.length
        ? [...onedriveErrs, raw.analysis.message_body].join("\n")
        : raw.analysis.message_body;
}
return [...onedriveErrs, ...lines].join("\n");
```

**Why the shape, and why not just "above the early return".** Round 2 proved the obvious
version is a no-op. The current function returns `raw.analysis.message_body` and never
joins `lines`, so a push into `lines` is discarded. Both the current function and that
variant were run on a dead-grant input; the outputs were byte-identical and neither
mentioned the failure. Only the return shape above survives, and the error-only condition
is what keeps a healthy run byte-identical (verified: healthy output is unchanged and
carries no sync header).

`analysis` is present in exactly the incident scenario, so the early return is on the
path for this bug: `_computeSyncAll()` builds `analysis` only when `taxonomyData` is
truthy, and the dead-grant run *did* export a taxonomy (that is how `2026!B4` was
written from the stale file). Stale file present means taxonomy data present means
analysis present means the early return fires.

### 4. `mcp-server.test.js` — both return paths

Two cases, because the two returns are genuinely different code and only one was covered:

1. `analysis.message_body` present **and** `pull.status === "error"`. The rendered text must
   contain the pull error. Fails against the current early return.
2. `analysis` **absent** and `pull.status === "error"`. The rendered text must contain the pull
   error *and* the `lines` content. This is the `return [...onedriveErrs, ...lines]` path, and it is
   live whenever `taxonomyData` is falsy (`tools.js:1016-1022` gates `analysis` on it) — a pull
   failure with no taxonomy to export, exactly the case where the user most needs to be
   told. Without this case a later refactor could drop `onedriveErrs` from that last line and
   every other planned test would still pass. Same defect shape as the round-2 `lines` finding: a
   value produced in one place and consumed in another. This case asserts the branch's **exact**
   output, not just that the error appears.

**What the byte-identity claim actually rests on.** Not the ternary, which is only the spelling of
the check. It is that the analysis branch returns `raw.analysis.message_body` *unmodified* when
the error array is empty. A healthy run's text is therefore the analysis string and nothing else,
and the only thing that could perturb it is an error line leaking in. That is why the condition is
error-only rather than a concatenation.

### 5. `modules/hermes/tests/test-portfolio-sync-output.sh` + a CI step for it

CI does **not** glob the hermes shell tests: `.github/workflows/test.yml:118-137` enumerates
**ten** explicit `- name:` / `run: bash modules/hermes/tests/test-<name>.sh` pairs, one per
file, with no matrix. Adding a test therefore requires adding a step, and the standing proof
is `modules/hermes/tests/test-skills-backup-restore.sh`, which exists in the tree and is
referenced by no workflow at all. So a new test file with no step guards nothing.

Extraction is by `python3 -c "$PARSE_PROG" 2>/dev/null || true` after the step-2 rewrite, and the
test **runs the shipped script with a stubbed `curl`**, asserting on its stdout. It must not
re-execute the extracted program on its own: a test that reads the block off disk and feeds it to
its own `python3 -c` skips bash's parse-time quote removal, which is the *only* step that mangles
the text. Such a test passes on a script that prints nothing at all, because it never reproduces
the defect it exists to catch — it certifies it. The stub is a `curl` placed first on `PATH` that
emits a fixed body; the script reads no environment variable and has no token-path knob, so the
stub alone determines what it sees. The script otherwise runs unmodified.

The test feeds two bodies and asserts on stdout:

| body | expected stdout |
|---|---|
| healthy | `pull: ok (downloaded)`, and the existing `A: ok (delta=0)` line still present |
| dead grant | `pull: error (Token HTTP 400)` |
| no `pull` / `push` keys | `pull: ? ()` — the `or {}` default, not a parse error |

The middle row is the RED case against the unmodified script, where the summary prints nothing.
The third row is there because a leg absent from the body must not fall into the block's
`except`, which would print `(parse error: …)` and hide every target line above it.

`.github/workflows/test.yml` gains a named step beside line 137:

```yaml
- name: Test portfolio-sync output
  run: bash modules/hermes/tests/test-portfolio-sync-output.sh
```

### 6. `java_bridge.test.js` — correct the assertion and add the RED case

`describe("pull")` currently asserts the defect:

```js
it("returns detail when pull returns error info", async () => {
    mockPullFromOneDrive.mockResolvedValue({ success: false, error: "Network error" });
    const result = await bridge.pull();
    expect(result).toEqual({ status: "ok", detail: "Network error" });  // wrong
});
```

It is changed to expect `status: "error"`, which is the RED case. The existing sibling case at
`java_bridge.test.js:344-349` already pins `ok` / `downloaded` and is left unchanged; it is
what prevents the fix being satisfied by always returning `error`.

## Validation

- RED: the corrected assertion fails at base — expected `{ status: "error" }`, received `{ status: "ok" }`.
- GREEN: `npm test` fully green in `modules/portfolio-tracker`, plus the hermes shell test green.
- `bash -n modules/hermes/scripts/portfolio-sync.sh` must pass before the GREEN claim — but it is
  **not sufficient on its own**, and the plan no longer leans on it. `bash -n` only checks that
  bash can split the script; it never validates the Python, so it returns 0 on a block that makes
  Python raise at runtime and the script swallow the error. The gate that actually catches this
  class is step 5's test, which runs the script. Both are listed because the first is a one-second
  check worth keeping, and the second is the one that has teeth.
- Mutation control: the recorded command is replayed at the base commit in a throwaway worktree and must exit non-zero, so a fix that does not stop the reproduction fails closed.
- The script change is verified hermetically by `modules/hermes/tests/test-portfolio-sync-output.sh` over two fixed bodies (healthy and dead-grant), asserting behaviour rather than shell text. No live-service call is part of validation.

## Out of scope

- Not changing `_computeSyncAll()` to skip the taxonomy write when the pull fails (see #627).
- Not adding alerting or changing `deliver` on the cron job.
- Not touching `pullFromOneDrive` / `pushToOneDrive`; they already return `success: false` correctly. The bug is in the caller.
- Not re-authenticating OneDrive in code; that is a user-side `/onedrive setup` action, already performed 2026-09-27.
