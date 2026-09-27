# Fix: a dead OneDrive grant must not be reported as a successful pull

## QUESTIONS

q: Should `pull()` return `status: "error"` on a `{success: false}` result, or should it keep reporting `"ok"` and move the signal elsewhere? | a: `"error"`. `push()` two methods below already derives status from `result.success`, and the MCP `pp-pull` / `pp-push` tool handlers in `tools.js:665,676` do the same. `pull()` is the only path in the module that hardcodes `"ok"` regardless of the outcome, so it is an inconsistency rather than a design choice.
q: Should `_computeSyncAll()` abort the taxonomy export when the pull fails, so B4 is never written from a stale file? | assumption: No — do not change the control flow of the sync in this fix. Aborting would mean a failed grant leaves yesterday's cell values in place with no new write, which is a larger behavioural change to the job's contract than this defect requires, and it needs its own decision about alerting. This fix makes the failure *visible and machine-readable*; suppressing the write is deliberately out of scope and noted in the issue.
q: Should the cron script in `modules/hermes/scripts/portfolio-sync.sh` change too, so the failure appears in the job log? | a: Yes. The `pull` and `push` result objects are already in the HTTP response body; the script parses the body and simply does not print those two keys, printing only `sync_targets`. Surfacing them is a few lines in the existing parse block and requires no service change.
q: Is the seeded cron script the one that actually runs, or is `/opt/data/scripts/portfolio-sync.sh` authoritative? | a: The seeded copy at `modules/hermes/scripts/portfolio-sync.sh` is the tracked source that CI/CD deploys; `/opt/data/scripts/portfolio-sync.sh` is the live deployed artifact of it. The repo file is the one to change.
q: Does the existing test at `java_bridge.test.js:351` need changing, and does changing it count as mutating a test? | a: Yes, it must change — it currently asserts the defective behaviour (`status: "ok"` for a failed pull). This is an intentional correction of a wrong assertion, and the RED test proves the new expectation fails against the unfixed code.
q: Is `human_approval_allow_agent_authored_comment` enabled in policy.json? | a: Yes, `true` in `codex/skills/dev-loop/policy.json`, alongside `human_approval_allow_self: true`. So the approval may be posted by the agent against the driver account and is recorded as `self-approved-driver-account` / `agent-authored-self-attested`, which keeps the bypass visible in the audit trail.

## Change scaffold

- **Files changed base..HEAD:** `modules/portfolio-tracker/src/java_bridge.js`, `modules/portfolio-tracker/tests/java_bridge.test.js`, `modules/hermes/scripts/portfolio-sync.sh`.
- **Repository test command:** `cd modules/portfolio-tracker && npx vitest run` (package.json `"test": "vitest run"`).
- **Test files in scope:** `modules/portfolio-tracker/tests/java_bridge.test.js` (existing `describe("pull")` block, lines 343-367).
- **Spec in scope:** `specs/003-portfolio-tracker/spec.md` — "Taxonomy Export" section (line ~372) documents that the taxonomy is written to Sheets; it does not specify pull-failure behaviour, so this change adds behaviour the spec does not yet describe.

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

`push()` immediately below (line 428) derives the status correctly. The MCP tool handlers for the same two operations (`tools.js:665`, `tools.js:676`) also derive it correctly. Only `pull()` does not.

The consequence is not cosmetic. `_computeSyncAll()` (`tools.js:800-1076`) calls `this._ppBridge.pull()` at line 808, logs the result, and never inspects `status`. The taxonomy export at line ~955 then queries whatever stale `Portfolio.portfolio` is on disk and writes it to `B4` / `G2:G5`. Production evidence (issue #627): with the grant expired, the run logged

```
{"event":"pp-pull","result":{"status":"ok","detail":"Token HTTP 400"}}
{"event":"pp-push","result":{"status":"error","detail":"Token HTTP 400"}}
```

one minute apart, same underlying failure, and `2026!B4` was written as `83,915.93` from a frozen file in which `Loan` read `-6,344.22` instead of the real `-26,344.22`.

The daily job is `no_agent: true` with `deliver: local`, so nothing alerted. Its output prints only `sync_targets`, and those three Actual Budget-fed accounts reported `delta=0` precisely *because* the round trip was broken — a healthy run and a broken run printed the same thing.

## Root cause, not symptom

The shared defect is "a failed OneDrive round trip is indistinguishable from a successful one at the boundary." That is asserted in two places, so both are fixed:

1. `java_bridge.js` `pull()` — the status value itself.
2. `portfolio-sync.sh` — the status never reaches the operator-visible job log.

Fixing only (1) would leave the cron output identical, because the script does not print the `pull` key. Fixing only (2) would print `status: "ok"` for a failed pull. Both are one-or-two-line changes at the correct layer, and no deeper refactor is warranted.

## Implementation

### 1. `java_bridge.js` — derive the status

```js
return {
    status: result.success ? "ok" : "error",
    detail: result.success ? "downloaded" : result.error,
};
```

The `catch` branch already returns `"error"` and is unchanged, so a thrown exception and a returned failure now agree.

### 2. `portfolio-sync.sh` — print the round-trip status

Extend the existing parse block to also emit the `pull` and `push` results, which are already in the response body:

```python
for leg in ('pull', 'push'):
    r = data.get(leg) or {}
    print(f"  {leg}: {r.get('status', '?')} ({r.get('detail', '')})")
```

Failures stay visible in the job output without changing the script's exit code or the `deliver: local` contract, so no alerting change is implied.

### 3. `java_bridge.test.js` — correct the assertion and add the RED case

`describe("pull")` currently asserts the defect:

```js
it("returns detail when pull returns error info", async () => {
    mockPullFromOneDrive.mockResolvedValue({ success: false, error: "Network error" });
    const result = await bridge.pull();
    expect(result).toEqual({ status: "ok", detail: "Network error" });  // wrong
});
```

It is changed to expect `status: "error"`, which is the RED case: it fails against the unfixed `java_bridge.js` and passes after the fix. A second case asserts the successful pull still reports `ok` / `downloaded`, so the fix cannot be satisfied by always returning `"error"`.

## Validation

- RED: the corrected assertion fails at base with `expected { status: "error" }` against received `{ status: "ok" }`.
- GREEN: `npx vitest run` is fully green in `modules/portfolio-tracker`.
- Mutation control: the recorded command is replayed at base in a throwaway worktree and must exit non-zero, so a fix that does not stop the reproduction fails closed.
- The script change is verified by reading the `pull` / `push` keys out of a real `pp-sync-all` response body rather than by asserting on shell text.

## Out of scope

- Not changing `_computeSyncAll()` to skip the taxonomy write when the pull fails. That is a real follow-up (see issue #627) and needs a decision about whether a stale cell or no cell is the lesser evil.
- Not adding alerting or changing `deliver` on the cron job.
- Not touching `pushToOneDrive` / `pullFromOneDrive` themselves; they already return `success: false` correctly. The bug is in the caller.
- Not re-authenticating OneDrive in code; that is a user-side `/onedrive setup` action, already performed on 2026-09-27.
