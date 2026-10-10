# Make the MEMORY.md topic-pointer seed idempotent for reworded pointers

Tracked by issue #765.

## QUESTIONS

```
q: Where is the defect, and is it in code or in live data?
a: In code. The `PYPTR` block of `modules/hermes/50-seed-defaults` (the `if pointer not in content:` line) adds the pointer unless the seed's exact sentence is already in `/opt/data/memories/MEMORY.md`. The live core already carries a differently worded pointer ("Durable facts too big for core live in /opt/data/memories/topics/ - search there before recall answers."), so the check never matches.
q: What does the defect do today and what would it do next boot?
a: Today the core was at its cap (2807 bytes against `memory_char_limit: 2800`), so every boot logged "memory: pointer skipped, core is full - trim MEMORY.md first" although a pointer was present. After the live core was trimmed to 1657 characters the candidate fits, so the next boot would append a second, duplicate pointer.
q: What is the smallest correct fix?
a: Skip when the core already references the topics directory at all: replace `pointer not in content` with `"/opt/data/memories/topics" not in content`. The exact-sentence check is the root cause, and the block is the only place that writes the pointer.
q: Are there other callers or copies of this logic?
a: No. The pointer text appears once in the seed, and `grep` for `PYPTR` finds only this block and its test (`tests/test-50-seed-defaults.sh`, which extracts the block and asserts add, no-clobber, idempotence and the cap guard).
q: Does the change weaken the cap guard or the first-add behaviour?
a: No. A core with no mention of the topics directory still gets the pointer, still only when the candidate fits `memory_char_limit`. The existing tests for add, no-clobber, idempotence and the cap guard are unchanged and re-run.
q: Why is the new test its own file rather than an added case in `test-50-seed-defaults.sh`?
a: The bug reproduction runs at the base commit with only whole new Python test files copied in, and an edit inside an existing shell test is not copied, so a case added there exited 0 at base. The reproduction is therefore a self-contained command that runs the real seed block against a reworded pointer; the committed regression test is `modules/hermes/tests/test-memory-pointer.sh`, wired into `.github/workflows/test.yml`, and it fails at base and passes at HEAD.
q: Is the live production memory edit part of this change?
a: No. The live trim of `MEMORY.md` and the `topics/` index update were done separately on the running container at the operator's request; this change only stops the seed from undoing or duplicating them.
```

## Change

1. `modules/hermes/50-seed-defaults`: one-line condition change in the `PYPTR` block (committed).
2. `modules/hermes/tests/test-memory-pointer.sh`: new test. A core holding a reworded topics pointer must still hold exactly one after the block runs.
3. `.github/workflows/test.yml`: one step running the new test.

## Risks

A core that mentions `/opt/data/memories/topics` for another reason will not get the seed's pointer. That is acceptable: the pointer's purpose is to tell a fresh session the directory exists, and any such mention does that.
