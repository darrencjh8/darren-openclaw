Architecture: Java CLI taxonomy query → Python SGD conversion → getStatus API response extension

Data flow:
1. Config: new env var `CATEGORY_MAP` specifying which taxonomy classifications map to which semantic categories
   Format: `category:class1,class2;category:class3,...`
   Example: `liquid_equity:America,Developed ex-US,Emerging;cash:Investable Cash;illiquid_equity:CPF-OA,CPF-SA;retirement:SRS`

2. Python ToolRegistry._compute_taxonomy_summary(category_map, taxonomy_names)
   - Calls PpJavaBridge.query_taxonomies(taxonomy_names) for each taxonomy
   - Receives per-classification per-currency native breakdown from Java
   - Calls _fetch_live_rates() for SGD conversion
   - For each classification entry:
     * Look up its categorization from category_map
     * Convert currencies map to SGD using live FX rates
     * Accumulate into per-category SGD totals
   - Returns {taxonomy_summary, taxonomy_breakdown} dict

3. Integration point: _compute_status_sgd() in tools.py
   - After computing total_value_sgd / equity_value_sgd, also call _compute_taxonomy_summary()
   - Merge taxonomy_summary into the status response
   - Skip if category_map is empty or not configured

4. getStatus API response extension:
   Additional field `taxonomy_summary` returned alongside existing summary fields

Key files changed:
   - src/config.py: add `category_map: dict[str, list[str]]` field, parse from CATEGORY_MAP env
   - src/agent/tools.py: add _compute_taxonomy_summary(), call from _compute_status_sgd()
   - .env.example: add CATEGORY_MAP documentation

No Java changes needed — existing queryTaxonomies already returns per-currency native breakdowns.

Reuses:
   - PpJavaBridge.query_taxonomies() — existing, returns per-classification per-currency native values
   - _fetch_live_rates() — existing, returns USD/MYR/GBP/EUR → SGD rates
   - Per-currency SGD conversion logic — same pattern as _export_taxonomies_to_sheet()

Config:
   CATEGORY_MAP=liquid_equity:America,Developed ex-US,Emerging;cash:Investable Cash;illiquid_equity:;retirement:
