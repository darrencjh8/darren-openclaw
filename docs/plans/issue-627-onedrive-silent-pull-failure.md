QUESTIONS
q: Fix pull() status or move the signal? | a: Fix pull() to mirror push() - it alone hardcodes "ok".
q: Abort the sheet write when pull fails? | assumption: No - out of scope; tracked in #627.
q: The test asserting "ok" on failure? | a: It enshrines the defect; it becomes the RED case.

## Question detail

Full reasoning for the three declared questions above, kept out of the `QUESTIONS` prefix so the
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

**Note on the plan-approval route.** `policy.json` sets `human_approval_allow_agent_authored_comment: true`
and `human_approval_allow_self: true`, so the approval comment may be posted by the agent against
the driver account. It is recorded as an agent-authored / self-attested approval so the bypass
stays visible in the audit trail.

## Change scaffold

- **Files changed base..HEAD:** `modules/portfolio-tracker/src/java_bridge.js`, `modules/portfolio-tracker/tests/java_bridge.test.js`, `modules/hermes/scripts/portfolio-sync.sh`.
- **Repository test command:** `cd modules/portfolio-tracker && npx vitest run` (package.json `"test": "vitest run"`).
- **Test files in scope:** `modules/portfolio-tracker/tests/java_bridge.test.js` (existing `describe("pull")` block, lines 343-367).
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
the boundary." That is asserted in two places, so both are fixed:

1. `java_bridge.js` `pull()` — the status value itself.
2. `portfolio-sync.sh` — the status never reaches the operator-visible job log.

Fixing only (1) would leave the cron output identical, because the script does not print the
`pull` key. Fixing only (2) would print `status: "ok"` for a failed pull. Both are
one-or-two-line changes at the correct layer; no deeper refactor is warranted.

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
not print them. Extend that block:

```python
for leg in ('pull', 'push'):
    r = data.get(leg) or {}
    print(f"  {leg}: {r.get('status', '?')} ({r.get('detail', '')})")
```

Failures become visible in the job output without changing the script's exit code or the
`deliver: local` contract, so no alerting change is implied.

### 3. `java_bridge.test.js` — correct the assertion and add the RED case

`describe("pull")` currently asserts the defect:

```js
it("returns detail when pull returns error info", async () => {
    mockPullFromOneDrive.mockResolvedValue({ success: false, error: "Network error" });
    const result = await bridge.pull();
    expect(result).toEqual({ status: "ok", detail: "Network error" });  // wrong
});
```

It is changed to expect `status: "error"`, which is the RED case. A sibling case asserts a
successful pull still reports `ok` / `downloaded`.

## Validation

- RED: the corrected assertion fails at base — expected `{ status: "error" }`, received `{ status: "ok" }`.
- GREEN: `npx vitest run` fully green in `modules/portfolio-tracker`.
- Mutation control: the recorded command is replayed at the base commit in a throwaway worktree and must exit non-zero, so a fix that does not stop the reproduction fails closed.
- The script change is verified by reading the `pull` / `push` keys out of a real `pp-sync-all` response body, not by asserting on shell text.

## Out of scope

- Not changing `_computeSyncAll()` to skip the taxonomy write when the pull fails (see #627).
- Not adding alerting or changing `deliver` on the cron job.
- Not touching `pullFromOneDrive` / `pushToOneDrive`; they already return `success: false` correctly. The bug is in the caller.
- Not re-authenticating OneDrive in code; that is a user-side `/onedrive setup` action, already performed 2026-09-27.
