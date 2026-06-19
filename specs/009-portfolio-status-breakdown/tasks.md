## Phase 1: Config
- [ ] T1.1 Add `category_map: dict[str, list[str]]` field to Config in src/config.py (default empty dict)
- [ ] T1.2 Parse `CATEGORY_MAP` env var: format `category:class1,class2;category:class3` → dict of lists
- [ ] T1.3 Add `CATEGORY_MAP` to .env.example with documentation and sample value
- [ ] T1.4 Add `TAXONOMY_NAMES` fallback: if CATEGORY_MAP is set, query the taxonomies that contain mapped classifications

## Phase 2: Core Logic
- [ ] T2.1 Add `_compute_taxonomy_summary()` method in src/agent/tools.py (ToolRegistry)
- [ ] T2.2 Query pp_bridge.query_taxonomies(taxonomy_names) — reuse existing bridge method
- [ ] T2.3 Fetch live FX rates via self._fetch_live_rates()
- [ ] T2.4 For each classification value, look up category from category_map
- [ ] T2.5 Convert per-currency native values to SGD using FX rates (same pattern as _export_taxonomies_to_sheet)
- [ ] T2.6 Accumulate per-category SGD totals → taxonomy_summary dict
- [ ] T2.7 Build taxonomy_breakdown dict showing per-classification SGD values within each category

## Phase 3: API Integration
- [ ] T3.1 Call `_compute_taxonomy_summary()` from `_compute_status_sgd()` in tools.py
- [ ] T3.2 Merge taxonomy_summary and taxonomy_breakdown into the status response (skip if no category_map)
- [ ] T3.3 Handle pp_bridge None: return empty taxonomy_summary with error field

## Phase 4: Edge Cases
- [ ] T4.1 Taxonomy name not found in PP file → warn, continue with remaining taxonomies
- [ ] T4.2 Classification in taxonomy but not in any category_map → include in "unclassified" category
- [ ] T4.3 FX rate unavailable for a currency → log warning, omit from SGD total for that classification
- [ ] T4.4 Empty CATEGORY_MAP → skip computation, taxonomy_summary not included in response

## Phase 5: Tests
- [ ] T5.1 Unit: _compute_taxonomy_summary with single taxonomy, single category
- [ ] T5.2 Unit: multi-taxonomy aggregation into same category
- [ ] T5.3 Unit: SGD conversion math (reuses existing FX mock pattern from test_pp_sync_all.py)
- [ ] T5.4 Unit: empty category_map → skipped
- [ ] T5.5 Unit: classification not in map → added to "unclassified"
- [ ] T5.6 Unit: missing FX rate → omitted, warning logged
- [ ] T5.7 Unit: taxonomy not found → graceful skip
- [ ] T5.8 Unit: Config parse tests for CATEGORY_MAP env var (test_config.py)
- [ ] T5.9 Integration: get_pp_status tool returns taxonomy_summary when CATEGORY_MAP configured
- [ ] T5.10 Integration: taxonomy_summary present in pp-sync-all result portfolio_status
