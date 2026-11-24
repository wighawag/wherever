# conversation-search-newest-first: in-scope decisions (2026-11-24)

1. **`sort` is trimmed before validation.** `parseSort()` (`server/src/conversation-search.ts`) trims, so `sort=%20recent%20` is accepted and whitespace-only is relevance. Chosen for symmetry with `parseSince()`, which also trims. Alternative: exact match only. Touches only `GET /search`.

2. **The error message names both valid values** (`Invalid \`sort\`: "x" (use \`relevance\` or \`recent\`).`). The wire name stays `sort` (as the task says) although memonaut's option is `order`; `SearchSort` / `SEARCH_SORTS` mirror memonaut's `SearchOrder` / `SEARCH_ORDERS` rather than importing them, because memonaut is an optional, dynamically imported dependency typed structurally here.

3. **Relevance requests send no `order` at all** (not `order: 'relevance'`) and keep memonaut's limit at the requested `limit`, with no cap passed to `filterHits`, so relevance output is byte-for-byte as before. Alternative: always send `order` and always cap (behaviourally identical, but a wider diff of the relevance path).

4. **The over-fetch cut is a new optional `cap` argument on the exported `filterHits()`**, not a separate loop. With no cap it behaves exactly as before; with one it stops once `hits.length >= cap`, so `hiddenHits` counts only hidden results above the cut.

5. **Web control is a two-button segmented toggle** (`role="group"`, `aria-pressed`), not a `<select>` like the date range: there are only two options and the task calls it a toggle. Storage key `wherever-search-sort`, absent meaning Relevance (Relevance removes the key, as Any time does for the range). The request helper only sends `sort=recent`; Relevance is left out as the server default, matching how `searchRequestParams` leaves out every other default.

6. **The "relevance output unchanged" test compares responses with `score` stripped**, because memonaut's recency nudge is computed against the clock, so two consecutive requests differ in the last digits of `score`.

7. **Manual check of the toggle (persist + immediate re-run) was NOT performed in a browser on this run** (headless agent). It is covered by code reading: `changeSort()` writes storage and calls the same `rerunNow()` the date range uses (clears the debounce, respects `MIN_QUERY`, goes through the store's abort/supersede path), and the storage round-trip is unit-tested in `web/src/lib/core/search-sort.test.ts`. A human should confirm it by hand.
