QUESTIONS
q: Does the `darren-prod` environment secret `NOTION_API_TOKEN` hold the same token as the working local `modules/hermes/.env` value? | assumption: yes. GitHub secrets are write-only, so this is not verifiable from this repository; the local token was measured working against `api.notion.com`. If the assumption is wrong the symptom is a 401 from Notion after deploy, and the fallback is to create an environment secret named `NOTION_API_KEY` from the working local value and revert the workflow line to `secrets.NOTION_API_KEY`.
q: Where must the MCP server be installed so that both an image rebuild and a container recreate keep it? | a: In the persisted `/opt/data` volume, through the "Ensure Hermes container tooling" step that already installs `gh` and `ntn`. `/opt/data/.local/bin` is on the container PATH, and `modules/tests/test_deploy_workflow_router.py:396` forbids CLI tools in the image.
q: Is `/opt/data/.local/bin` on the PATH Hermes uses when it spawns a stdio MCP server? | a: Yes. Measured in the running container: `PATH=/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:...`, and Hermes passes `PATH` through to stdio servers.
q: Does the new MCP server conflict with the `productivity/notion` skill already on the volume? | a: No. That skill is a hub skill on the data volume, not a file in this repository, so this change neither edits nor removes it.
q: Does insurance need its own database? | a: No. Insurance already lives as rows inside databases that are shared with the integration; the only search match is the page `CIMB eCard (Insurance)`, whose parent is a data source row.

## Intent

Make Hermes able to read the Notion finance knowledge base (bank accounts, cards, insurance) and to write to it only behind an approval, without copying a secret value and without adding a container, a port, or a second credential. Tracked by #681.

Two independent faults block this today, both confirmed by read-only production inspection:

1. **The secret name does not match the reference.** The `darren-prod` environment holds `NOTION_API_TOKEN`, while `.github/workflows/deploy.yml:159` injects `secrets.NOTION_API_KEY`. A missing secret interpolates to an empty string rather than failing, so the container starts with `NOTION_API_KEY=` — measured length `0` inside the running container. `modules/docker-compose.yml:263` already forwards that variable to the `hermes` service and `modules/deploy.sh:599` already validates it as optional, so the only broken link is the name.
2. **No Notion MCP server is registered.** `modules/hermes/config.yaml:143` lists only `expense-tracker` and `portfolio-tracker`, so no `mcp__notion__*` tools exist and the empty token has nothing to be empty for.

## Current behaviour (traced)

- `.github/workflows/deploy.yml:159` passes `NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}` into the deploy step's environment; the same step runs `modules/deploy.sh` at `:186`/`:190`.
- `modules/docker-compose.yml:263` maps `NOTION_API_KEY=${NOTION_API_KEY}` into the `hermes` container's environment; the value therefore comes from the workflow, and from a local `.env` during a local deploy.
- `modules/deploy.sh:599` calls `check_var_optional "NOTION_API_KEY"`, so an empty or absent value is accepted silently — which is why this has been broken without any failing run.
- `modules/hermes/config.yaml:143` holds `mcp_servers:` with two HTTP entries and no notion entry.
- `.github/workflows/deploy.yml:204-233` installs `gh` and `ntn` into `/opt/data/.local` inside the running container, guarded by `command -v`, and finishes with `docker exec hermes sh -c 'gh --version && ntn --version'`.
- `modules/tests/test_deploy_workflow_router.py:396` pins the image rule: `assertNotIn("npm install --global", dockerfile)`.
- Production state, read-only: container env `NOTION_API_KEY` length 0; container `PATH` includes `/opt/data/.local/bin`; node v26.5.1, npm 11.17.0; `ntn 0.23.17` present but unusable without `NOTION_WORKSPACE_ID`.
- The working local token sees 201 pages and 7 data sources: `Miles Calculator`, `Accounts`, `Credit Cards`, `Singapore`, `Malaysia`, `Miles Constants`, `Exchange Rate`.
- The official server `@notionhq/notion-mcp-server@2.5.2` exposes 24 tools named `API-<operationId>`. It sets `readOnlyHint: true` only on GET tools and `destructiveHint: true` on everything else (`src/openapi-mcp-server/mcp/proxy.ts:171-188`), which is why `API-post-search` and `API-query-data-source` cannot share a `trust: untrusted` entry with the write tools.

## Target design

### `.github/workflows/deploy.yml`

Line 159, point at the secret that exists:

```yaml
                  NOTION_API_KEY: ${{ secrets.NOTION_API_TOKEN }}
```

Inside the "Ensure Hermes container tooling" step, after the `ntn` install (`:230-232`), install the MCP server the same way — into the volume, guarded, pinned:

```sh
                  if ! docker exec hermes sh -c 'command -v notion-mcp-server' >/dev/null 2>&1; then
                      docker exec hermes npm install --global --prefix /opt/data/.local @notionhq/notion-mcp-server@2.5.2
                  fi
```

The step's closing verification (`:233`) gains the same existence check used by the guard, because the server exposes no `--version` flag:

```sh
                  docker exec hermes sh -c 'gh --version && ntn --version && command -v notion-mcp-server'
```

### `modules/hermes/config.yaml`

Append two entries under `mcp_servers:` (`:143`). Both spawn the same stdio server and read the token through the environment reference that Hermes resolves at connect time, so no secret lands in the file:

```yaml
    notion:
        command: notion-mcp-server
        env:
            NOTION_TOKEN: ${NOTION_API_KEY}
        supports_parallel_tool_calls: false
        tools:
            include:
                - API-get-self
                - API-post-search
                - API-query-data-source
                - API-retrieve-a-data-source
                - API-retrieve-a-database
                - API-retrieve-a-page
                - API-retrieve-a-page-property
                - API-retrieve-page-markdown
                - API-get-block-children
                - API-list-data-source-templates
            resources: false
            prompts: false
    notion-write:
        command: notion-mcp-server
        env:
            NOTION_TOKEN: ${NOTION_API_KEY}
        supports_parallel_tool_calls: false
        trust: untrusted
        tools:
            include:
                - API-post-page
                - API-patch-page
                - API-update-page-markdown
                - API-create-a-comment
            resources: false
            prompts: false
```

The split is the whole point of the second entry: `include` cannot be conditioned on approval, and `trust: untrusted` gates every tool without `readOnlyHint: true`. A single entry would either expose writes ungated or demand approval for every read, because search and query are POSTs. No delete, archive, schema-change or page-move tool is exposed.

### `modules/tests/test_notion_mcp_wiring.py` (new)

One `unittest` file in the established `modules/tests` style, guarding the wiring that has no runtime test:

- `test_workflow_uses_the_existing_notion_api_token_secret` — the workflow passes `secrets.NOTION_API_TOKEN` and contains no `secrets.NOTION_API_KEY`.
- `test_workflow_installs_the_pinned_mcp_server_into_the_volume` — the tooling step installs `@notionhq/notion-mcp-server@2.5.2` with `--prefix /opt/data/.local`, guards with `command -v notion-mcp-server`, and verifies it; the Dockerfile still contains no `npm install --global`.
- `test_config_registers_read_and_gated_write_servers` — parsed YAML has both entries, both map `NOTION_TOKEN` to `${NOTION_API_KEY}`, the read include list holds search and query, the write entry carries `trust: untrusted`, and no entry exposes `API-delete-a-block`, `API-create-a-data-source`, `API-update-a-data-source` or `API-move-page`.

## Validation

No production behaviour changes in this repository: the change is a workflow line, one install block, and YAML config. TDD's RED/GREEN still applies to the new guard test, which is the one piece of logic worth pinning:

- RED: `python3 -m unittest discover -s modules/tests -p 'test_notion_mcp_wiring.py'` fails at the base commit, because neither the workflow nor the config contains the wiring.
- GREEN: the same command passes at HEAD.
- Regression: `python3 -m unittest discover -s modules/tests -p 'test_*.py'` — measured green at base, 75 tests in 16.7 s.
- After merge: `docker exec hermes sh -c 'command -v notion-mcp-server'`, then `hermes mcp test notion` and `/reload-mcp` inside the container, then a real `API-post-search` for `Accounts`. These are production commands and need explicit operator approval first.

## Risks and non-goals

- **Token mismatch (the one real residual).** If the GitHub secret holds a different or revoked token, the deploy succeeds and Notion answers 401. Fallback is documented in the QUESTIONS block. This change never reads, copies, or rotates the value.
- **Baked-in server version.** `2.5.2` is pinned, so a security fix upstream needs a follow-up bump; unpinned `latest` was rejected because a silent behaviour change in a tool that writes to a financial record store is worse than an explicit bump.
- **Two stdio servers** are spawned instead of one, each a small Node process. Accepted: it is the only way to gate writes without gating reads.
- Non-goal: the `productivity/notion` hub skill on the volume, the `ntn` workspace problem, and the insurance data model are all out of scope.
