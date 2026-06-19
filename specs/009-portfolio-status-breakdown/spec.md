Feature: Portfolio Status API — Liquid/Illiquid/Cash/Retirement Breakdown

User stories:
- US-1: Query PP taxonomy/ies to classify holdings into liquid equity, illiquid equity, cash, and retirement categories
- US-2: Return per-category SGD-converted totals in the getStatus / get_pp_status API response
- US-3: Configurable taxonomy classification → category mapping (env var or config)
- US-4: Fallback gracefully when taxonomy/ies are not configured or not found in PP file

Implementation:
- Query one or more PP taxonomies via Java CLI (e.g., "Regions (Liquid)", "Liquidity", "Locked")
- Map taxonomy classification names to semantic categories via config:
  CATEGORY_MAP=liquid_equity:America,Developed ex-US,Emerging;illiquid_equity:...;cash:Investable Cash;retirement:CPF,SRS
- Aggregate classification values (per-taxonomy, per-classification) into SGD totals per category
- Include `taxonomy_summary` in getStatus / _compute_status_sgd response:
  {
    "taxonomy_summary": {
      "liquid_equity": 224483.87,    // SGD
      "illiquid_equity": 45000.00,
      "cash": 58006.43,
      "retirement": 0.00
    },
    "taxonomy_breakdown": {
      "liquid_equity": {"America": 89920.92, "Developed ex-US": 60914.98, "Emerging": 73647.97},
      "cash": {"Investable Cash": 58006.43},
      "illiquid_equity": {},
      "retirement": {}
    }
  }
- Reuse existing _fetch_live_rates() for SGD conversion on per-currency native values
- Taxonomy query must use same price-selection logic as existing queryTaxonomies (most-recent-≤-today)

Edge cases:
- No CATEGORY_MAP configured → skip, return empty taxonomy_summary
- Taxonomy name not found in PP file → skip that taxonomy, warn in logs
- Classification in map not found in taxonomy → set category value to 0
- FX rate unavailable for a currency → omit from SGD total, warn
- Empty taxonomy values → return zeros for all categories
- Multiple taxonomies map to same category → values sum across taxonomies
