# Contracts: Expense Tracker Memory with Embeddings

**Feature**: 011-expense-memory-embeddings

## HTTP API Endpoints (Expense Tracker → Gateway)

All endpoints are POST, accept JSON body, return JSON response. Registered in `tools_api.py`.

### search-memory

```
POST /tools/search-memory
```

**Request:**
```json
{
  "query": "what account is card ending 4605"
}
```

**Response (200):**
```json
{
  "results": [
    {
      "text": "Card ending 4605 belongs to UOB Ladies credit card",
      "score": 0.92
    },
    {
      "text": "UOB Ladies is a credit card account",
      "score": 0.78
    }
  ]
}
```

**Response (empty):**
```json
{
  "results": []
}
```

**Errors:** `400` invalid JSON, `500` embeddings model unavailable (falls back to substring search).

---

### learn-fact

```
POST /tools/learn-fact
```

**Request:**
```json
{
  "fact": "Toast Box merchant maps to Food payee"
}
```

**Response (200):**
```json
{
  "added": true,
  "skipped": false
}
```

**Response (dedup skip):**
```json
{
  "added": false,
  "skipped": true,
  "reason": "similar fact exists (cosine: 0.97)"
}
```

---

### list-facts

```
POST /tools/list-facts
```

**Request:** `{}`

**Response (200):**
```json
{
  "facts": [
    "Card ending 4605 belongs to UOB Ladies credit card",
    "Toast Box merchant maps to Food payee",
    "Grab merchant maps to Transport payee"
  ]
}
```

---

### update-fact

```
POST /tools/update-fact
```

**Request:**
```json
{
  "old_text": "Toast Box merchant maps to Food payee",
  "new_text": "Toast Box merchant maps to Coffee payee"
}
```

**Response (200):**
```json
{
  "updated": true,
  "found": true
}
```

**Response (not found):**
```json
{
  "updated": false,
  "found": false
}
```

**Note:** Clears notification cooldown on success.

---

### delete-fact

```
POST /tools/delete-fact
```

**Request:**
```json
{
  "match_text": "Toast Box"
}
```

**Response (200):**
```json
{
  "deleted": true,
  "count": 1
}
```

**Response (not found):**
```json
{
  "deleted": false,
  "count": 0
}
```

**Note:** Clears notification cooldown on success. Matching is substring-based over MEMORY.md lines.

---

## Gateway Routing Contract (AGENTS.md)

The gateway's `workspace/AGENTS.md` must include these routing rules:

```markdown
## Memory Feedback

When the user sends a correction about a learned mapping:
- "that's wrong", "X should be Y", "change X to Y", "fix the mapping"
- "forget X", "remove X", "delete X"
- "show me all learned facts", "what have you learned"

Routes:
- Corrections → expense-tracker update-fact or delete-fact
- Listing → expense-tracker list-facts
- After correcting: confirm the change, tell user the original email
  will be re-processed on the next scan

Always call the appropriate tool by URL:
  `http://expense-tracker:8080/tools/search-memory`
  `http://expense-tracker:8080/tools/update-fact`
  `http://expense-tracker:8080/tools/delete-fact`
  `http://expense-tracker:8080/tools/list-facts`
```
