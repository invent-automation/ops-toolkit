# Stacklab Ops Toolkit — Developer Environment

This document is the first thing any Claude Code session should read 
before building anything in this repo. It covers the full stack, 
deployment process, and standard build pattern.

> **End every Claude Code session with DEVSUM** to generate a structured 
> handoff report. Bring that report back to the MRP project chat to 
> update the context docs. DEVSUM prompt is defined in CLAUDE.md.

---

## Local Setup

- Repo is cloned and lives at: /Users/jordan/ops-toolkit
- Open Claude Code (Code tab in Claude Desktop)
- Select /Users/jordan/ops-toolkit as the working directory
- Claude Code will auto-pull from GitHub at the start of each session
  and wait for you to say "push" before sending changes back

You never need to touch Terminal — Claude Code handles 
git pull and git push from inside the session.

---

## Repo

- **GitHub:** https://github.com/StacklabOperations/ops-toolkit
- **Hosted at:** GitHub Pages (check repo Settings → Pages for live URL)
- **Structure:**
  - `index.html` — main landing page / tool directory
  - `tools/` — one HTML file per tool + one spec MD per tool
  - `assets/` — shared images/icons
  - `worker/worker.js` — Cloudflare Worker source (version controlled here)
  - `STACKABL_APPS_STYLE_GUIDE.md` — UI design system, read before any UI work
  - `CLAUDE.md` — Claude Code session instructions (auto-loaded)
  - `DEV_ENVIRONMENT.md` — this file

---

## API Layer — Cloudflare Worker

All Aligni API calls go through this Worker. Never call Aligni directly 
from the frontend. Never put the API token in any frontend file.

- **Worker URL:** https://stackabl-aligni-proxy.operations-dae.workers.dev
- **Cloudflare dashboard:** dash.cloudflare.com → Workers & Pages → stackabl-aligni-proxy
- **Secret stored in Cloudflare:** ALIGNI_TOKEN (encrypted, never in code)

The Worker is a dumb GraphQL proxy — it accepts any POST, injects the 
token, forwards to Aligni, returns the response. No routing logic.

To call it from a tool:
  fetch('https://stackabl-aligni-proxy.operations-dae.workers.dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `...`, variables: {} })
  })

Worker source code lives at worker/worker.js in this repo.

---

## Aligni — PLM System

- **Site:** https://stacklab.aligni.com
- **GraphQL endpoint:** https://stacklab.aligni.com/api/v3/graphql
- **GraphiQL explorer:** https://stacklab.aligni.com/api/v3/graphiql
- **API version:** v3 (GraphQL — current and supported)
- **Auth:** Token injected by Worker — not needed in frontend

### Critical data model facts
- Parts have a numeric Partnumber (e.g. 100463) and a human-readable 
  Manufacturer P/N / MPN (e.g. SA-CUT-DISC5-FT-529CHAM3)
- Always look up parts by MPN (manufacturerPn field) not Partnumber
- manufacturerPn is the correct camelCase filter field — manufacturer_pn 
  is rejected
- Part 100464 is a generic pivot part — always exclude from queries
- Felt parts: part type "Felt", UOM sqft, native unit (already converted 
  from Bolt Yards by Aligni, 1 Bolt Yard = 17.49 sqft)
- Cut disc parts: part type "Sheet-Cut Profile", UOM each
- Operations: part type "Operations General", UOM each
- BOMs are called "Part Lists" in Aligni — BOM line items are called 
  "subparts" in the GraphQL API (not "part list items")
- Part must be in DRAFT revision state to edit its BOM
- Revision names are integers as strings: "1", "2", "3" — when creating 
  a new revision scan ALL revisions (not just active) to find the true 
  max and increment from there; preserve zero-padding ("01" → "02")
- Rate limit: confirmed 10 req/min (account should be 30/min — support 
  ticket open); use 6100ms delay between calls until resolved, then 
  drop to 2100ms once Aligni upgrades the account
- Always introspect live schema before writing mutations — never guess 
  field names

### GraphQL API quirks (discovered in production)
- Filter values must be inlined into query strings — OperatorScalar type 
  rejects GraphQL String variables ($mpn: String! causes type mismatch)
- Filter syntax: filters: [{ field: "name", value: { eq: "..." } }]
  Available operators: eq, gt, lt, gte, lte, in, notIn
  No contains/cont operator exists — name searches must fetch all records 
  and filter client-side (in the Worker)
- errors field on all mutation payloads is a String scalar — query as 
  errors not errors { message }
- subpartCreate requires the component's revision ID not the part ID 
  (subpartPartRevisionId field)
- partRevisionActivate does not exist — activation is done via 
  revisionActive: true on PartRevisionReleaseInput when calling 
  partRevisionRelease — this releases and activates in one call
- PartRevisionUpdateInput does not accept an active field
- partRevisionDelete mutation name is not yet confirmed in production — 
  treat as unverified until tested
- contactCreate.vendorId is Int (the vendor's legacyId), not a ULID ID —
  always fetch or pass legacyId when creating a contact for a vendor
- No contactDeactivate mutation exists and ContactInput has no active field;
  contactDelete is the only option and is a hard delete
- ManufacturerCreateInput and VendorCreateInput do not accept address or 
  phone — these are separate entities (addressCreate / phoneNumberCreate)
  not yet implemented

### GraphQL operations reference — parts & BOM (confirmed working)
- parts(filters) query: lookup by manufacturerPn; returns part ID, 
  partNumber, all revisions with status/active/subparts
- subpartDelete(subpartId): removes an existing BOM line item
- partRevisionCreate(sourcePartRevisionId, partRevisionInput): creates 
  new draft from a released revision; input fields revisionName, 
  revisionReason
- subpartCreate(subpartInput): adds a BOM line; requires partRevisionId 
  (assembly revision) + subpartPartRevisionId (component active revision)
- partRevisionRelease(partRevisionId, partRevisionReleaseInput): releases 
  a draft; use revisionActive: true to simultaneously set as active

### GraphQL operations reference — vendors, manufacturers & contacts (confirmed working)
Schema introspected 2026-04-29. All confirmed against live schema.
- manufacturers(first: N) query: returns nodes { id legacyId name website }
- vendors(first: N) query: returns nodes { id legacyId name website }
- vendor(id: ID) query: returns contacts { nodes { id legacyId firstName 
  lastName email jobPosition canReceivePos canReceiveRfqs } }
- contacts(first: N) query: returns nodes { id firstName lastName email 
  jobPosition }
- manufacturerCreate(manufacturerInput): required name; optional shortName, 
  website, nextPartNumber, partnumberKey
- vendorCreate(vendorInput): required name; optional shortName, website, 
  accountNumber, approvedAt, approvalExpiresAt, currencyId, 
  defaultPaymentTerms, portalEnabled
- linecardCreate(linecardInput): links a manufacturer to a vendor; required 
  manufacturerId (ULID ID) and vendorId (ULID ID)
- contactCreate(contactInput): required lastName; optional firstName, email, 
  jobPosition, vendorId (Int — legacyId, not ULID), canReceivePos, 
  canReceiveRfqs
- contactDelete(contactId: ID!): hard-deletes a contact; no deactivate exists
- contactUpdate(contactId: ID!, contactInput: ContactInput!): updates 
  contact fields (same fields as contactCreate)

### Custom parameters on Felt parts
- Thickness (mm): "3" or "4.8" (4.8mm marketed as 5mm)
- Colour/Sheen: display name (e.g. "Charcoal", "Ivory")

### Disc geometry (for inventory calculations)
- 5in disc: 0.252 sqft per disc
- 8in disc: 0.570 sqft per disc
- Linear inches formula: (sqft / disc_sqft) × thickness_mm / 25.4

### Inventory quantity tiers
- On Hand, Reserved, Allocated, Available
- Always use Available for calculations (not On Hand)

---

## Cloudflare Worker patterns

### In-memory caching
Use module-level variables for short-lived caches to avoid hammering the 
Aligni API on repeated lookups (e.g. typeahead searches). Standard TTL is 
5 minutes (300,000 ms). Caches are best-effort — they persist across warm 
isolate reuses but reset on cold start or when the isolate is recycled.

```javascript
let _cache = null, _cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getCached(token) {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;
  _cache = await fetchFromAligni(token);
  _cacheAt = Date.now();
  return _cache;
}
```

Bust the cache (set to null) immediately after a create/update mutation so 
the next read reflects the new record.

### String escaping for inlined GraphQL values
Since OperatorScalar rejects GraphQL variables, all dynamic values must be 
string-interpolated into query text. Always escape them first:

```javascript
function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}
```

---

## How to Build a New Tool

1. Read this file
2. Read STACKABL_APPS_STYLE_GUIDE.md — follow it exactly for all UI
3. Read an existing tool in tools/ for structure reference
4. Build the tool as a single self-contained HTML file in tools/
5. All CSS and JS lives inside the HTML file — no external files
6. Add a link to the new tool in index.html (follow existing pattern)
7. Save a spec file alongside it: tools/[tool-name]-spec.md
8. The spec should document: what it does, how it works, what GraphQL 
   operations it uses, any gotchas or Aligni quirks discovered
9. Run DEVSUM at end of session and bring report to MRP project chat

---

## How to Deploy

Changes pushed to the main branch on GitHub automatically deploy via 
GitHub Pages. No build step required — it's static HTML.

Claude Code handles deployment — just say "push" and it will:
  git add .
  git commit -m "describe what was built"
  git push origin main

---

## Tools Built So Far

| Tool | File | What it does |
|------|------|-------------|
| Felt Inventory Dashboard | tools/felt-dashboard.html | Live felt inventory with available sqft and linear inch calculations by colour |
| BOM Importer | tools/bom-importer.html | Bulk import BOM CSVs to Aligni via drag and drop with dry-run preview and release workflow |

---

## Open Issues

- Aligni rate limit stuck at 10 req/min — support ticket open to activate 
  30/min plan entitlement. Once resolved, change IMPORT_DELAY in 
  tools/bom-importer.html line ~407 from 6100 to 2100.
- tools/bom-importer-spec.md not yet created — Claude Code to generate 
  on next session.
- Full 37-file BOM batch not yet tested end-to-end — pending rate limit fix.

---

## Future Integrations Planned

- HubSpot → Aligni: Closed Won deal triggers build creation in Aligni
- Inventory webhooks: Aligni stock change → HubSpot task for sales team
- COGS analysis: purchase history × build consumption records
- Demand estimator / revenue modelling dashboard
