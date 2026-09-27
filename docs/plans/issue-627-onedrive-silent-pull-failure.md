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

One minute apart, same underlying failure. `2026!B4` was written as `83,915.93` from a frozen
file in which `Loan` read `-6,344.22` instead of the real `-26,344.22` — an exact 20,000
shortfall that pushed the cell ~20k above its true value.

The daily job `portfolio-daily-sync` (`aee1c123bb29`, `0 12 * * *`) runs `no_agent: true` with
`deliver: local`, so nothing alerted. Its output prints only `sync_targets`, and those three
Actual Budget-fed accounts reported `delta=0` precisely *because* the round trip was broken — a
healthy run and a broken run printed the same thing.

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
not print them. Extend that block with the same loop:

```python
    for leg in ('pull', 'push'):
        r = data.get(leg) or {}
        print(f'  {leg}: {r.get("status", "?")} ({r.get("detail", "")})')
```

**The quoting is load-bearing, and this snippet is inside a bash double-quoted
string.** `portfolio-sync.sh:29` opens `python3 -c "`, and the whole Python program is one argument
to it. The two existing `print` lines use single-quoted f-strings for exactly this reason, and the
dict keys must be single-quoted to match. Writing the obvious `print(f"...")` closes the bash string
at the first inner `"`, and the script then fails to *parse* — `bash -n` reports
`syntax error near unexpected token '('` and the file exits 2. That is a parse-time failure in the
body of the `portfolio-daily-sync` cron job (`deliver: local`, `no_agent: true`), so it kills the
whole script rather than degrading one line. Round 2 reviewed a backslash-escaped variant and
called this correct; the plan's own text, pasted verbatim, is a syntax error. Verified both ways:
verbatim exits 2, the single-quoted form passes `bash -n` and prints `pull: error (Token HTTP 400)`.

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

### 4. `mcp-server.test.js` — assert the error line survives the early return

One case: a `portfolio_sync` result where `analysis.message_body` is present **and**
`pull.status === "error"`. The assertion is that the rendered text still contains the pull
error, which fails against the current early return.

### 5. `modules/hermes/tests/test-portfolio-sync-output.sh` + a CI step for it

CI does **not** glob the hermes shell tests: `.github/workflows/test.yml:118-137` enumerates
**ten** explicit `- name:` / `run: bash modules/hermes/tests/test-<name>.sh` pairs, one per
file, with no matrix. Adding a test therefore requires adding a step, and the standing proof
is `modules/hermes/tests/test-skills-backup-restore.sh`, which exists in the tree and is
referenced by no workflow at all. So a new test file with no step guards nothing.

The test extracts the parse block out of the shipped `portfolio-sync.sh` at runtime and
executes it, rather than inlining a copy — a copy is a second source of truth and drifts
the first time anyone edits the script, which is the exact regression this test exists to
catch. It feeds that block two fixed inputs, a healthy body and a dead-grant body, and
asserts `pull: ok (downloaded)` and `pull: error (Token HTTP 400)`. It asserts behaviour,
not shell text, so rewording the log prefix does not break it.

Extraction is by `python3 -c "` … `" 2>/dev/null` delimiters, followed by unescaping `\"` →
`"` before execution; the block must then run under `python3` unchanged. This ordering is
load-bearing in the other direction too: because the block still contains `\"` until it is
unescaped, a test that executes it verbatim raises a Python `SyntaxError` on a *correct*
script, which reads as a quoting bug in the script and sends the implementer to fix the
wrong file. The test also asserts the extracted block compiles before running it, so a
quoting regression reports as a clear compile error rather than a downstream assertion
failure.

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
- `bash -n modules/hermes/scripts/portfolio-sync.sh` must pass before the GREEN claim. The step-2
  change is inside a bash string, so a quoting slip is a whole-script parse failure rather than a
  single bad line, and no assertion in the vitest suite would see it. CI shellchecks the file
  (`test.yml:114-117`) but only after merge; this is the local gate that catches it first.
- Mutation control: the recorded command is replayed at the base commit in a throwaway worktree and must exit non-zero, so a fix that does not stop the reproduction fails closed.
- The script change is verified hermetically by `modules/hermes/tests/test-portfolio-sync-output.sh` over two fixed bodies (healthy and dead-grant), asserting behaviour rather than shell text. No live-service call is part of validation.

## Out of scope

- Not changing `_computeSyncAll()` to skip the taxonomy write when the pull fails (see #627).
- Not adding alerting or changing `deliver` on the cron job.
- Not touching `pullFromOneDrive` / `pushToOneDrive`; they already return `success: false` correctly. The bug is in the caller.
- Not re-authenticating OneDrive in code; that is a user-side `/onedrive setup` action, already performed 2026-09-27.
