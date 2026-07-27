# System Context — Financials, Entities, and Systems of Record

Status: living document. Source of truth for how the companies, money, and
systems actually work, so every module the operating layer builds is grounded
in reality rather than assumption.

Provenance: Section 1–7 below is a context handoff prepared by the owner's
Financials (Cowork) project on 2026-07-26, reproduced faithfully. Confidence
tags are the author's: **[KNOWN]** verified that engagement · **[INFERRED]**
strong evidence, unconfirmed · **[UNKNOWN]** needs owner confirmation. Treat
[INFERRED]/[UNKNOWN] items as open until confirmed. Section 8 is the operating
layer's reconciliation notes.

> Entities: FS · BL/BLCS · USA · Cultivus+ · FSI Acquisition · (Coaching).
> Commonly owned by Tim Clark — there is **no single parent holding company**.
> "Clark Holdings" appears in some internal tooling labels but is **not a real
> entity** — do not use it.

---

## 1. Entities & how they relate

- **FS — Fastening Specialists.** Fastener distribution; largest legacy operating
  company. System of record: Acumatica (Production). **The group's bank** — funds
  the other entities via intercompany advances. Target ~58% gross margin. [KNOWN]
- **BL / BLCS — Big League Construction Supply.** Construction / erosion-control /
  geosynthetics distribution. Acumatica (Production). Bulk-order revenue, ~30%
  margin. **Negative book equity** (accumulated losses + $1.91M owed to FS). [KNOWN]
- **USA — Utility Supply Associates.** Waterworks / utility distribution. Separate
  books, not in Acumatica ([INFERRED] QuickBooks). New entity, stand-up phase;
  well-capitalized, deploying into inventory since ~Mar 2026. **Prepaid model — no
  AR.** [KNOWN]
- **Cultivus+.** Single-member LLC (disregarded for tax). Two lines: (a)
  media/content production, (b) contractor-staffing — bills Faulkner & JDC for
  international contractors at ~2× cost. Separate books ([INFERRED] QuickBooks).
  Funded by FS/BL via card spend + FS-paid contractors; BL sponsors it ($125k
  platinum sponsorship). [KNOWN]
- **Coaching.** [UNKNOWN] — appears in the month-end close entity list; no
  financial visibility this engagement.
- **FSI Acquisition Corp.** **Propco** — holds the building FS/BL operate out of;
  carries the ServisFirst mortgage; charges rent. QuickBooks (Warren's small TB).
  Opco/propco split; funded by FS ($2.24M intercompany). Consolidates with FS+BLC
  for the tax return. [KNOWN]
- **Central Florida Park LLC.** The vendor rent (~$23,834/mo) is actually paid to
  in the GL. Acumatica AP (as a vendor). [UNKNOWN] whether FSI dba or separate
  propco — **resolve before consolidating.**

**Intercompany web (7/31/2026) [KNOWN]:** FS is owed **~$4.15M** by the group —
Big League $1.91M, FSI Acquisition $2.24M, Central FL Pkwy $1.7k. Reciprocals tie
cleanly. **Tax consolidation = FS + BLC + FSI.** Cultivus (disregarded) flows to
the owner; USA appears to file on its own.

## 2. Systems of record

- **Acumatica ERP** — `bigleaguecs.acumatica.com`, company "Production". System of
  record for **FS + BLC only**: GL, AR, AP, Inventory, Sales Orders, bank rec.
  Live but **recently migrated (2025)**; data/ERP vendor **247Digitize LLC**
  (appears as "Created By" on migrated docs; posts Corpay bills). Dec 2025 carries
  migration-cleanup entries; 1099-vendor flags not maintained. Key screens:
  `AR3020PL` (Payments & Applications), `AP3010PL/AP301000` (Bills), `CA3020PL`
  (bank recs), `GL404000` (account detail), **"Sales Profitability by Salesperson
  and Customer"** (sales scorecard source), Balance Sheet export, Inventory
  valuation. Reports run **"Released Transactions Only."** [KNOWN]
- **QuickBooks** — [INFERRED] system of record for **FSI, USA, Cultivus**. FSI
  confirmed by external CPA. **Biggest visibility gap** — new-entity P&Ls invisible
  from Acumatica.
- **CRM** — [UNKNOWN]. Paid subs seen: **Pipedrive** (~$3.6k YTD), GoHighLevel,
  Apollo.io. Which holds the pipeline is unconfirmed.
- **Spend** — **Corpay** (card program; statements post to Acumatica AP as monthly
  "CORPAY AutoPay" bills with cardholder + merchant + GL detail). **AMEX Business
  Gold** (Coghlan/Fowler — effectively the USA/FS ops card). [KNOWN]
- **Banking** — **ServisFirst** (term loans incl. FSI mortgage *47531 @ 6.25%, LOC
  *47532, operating accts), plus Fairwinds, Ford Motor Credit, Wells Fargo
  Financial Leasing. **No live bank feed — balances typed in by Tim.** [KNOWN]
- **ClickUp** — month-end close tracking (close lists per entity). [KNOWN]
- **Google Drive** — `G:\My Drive\FS_BL_USA_FINANICALS\` document hub; daily CFO
  packet exports land here. Access via the Drive connector, not the raw mount. [KNOWN]
- **Track-POD** — logistics/delivery for the FS/BL fleet (~$72/stop, $2.09/mi). [KNOWN]

## 3. Scorecard KPI definitions, sources & current production method

**Critical meta-point:** none of these are automated today. They are produced by
**manual export from Acumatica → hand-processing in spreadsheets / a hand-built
dashboard**, on a lagging released-only basis. Bank cash is **manually typed in.**
This is the state a governed operating system would replace.

- **Revenue** — net sales, released, MTD. Source: Acumatica "Sales Profitability".
  Manual morning export; **lags** (later releases restate prior days).
- **Gross Profit %** — GP ÷ net sales. Targets are floors: FS 58%, BL 30%. Manual;
  below-floor deals flagged red and quantified.
- **DSO** — AR ÷ (sales/day). [UNKNOWN] avg vs period-end AR, day-count. Acumatica
  AR; [INFERRED] manual from aging.
- **DPO** — AP ÷ (COGS/day). Acumatica AP; [INFERRED] manual.
- **DIO** — Inventory ÷ (COGS/day). Acumatica inventory; [INFERRED] manual, periodic.
- **Inventory Turns** — COGS ÷ avg inventory (annualized). [INFERRED] manual.
- **AR Collections $** — cash received against AR in period. Acumatica `AR3020PL`.
  Manual register export.
- **Open Orders** — open SO backlog $. Acumatica SO. Manual; **export scope is a
  known data-quality risk** (implausible/partial PO exports seen before).
- **Fill Rate** — lines/units shipped ÷ ordered. [UNKNOWN] production method.
- **On-Time** — deliveries on/before promise. [INFERRED] Track-POD + Acumatica
  ship dates. [UNKNOWN] production method.

**Sales-team scorecard [KNOWN]:** BLC = $430k rev/mo @ 30% GP floor; per-rep mins
(Tyler $150k, Nick $150k, Cody $100k). FS = $1M rev/mo @ 58% GP floor; GP$
leaderboard, no per-rep mins. Pace = 21.67 business days/mo. Sub-floor deals need
Tim's sign-off **before quoting.**

**Data-lag reality [KNOWN, important]:** "Released Transactions Only" morning
reports **understate the day** (a single day moved +$17.5k after the fact).
Current method: daily $ = delta between consecutive morning MTD exports, each
board stamped "released as of [timestamp]". Owner's operational fix: **same-day
ship → invoice → release.** A governed system should treat **released vs. shipped
vs. open as distinct states and timestamp everything.**

## 4. AR / collections reality (per entity)

- **FS & BL** — AR in Acumatica (acct 110-0 AR Trade). Aging via Acumatica AR
  aging report; collections activity via `AR3020PL`. Past-due / over-90 tracked in
  the daily snapshot. **Collections owner & cadence: [UNKNOWN] — confirm.** Binding
  friction is upstream: **unreleased invoices delay billing and cash.** [KNOWN]
- **USA** — **prepaid, no AR.** [KNOWN]
- **Cultivus** — real AR: **Faulkner & JDC contractor billings** (~2× cost, heading
  past $100k by year-end, **largely uncollected**). On Cultivus's own ledger, not
  Acumatica. Also **FS's working-capital exposure** (FS fronts the contractor cost,
  waits on Cultivus to collect). [KNOWN]
- **FSI / Coaching** — [UNKNOWN].

**First Collections-bridge source:** FS/BL = Acumatica AR aging + `AR3020PL`. USA
out of scope (prepaid). Cultivus AR on a separate ledger — needs the QuickBooks
connection.

## 5. Month-end close

Tracked in **ClickUp** (close lists per entity: FS, BLCS, USA, CULTIVUS+,
COACHING), monthly. GL sources: Acumatica for FS/BL; QuickBooks for FSI ([INFERRED]
USA/Cultivus). Bank recs in Acumatica (`CA3020PL`). External CPA **"Warren"** does
the tax return (FS + BLC + FSI consolidated) and sends adjusting JEs back for Tim
to process. 2025 return in progress (pending FSI financials + depreciation). Full
close checklist per entity: [UNKNOWN — get the ClickUp close-list templates].

## 6. Existing automations / integrations

- **247Digitize** — ERP/data ops layer (ran the migration, posts Corpay bills,
  generates daily snapshot inputs). Closest thing to an existing automation. [KNOWN]
- **Daily financial snapshot** — semi-manual: Acumatica exports + bank balances
  typed in by Tim → consolidated xlsx + one-page PDF to the FINANCIALS folder.
- **Vantage dashboard** — hand-built single-file HTML, manually refreshed; current
  "cockpit" for FS/BL P&L, anomalies, cash, intercompany reconciliation.
- **Track-POD** — logistics; a route-planner agent exists in shadow mode (needs a
  read-only key).
- **Net state: export-driven and manual, not live-integrated.** No connector feeds
  Acumatica or the bank into a governed store. The **QuickBooks connector**
  (available, not connected) and an **Acumatica read path** are the two unlocks.

## 7. Open questions to resolve with the owner

1. Which system holds **USA and Cultivus books** (QuickBooks assumed).
2. **CRM system of record** (Pipedrive vs. GoHighLevel vs. other).
3. **FSI Acquisition vs. Central Florida Park LLC** — same entity or two?
4. **Collections owner & cadence per entity.**
5. **Exact TractionOS definitions** for DSO/DPO/DIO/turns/fill-rate/on-time.
6. **Coaching** — what it is and where it lives.
7. **FS balance sheet out of balance by $17,476.88 (7/31/2026)** — a data-quality
   flag any governed system should catch on ingest.

---

## 7a. Source-of-truth decision (owner, 2026-07-27)

**Acumatica (the ERP) is the source of truth for the operating system.** The
actual sales, revenue, orders, AR, and financials live in the ERP. **Pipedrive
(CRM) is a status overlay only** — it tracks where a deal sits in pursuit, not
the real numbers. Therefore the **Acumatica read connector is the central data
wire**, feeding Collections (AR aging), the scorecard (revenue, GP%, DSO, DPO,
DIO, orders, inventory), and the customer money picture. The Pipedrive Sales
doorway (already live) stays as the deal-pursuit hygiene layer on top, not the
truth. Today the only Acumatica access is the finance project driving the web
UI in a browser; the durable wire is Acumatica's REST API with a dedicated
**read-only** API user (a stop-and-ask; read-only; logged in APPROVALS.md).

## 8. Operating-layer reconciliation notes

How the above lands against what is actually deployed. Owner confirmation needed
on the entity model before it is changed.

- **Entity codes — corrected to `FS`.** The operating-layer orgs and their
  canonical codes are: **BLCS** (Big League Construction Supply), **FS**
  (Fastening Specialists), **USA** (Utility Supply Associates), **CULTIVUS**
  (Cultivus Plus). Fastening Specialists was initially mis-seeded with code
  `FSI`; that was wrong, because **`FSI` denotes a real distinct entity — FSI
  Acquisition Corp, the real-estate propco** — so the code was corrected `FSI ->
  FS` across the schema enum (`z.enum(["BLCS","FS","USA","CULTIVUS"])`), services,
  seeds, and tests, and in the production database. Acumatica/TractionOS already
  use `FS`, so the doorways map `FS -> FS` (identity) and `BL/BLC -> BLCS`. FSI
  Acquisition Corp and Coaching remain finance/close entities, **not** OS orgs.
  Do not introduce a "Clark Holdings" org — it is not a real entity.
- **Collections module, sharpened.** First target = **FS + BL**, source = Acumatica
  AR aging + `AR3020PL`. No live Acumatica connector exists yet, so **v1 rides the
  CSV batch-intake doorway** (weekly aging export) — exactly the "file first, brain
  later" path in the blueprint. The ladder is gated on **open question #4**
  (collections owner & cadence) before any draft is sent. High-value **second**
  target = **Cultivus contractor AR** (Faulkner/JDC, >$100k, largely uncollected =
  direct FS working-capital exposure), which needs the QuickBooks connection.
- **Design already fits two hard realities.** (1) "Released vs. shipped vs. open as
  distinct states, timestamp everything" is exactly the operating layer's guarded
  state-machine + immutable audit model. (2) "Catch data-quality breaks on ingest"
  (e.g. the $17,476.88 out-of-balance) is the untrusted-input, validate-before-
  persist, fail-closed rule.
- **Two integration unlocks** match the blueprint's wire list: an **Acumatica read
  path** (via company-brain) and the **QuickBooks connector**. Both stay inert
  until deliberately enabled.
