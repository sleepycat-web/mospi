# AnkSetu — Data inventory: what is fetched live vs hardcoded

**How live data works:** `api/data.js` calls `api.mospi.gov.in`, builds `/data.json`, and the app validates each block before overlaying it on the snapshot built into `index.html`. If a block fails or the API is down, the app keeps showing the snapshot for that part.

Legend: ✅ live from the API · 🟡 hardcoded, update occasionally · 🟢 fine as hardcoded

---

## 1. Live from api.mospi.gov.in

| Data | API endpoint | App field | Latest period (11 Nov 2026) |
|---|---|---|---|
| ✅ Retail inflation: headline all / rural / urban, index | `cpi/getCPIData` (division 0, All India) | `DATA.cpi.headline`, `.index` | Sep 2026 |
| ✅ Food inflation all / rural / urban | `cpi/getCPIData` (group "Food", 01.1) | `DATA.cpi.food` | Sep 2026 |
| ✅ 12 CPI divisions | `cpi/getCPIData` | `DATA.cpi.div` | Sep 2026 |
| ✅ CPI for 36 states/UTs | `cpi/getCPIData` (all states) | `CPI_ST` | Sep 2026 |
| ✅ Top 5 / bottom 5 items by price change | `cpi/getCPIData` (item rows, combined) | `DATA.cpi.items` | Sep 2026 |
| ✅ IIP overall, index, 3 sectors, 6 use-based | `iip/getIipData` (General, Sectoral, Use-based) | `DATA.iip` | **Sep 2026** (snapshot: Aug) |
| ✅ IIP 23 manufacturing groups (NIC) + total | `iip/getIipData` (Sectoral sub-categories) | `INDUSTRY.iip`, `INDUSTRY.iipTotal` | **Sep 2026** (snapshot: Aug) |
| ✅ GDP real / GVA / nominal growth, level | `nas/getNASData` (indicators 5, 21, 22, quarterly) | `DATA.gdp` | Q1 2026-27 |
| ✅ Primary / secondary / tertiary growth | Computed from GVA levels (indicator 1) | `DATA.gdp.sectors` | Q1 2026-27 |
| ✅ GVA by 8 industries (levels + growth) | `nas/getNASData` (indicators 1, 21) | `INDUSTRY.gva` | Q1 2026-27 |
| ✅ Unemployment, LFPR, WPR (All India, by sex and rural/urban, age 15+) | `plfs/getData` (monthly, frequency 3) | `DATA.plfs` | Sep 2026 |
| ✅ State LFPR, female LFPR, WPR (22 states) | `plfs/getData` (quarterly bulletin, frequency 2) | `LFPR_ST`, `LFPRF_ST`, `WPR_ST` | **Jul–Sep 2026** (snapshot: Apr–Jun) |
| ✅ "States like X" groupings | Recomputed in `data.js` (k-means, same method as the app) | `ML_PEERS` | Matches the live state tables |

Every live value was checked against the snapshot for the same period. They match exactly, including the computed broad sectors and the k-means groupings for inflation.

**Notes:**
- The API returns the **actual** five biggest risers and fallers among all CPI items. For Sep 2026 that adds *Coconut oil* (−29.5%) and *Peas, chickpeas* (−7.6%), which the hand-picked snapshot list didn't have.
- Items not in the snapshot get Hindi names from a small map in `data.js` (`CPI_ITEM_HI`); any others show in English.
- MoSPI publishes monthly PLFS for All India only, so monthly figures stay national. State figures come from the quarterly bulletin, which covers 22 states.
- The whole fetch takes about 1 second. Nothing is cached, so every page load or refresh gets fresh data from MoSPI. Timeouts are retried twice.

---

## 2. Hardcoded, update occasionally

| Data | Where | When | Notes |
|---|---|---|---|
| 🟡 Release calendar | `UPCOMING` | When MoSPI revises its advance release calendar | Not in the API. The app warns users when a listed date has passed |
| 🟡 Outlook projections (ARIMA) | `OUTLOOK` | Once a year, after annual figures are final | Fitted offline on 8–10 years of annual data |
| 🟡 Release PDF links | `SRC` | Each snapshot refresh | Live blocks link to the MoSPI homepage, because the API doesn't return press-release URLs |
| 🟡 Release dates for live data | `relDate()` in `data.js` | — | Estimated (CPI ~12th, IIP ~28th, PLFS ~15th, GDP ~end of the second month after the quarter). The API doesn't return release dates |
| 🟡 Snapshot itself | `DATA`, `PD`, `SNAP`, … | Optional | Only a fallback now. Refreshing it occasionally keeps the app useful if the API is down |

**Not in the API at all:** the state-wise unemployment rate (the app shows labour force participation instead) and district or city figures.

---

## 3. Fine as hardcoded (reference data, not statistics)

| Data | Where |
|---|---|
| 🟢 State/UT list, codes, tile-map positions, Hindi names, aliases | `STATES` |
| 🟢 City → state map, out-of-scope words | `CITY`, `FOREIGN`, `UNSUP` |
| 🟢 Question classifier and its evaluation | `ML_INTENT`, `ML_TH`, `ML_EVAL` |
| 🟢 Indicator definitions, labels, glossary, all EN/HI text | `IND`, `TOPICS`, throughout |
| 🟢 Example budget for the Prices tool (labelled as a sample) | `EXAMPLE` |
| 🟢 Validation ranges that reject broken API data | `R_INFL`, `R_GRO`, `R_PCT` |

---

## 4. Checking it yourself

Open **/fetch.html** (locally: http://localhost:3000/fetch.html) for a live status table, with a Refetch button.

```bash
node dev.js
curl -s http://localhost:3000/data.json | python3 -m json.tool | less
```

- `blocks` holds what was sent.
- `errors` shows a block that failed entirely.
- `skipped` lists optional parts that were dropped (for example `items` or `groups`) while the rest of the block was still sent.
- In the app, the sidebar dot is green when live data was applied. The Sources screen lists every block and any the app rejected.
