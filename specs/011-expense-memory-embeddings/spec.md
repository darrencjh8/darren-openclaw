# Feature Specification: Expense Tracker Memory with Embeddings

**Feature Branch**: `011-expense-memory-embeddings`

**Created**: 2026-06-12

**Status**: Draft

**Input**: User description: "Replace the hardcoded `data/mappings.json` in the expense tracker with a configurable `MEMORY.md` file backed by embeddings-based semantic search, with self-learning, semantic dedup on write, and user feedback tools via the gateway."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Semantic Memory Search During Email Processing (Priority: P1)

The expense tracker agent processes a receipt email and needs to know which account a given card belongs to, or which payee a merchant maps to. Instead of relying on exact keyword matching against a pre-loaded JSON dictionary injected into every system prompt, the agent calls a `search_memory` tool that performs semantic search over learned facts stored in `MEMORY.md`, returning the most relevant matches regardless of exact phrasing.

**Why this priority**: This is the core workflow — every email processed depends on memory lookups for account, payee, and category matching. Without this, no transactions can be correctly classified.

**Independent Test**: Can be fully tested by seeding a `MEMORY.md` with known facts, sending a test email with merchant/card details, and verifying the agent correctly matches the right account and payee via `search_memory` calls.

**Acceptance Scenarios**:

1. **Given** `MEMORY.md` contains "Card ending 4605 belongs to UOB Ladies credit card", **When** an email arrives mentioning "UOB Card ending 4605" with a transaction, **Then** the agent calls `search_memory("UOB Card ending 4605")` and receives the UOB Ladies fact as the top result.
2. **Given** `MEMORY.md` contains "Toast Box merchant maps to Food payee", **When** an email arrives from "Toast Box" with a different spelling ("TOASTBOX"), **Then** the agent calls `search_memory("Toast Box")` and still matches the Food payee via semantic similarity.
3. **Given** `MEMORY.md` has no facts about a given merchant, **When** an email arrives for an unknown merchant, **Then** `search_memory` returns no relevant results, and the agent proceeds to manual payee matching using fetch-payees (existing behavior).

---

### User Story 2 - Self-Learning from Successful Transactions (Priority: P1)

After the agent successfully classifies and inserts a transaction, it calls `learn_fact` to record the mapping. The fact is appended to `MEMORY.md` and immediately indexed for future searches. If a semantically identical fact already exists (cosine similarity ≥ 0.95), the write is silently skipped to prevent bloat.

**Why this priority**: Self-learning is the mechanism that builds the memory. Without it, the memory remains empty and useless. Equally critical: without dedup, the memory grows linearly with every processed email, degrading search quality.

**Independent Test**: Process a transaction with a new merchant-payee mapping, verify a new fact line appears in `MEMORY.md`. Process the same mapping again, verify no duplicate line is added. Verify the new fact is immediately searchable in the next email processing run.

**Acceptance Scenarios**:

1. **Given** an empty `MEMORY.md`, **When** the agent successfully matches "Grab" → Transport and calls `learn_fact("Grab merchant maps to Transport payee")`, **Then** the fact is appended to `MEMORY.md` under `## Facts` and indexed for future searches.
2. **Given** `MEMORY.md` already contains "Grab merchant maps to Transport payee", **When** the agent calls `learn_fact("Grab merchant maps to Transport payee")` again, **Then** the duplicate is detected (cosine similarity ≥ 0.95) and skipped — no new line is written.
3. **Given** `MEMORY.md` has grown to 100 facts across accounts, payees, and categories, **When** a new fact is learned, **Then** search quality remains consistent (the growing file does not degrade retrieval accuracy).

---

### User Story 3 - User Feedback via Telegram (Priority: P2)

The user can correct learned mappings via Telegram chat with the gateway. When the user says "that's wrong", "X should be Y", or "forget X", the gateway agent understands the intent, routes it to the appropriate expense tracker tool (`update-fact` or `delete-fact`), and confirms the change.

**Why this priority**: User feedback closes the loop on incorrect mappings. Without it, a wrong mapping persists and silently corrupts future transactions until manually fixed by editing a file on the server.

**Independent Test**: Send a Telegram message saying "Toast Box should map to Coffee, not Food", verify the gateway invokes the appropriate expense tracker tool, the fact is updated in `MEMORY.md`, and subsequent searches return the corrected mapping.

**Acceptance Scenarios**:

1. **Given** `MEMORY.md` contains "Toast Box merchant maps to Food payee", **When** the user sends "Toast Box should be Coffee, not Food" via Telegram, **Then** the gateway calls `update-fact` on the expense tracker, the fact is changed to "Toast Box merchant maps to Coffee payee", and the index is updated.
2. **Given** `MEMORY.md` contains a stale fact about a closed account, **When** the user sends "forget DBS Yuu" via Telegram, **Then** the gateway calls `delete-fact` with matching text, the fact is removed from `MEMORY.md`, and it is no longer returned by `search_memory`.
3. **Given** the user wants to review all learned facts, **When** the user asks "show me all learned mappings" via Telegram, **Then** the gateway calls `list-facts` and presents the facts in a readable format.
4. **Given** the expense tracker asked the user "which account is card 4605?" and the user replies "UOB Ladies", **When** the gateway calls `update-fact` to record the correction, **Then** the expense tracker clears the cooldown on that email's message ID, so the next IMAP IDLE cycle re-processes it immediately using the corrected fact.

---

### User Story 5 - Notification Cooldown for Ambiguous Emails (Priority: P2)

When the agent cannot match an account or payee and notifies the user, the same email (left unread in IMAP) would trigger the same question every ~5 minutes until answered. To prevent notification spam, the expense tracker suppresses repeat notifications for the same email within a 1-hour window. When the user replies with a correction, the cooldown is cleared immediately so the email can be re-processed.

**Why this priority**: Without cooldown, ambiguous emails spam the user every IDLE cycle. But the cooldown must clear on user reply — otherwise the user is stuck waiting an hour for the email to process after they've already answered.

**Independent Test**: Send an email that triggers an ambiguous account match, verify notify_user is called once. Wait for the next IMAP IDLE cycle, verify the same email does NOT trigger a second notification. Simulate a user correction via update-fact, verify the cooldown is cleared and the email re-processes normally.

**Acceptance Scenarios**:

1. **Given** an email with an unrecognized card triggers notify_user("which account is card 4605?"), **When** the IMAP IDLE cycle re-scans before the user replies, **Then** the expense tracker silently skips the email (no duplicate notification within 1 hour).
2. **Given** the user replies "UOB Ladies" and the gateway calls update-fact to correct the mapping, **When** the next IMAP IDLE cycle scans the still-unread email, **Then** the cooldown is cleared and the email is re-processed immediately with the corrected fact.
3. **Given** the user does NOT reply and the cooldown expires after 1 hour, **When** the next IDLE cycle scans the email, **Then** the agent asks again (once).

---

### User Story 6 - Configurable Memory Path (Priority: P3)

The path to `MEMORY.md` is not hardcoded. It is set via a `MEMORY_PATH` environment variable, defaulting to `data/MEMORY.md` relative to the working directory. This allows the memory file location to be changed without code modifications.

**Why this priority**: Enables operational flexibility (different paths for development vs production, mounting to different volumes) but is not critical for the core memory workflow.

**Independent Test**: Set `MEMORY_PATH=/tmp/test-memory.md`, process an email, and verify facts are written to and read from `/tmp/test-memory.md` instead of the default path.

**Acceptance Scenarios**:

1. **Given** `MEMORY_PATH` is not set, **When** the expense tracker starts, **Then** it uses `data/MEMORY.md` (relative to working directory).
2. **Given** `MEMORY_PATH=/custom/path/memory.md`, **When** the expense tracker starts, **Then** it reads from and writes to `/custom/path/memory.md`.
3. **Given** `MEMORY_PATH` points to a non-existent directory, **When** `learn_fact` is called, **Then** the directory is created automatically (matching current `save_mappings` behavior).

---

### Edge Cases

- What happens when `MEMORY.md` is empty (cold start with no learned facts)? → `search_memory` returns an empty result set; the agent falls back to keyword-based matching from the system prompt rules.
- What happens when `MEMORY.md` is manually edited to contain malformed or non-fact content? → The embedding index treats each chunk as a fact; searches may return irrelevant results. No crash or error.
- How does the system handle concurrent email processing (multiple IMAP callbacks)? → File writes are atomic (write to temp file, rename). In-memory index updates are serialized (async lock per append).
- What happens if the embeddings model fails to load (corrupted download, out of memory)? → `search_memory` falls back to simple substring search over `MEMORY.md`; facts are still learnable and retrievable, just without semantic matching.
- What happens when multiple `learn_fact` calls fire for different facts in rapid succession? → Each append + re-index is sequential; file is re-read and re-indexed after each write to maintain consistency.
- How does periodic rewrite handle the file growing large? → Every ~50 new facts, the file is read in full, deduplicated (cosine similarity within the set), and rewritten compactly. This is a background operation that doesn't block reads.
- What happens when the agent asks the user a question about an ambiguous email and the same email is re-scanned on the next IMAP IDLE cycle? → The expense tracker maintains an in-memory set of `msg_id → first_notified_at` timestamps. Before calling `notify_user()` for an ambiguous email, it checks this set. If the msg_id was already notified within the last 1 hour, the notification is suppressed silently. If the cooldown has expired (>1 hour), it asks again.
- What happens to the cooldown set when the user replies with a correction? → When `update-fact` or `delete-fact` is called (user applied a correction), the expense tracker clears all cooldown entries. The next IDLE cycle will immediately re-process all pending ambiguous emails with the corrected memory, rather than waiting for cooldown expiry.
- What happens to the cooldown set on restart? → The in-memory set is lost on container restart. On restart, existing unread emails may trigger fresh notifications, which is acceptable (restarts are rare in production).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST store learned facts in a human-readable Markdown file (`MEMORY.md`) with sections following the gateway memory format (## Facts, ## Preferences, ## Decisions).
- **FR-002**: System MUST use an embeddings model (`all-MiniLM-L6-v2`) to index facts from MEMORY.md for semantic search.
- **FR-003**: System MUST expose a `search_memory(query)` tool that returns the top-N semantically relevant facts for a given query string.
- **FR-004**: System MUST expose a `learn_fact(fact)` tool that appends a new fact to MEMORY.md and indexes it for future searches.
- **FR-005**: System MUST perform semantic deduplication on `learn_fact` — if the new fact has cosine similarity ≥ 0.95 to any existing fact, the write is silently skipped.
- **FR-006**: System MUST expose `list-facts`, `update-fact(old_text, new_text)`, and `delete-fact(match_text)` tools for user-driven memory management.
- **FR-007**: System MUST accept a `MEMORY_PATH` environment variable to configure the memory file location, defaulting to `data/MEMORY.md`.
- **FR-008**: System MUST rebuild the in-memory embedding index from MEMORY.md on startup.
- **FR-009**: System MUST perform a periodic deduplication rewrite of MEMORY.md every ~50 new fact additions.
- **FR-010**: System MUST fall back to substring search over MEMORY.md if the embeddings model is unavailable.
- **FR-011**: Gateway MUST route user feedback messages (corrections, deletions) to the appropriate expense tracker memory management tools via existing HTTP tool endpoints.
- **FR-012**: System MUST remove the hardcoded `data/mappings.json` path and the `_load_learned_context()` injection into the system prompt.
- **FR-013**: System MUST suppress repeat `notify_user()` calls for the same email (by IMAP msg_id) within a 1-hour cooldown window when the email was left unread due to ambiguity.
- **FR-014**: System MUST clear the notification cooldown set when `update-fact` or `delete-fact` is called, allowing pending ambiguous emails to be re-processed immediately on the next IDLE cycle.
- **FR-015**: System MUST use `medium` thinking level for the DeepSeek LLM (currently unset), to ensure multi-step reasoning and rule compliance during email processing.
- **FR-016**: System prompt MUST be restructured into three orthogonal sections: RULES (constraints — what NOT to do), MATCHING (heuristics for accounts/payees/categories), and WORKFLOW (step-by-step procedure), with no redundancy or contradictions between them.

### Key Entities

- **Memory Fact**: A single line or paragraph in MEMORY.md representing a learned relationship (e.g., "Card ending 4605 belongs to UOB Ladies credit card"). Has an embedding vector for semantic search and a cosine-similarity-based identity for dedup.
- **Memory Index**: An in-memory data structure mapping fact text → embedding vector, used for fast similarity search. Rebuilt from MEMORY.md on startup.
- **Memory Store**: The abstraction managing reading, writing, indexing, deduplicating, and searching the MEMORY.md file. Replaces the current `load_mappings()`/`save_mappings()` JSON dictionary.
- **Notification Cooldown**: An in-memory set mapping IMAP `msg_id` → first notification timestamp. Used to suppress repeat `notify_user()` calls for ambiguous emails within a 1-hour window. Cleared on `update-fact`/`delete-fact` calls and on container restart (acceptable loss).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The expense tracker agent correctly matches accounts and payees for at least 95% of transaction emails after a 2-week learning period (with user corrections via Telegram).
- **SC-002**: MEMORY.md file size stabilizes at under 500 lines for 3+ months of continuous operation (demonstrating effective deduplication).
- **SC-003**: Memory search returns results in under 100ms for a memory file containing up to 500 facts.
- **SC-004**: A user can correct a wrong mapping via Telegram and see the corrected behavior in the very next email processed (feedback loop closed within one processing cycle).
- **SC-005**: Cold start (empty MEMORY.md) still processes emails correctly using fallback keyword rules — no regression from current behavior.
- **SC-006**: All existing tests for expense tracker tools continue to pass after the migration from `mappings.json` to `MEMORY.md`.
- **SC-007**: No duplicate `notify_user` messages are sent for the same ambiguous email within a 1-hour window.
- **SC-008**: After the user replies to an ambiguous-email notification with a correction, the original email is re-processed and correctly inserted on the very next IMAP IDLE cycle (not left waiting for cooldown expiry).

## Assumptions

- The `all-MiniLM-L6-v2` model with ONNX int8 quantization adds ~55 MB to the expense tracker container (205 MB total vs. current 150 MB budget). Constitution 2.5 will be amended post-implementation (see T051).
- The expense tracker's working directory inside the Docker container is `/app` (as defined in the existing Dockerfile), and `data/` is volume-mounted.
- The DeepSeek LLM continues to power the agent orchestration; embeddings only handle memory search, not LLM inference.
- User feedback flows through the existing Gateway → HTTP tool endpoint architecture — no new communication channels needed.
- The current `mappings.json` (if it exists) will be migrated to `MEMORY.md` as part of the implementation.
- Semantic dedup threshold of 0.95 is sufficient to prevent near-duplicates without being over-aggressive (tested during implementation).
- Periodic rewrite at ~50 facts is a background operation that doesn't significantly impact processing latency.
