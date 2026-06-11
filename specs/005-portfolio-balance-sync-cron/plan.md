# Technical Plan: Actual Budget → PP Balance Sync

**Feature:** balance-sync
**Plan Version:** 1.0.0
**Status:** Planned
**Constitution Hash:** v1.0.0

---

## 1. Account Mappings

| PP Account | PP UUID | AB Budget Field | Currency |
|---|---|---|---|
| Emergency SGD | `cc1141c4-a078-4ce8-b9e5-ef30c21f4479` | `Emergency Fund SGD` | SGD |
| Emergency MYR | `a31f65e3-3b57-412f-aca5-498ac3114c3d` | `Emergency Fund MYR` | MYR |
| Warchest | `ea11e070-a5a3-47a9-bb09-c501ab1da4fb` | `General Investment Fund` | SGD |

---

## 2. Pull/Push Scripts (OneDrive via Microsoft Graph API)

### 2.1 onedrive_download.py

- **Auth:** OAuth2 refresh token flow (stored in `ONEDRIVE_REFRESH_TOKEN` env var)
- **Endpoint:** `GET /me/drive/root:/Portfolio/Portfolio.portfolio:/content`
- **Output:** Writes to `PP_XML_PATH`
- **Error handling:** Non-zero exit code on failure (caller decides whether to continue)
- **Timeout:** 30s

### 2.2 onedrive_upload.py

- **Auth:** Same OAuth2 refresh token flow
- **Endpoint:** `PUT /me/drive/root:/Portfolio/Portfolio.portfolio:/content`
- **Input:** Reads from `PP_XML_PATH`
- **Error handling:** Non-zero exit code on failure
- **Timeout:** 30s

### 2.3 Environment Variables

| Variable | Description |
|---|---|
| `ONEDRIVE_CLIENT_ID` | Microsoft Graph API app client ID |
| `ONEDRIVE_CLIENT_SECRET` | Microsoft Graph API app client secret |
| `ONEDRIVE_REFRESH_TOKEN` | OAuth2 refresh token |
| `PP_XML_PATH` | Path to local `Portfolio.portfolio` file |
| `PP_JAR_PATH` | Path to `pp-cli.jar` |
| `PP_PASSWORD` | Password for encrypted `.portfolio` files |

---

## 3. Java CLI Balance Command

### 3.1 Signature

```bash
java -jar pp-cli.jar balance \
  --file "$PP_XML_PATH" \
  --account-id <uuid> \
  --amount <dollars> \
  --currency <SGD|MYR> \
  --date <YYYY-MM-DD> \
  --password "$PP_PASSWORD"
```

### 3.2 Output

```json
{"status":"updated","account_id":"<uuid>","balance_cents":<long>}
```

### 3.3 Balance Formula

Uses `AccountSnapshot.create(Client, Account, LocalDate)`:
- Classifies each `AccountTransaction` as debit or credit using `AccountTransaction.Type.isDebit()`/`isCredit()`
- Sums all transactions to compute the balance
- Does NOT include portfolio holdings (no `portfolio` loop)
- Matches PP official UI behavior

---

## 4. Data Flow

```
AB API (cent-based JSON)
  ↓ /100.0
Python computes target dollars per category
  ↓ compute delta = target - currentBalance
Java CLI (pp-cli.jar balance --account-id --amount --currency --date)
  ↓ converts dollars → cents internally
PP XML updated with new balance transaction
```

### 4.1 Detailed Flow

```
1. onedrive_download.py
   → GET /me/drive/root:/Portfolio/Portfolio.portfolio:/content
   → Write to $PP_XML_PATH

2. HTTP GET http://actual-api:3000/budget-12m
   → JSON response with category budgets (in cents)
   → For each of 3 target categories:
       amount_dollars = amount_cents / 100.0
   
3. For each account (3 iterations):
   a. Get current balance via Java CLI
   b. Compute delta: target_dollars - current_balance
   c. Call Java CLI balance command with new target amount
   
4. onedrive_upload.py
   → PUT /me/drive/root:/Portfolio/Portfolio.portfolio:/content
   → Read $PP_XML_PATH, upload bytes
```

---

## 5. Architecture

```python
async def run_sync_all():
    # Phase 1: Pull
    if not await onedrive_download():
        logger.warning("Pull failed, continuing with local file")
    
    # Phase 2: Compute and sync
    budgets = await fetch_ab_budgets("http://actual-api:3000/budget-12m")
    targets = {
        "cc1141c4-...": {"name": "Emergency SGD",   "amount": budgets["Emergency Fund SGD"]       / 100.0, "currency": "SGD"},
        "a31f65e3-...": {"name": "Emergency MYR",   "amount": budgets["Emergency Fund MYR"]       / 100.0, "currency": "MYR"},
        "ea11e070-...": {"name": "Warchest",         "amount": budgets["General Investment Fund"]  / 100.0, "currency": "SGD"},
    }
    bridge = PpJavaBridge(jar_path=PP_JAR_PATH, xml_path=PP_XML_PATH, password=PP_PASSWORD)
    for acct_id, target in targets.items():
        bridge.update_balance(account_id=acct_id, amount=target["amount"],
                              currency=target["currency"], date=today)
    
    # Phase 3: Push
    if not await onedrive_upload():
        logger.error("Push failed — sync results are in local file only")
```

### 5.1 Key Dependencies

- `aiohttp.ClientSession` for HTTP calls to AB API and OneDrive
- `PpJavaBridge` for Java CLI subprocess calls
- No LLM, no DeepSeek client, no Telegram

---

## 6. Error Handling

| Failure Point | Behavior |
|---|---|
| OneDrive download fails | Log, continue with local file |
| AB API unreachable | Log, exit (no point continuing without target data) |
| Zero budget data | Log warning, skip all updates, exit cleanly |
| Java CLI fails for one account | Log error, continue with remaining accounts |
| OneDrive upload fails | Log error, sync results preserved in local file |
| PP password wrong | Java CLI exits with auth error, no data corruption |
