# Inspecting a Live OpenCode Session (Read-Only)

Scenario: user asks "is that run going well? what model is it using?" while an opencode TUI/`run` may be live (e.g. a delegated Issue-#N implementation in a worktree). Do NOT touch the process — inspect copies only.

## 1. Identify the process

```
ps aux | grep -i opencode
ls -l /proc/<PID>/cwd                    # which repo/worktree it's in
cat /proc/<PID>/cmdline | tr '\0' ' '    # full argv (bare "opencode" = TUI)
ps -o pid,etime,stat -p <PID>            # Ssl+ = interactive TUI session leader
```

Cross-check repo progress: `git log --oneline -8`, `git status --short`, `git rev-list --count <base>..HEAD`, and `.dev-loop/state.md` when present (phase / tdd_cycles / head_sha / pr_number fields show where an orchestrated dev loop stands).

## 2. Where opencode keeps state

`~/.local/share/opencode/opencode.db` — SQLite in **WAL mode**: also copy `opencode.db-wal` and `opencode.db-shm`. Copy all three into a scratch dir under the write-safe root (`/workspace/oc-inspect` and `/tmp` both work), then query the copy. No sqlite3 CLI on the host — use python3's sqlite3 module with a read-only URI.

## 3. Key tables

| table | useful columns |
|---|---|
| session | id, title, model (JSON `{"id":...,"providerID":...,"variant":...}`), agent (build/plan), directory, cost, tokens_input/output/reasoning/cache_read, time_created/time_updated (epoch **ms**) |
| message | session_id, data JSON (role, modelID, providerID, tokens, summary) |
| part | message_id, data JSON (text; step-start/step-finish → last reply + finish reason) |
| todo | session_id, content, status (open rows = queued work) |
| session_message / session_input | newer sequencing tables (often empty) |

## 4. Health read (staleness heuristic)

- Fresh session for the expected workdir + recent `time_updated` + open todos → actively working.
- Only an old smoke test (reply `OPENCODE_SMOKE_OK`) + branch 0 commits ahead of base → real prompt was never fed in; process parked idle at the TUI prompt.
- DB file mtime not advancing while the process is alive = idle / waiting on stdin.

## 5. Copy-paste query

```python
import sqlite3, datetime
con = sqlite3.connect("file:/workspace/oc-inspect/opencode.db?mode=ro", uri=True)
cur = con.cursor()
def ts(t):
    return datetime.datetime.fromtimestamp(t/1000).strftime("%m-%d %H:%M:%S") if t else "?"
for r in cur.execute("""SELECT id,title,model,directory,time_created,time_updated,cost,
                        tokens_input,tokens_output FROM session
                        ORDER BY time_updated DESC LIMIT 8"""):
    print(ts(r[4]), "->", ts(r[5]), "|", (r[1] or "")[:50], "|", r[2], "|", r[3])
# open todos: SELECT session_id,content,status FROM todo ORDER BY time_updated DESC
```

## Verified example (2026-09-09)

A 46-min-old `opencode` TUI (PID in `/workspace/codex-router-mcp-auth`, Issue #38 worktree) had exactly one session — an 01:45 smoke test that replied `OPENCODE_SMOKE_OK` — and the branch sat 0 commits ahead of base with only an untracked implementation brief. Conclusion: run healthy but parked; the real prompt was never fed in. Model reported from session + message metadata: deepseek-flash via codex-router provider. All reads done on a copied DB — zero impact on the live process.
