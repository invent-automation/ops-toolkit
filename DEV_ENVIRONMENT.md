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
- Part 100464 is a generic pivot part used in BOMs. The felt-inventory dashboard
  excludes it locally because the linear-inch math requires real felt inventory.
  Other tools (MCP search, BOM importer reads, etc.) should NOT exclude it —
  the exclusion is specific to that dashboard's calculation, not a global rule.
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

## Migration Awareness

There is an active Stacklab data migration running in a separate Claude project. A Stackabl
migration is expected to follow once Stacklab is complete. Both reshape part master data,
BOM structure, naming conventions, finishes, vendors, and drawings.

Tools built here touch live Aligni. The migration and the ops toolkit are in different
projects but share the same data, so what gets built here can make migration work harder
if it's not migration-aware.

**What's safe to build now:** Read-only tools are always safe. Tools that write transactional
records — deviations, inventory adjustments, build operations — are also safe. These operate
on operational state, not the master data being restructured by the migration.

**What requires care:** Tools that write master data (creating parts, editing BOMs, defining
finishes, creating manufacturers or vendors, setting up alternate-part relationships) are
migration-adjacent. These touch the same structures the migration is reshaping. Build them
with caution: prefer manual steps in chat or the Aligni UI until the migration's schema
decisions are settled, or design them to be easy to update once the migration lands.

Tools that embed part-naming or part-structure assumptions (hardcoded MPN patterns like
`SA-CUT-DISC[5|8]-FT-`, for example) will need updating when naming conventions change.
Keep those assumptions in named constants at the top of the file or in a small config
block — not scattered through the logic — so post-migration cleanup is tractable.

Generic-by-design tools survive migration better than family-specific ones. Where
reasonable, build a primitive that works on any part type and put the family-specific
logic in the caller (chat session, future UI, n8n workflow).

**When in doubt:** If a new tool might conflict with migration decisions, ask before
building. The migration project has its own context and the user is the bridge between
the two projects. A five-minute check is cheaper than rework after the migration lands.

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

## MCP Server (Agent Interface)

The MCP server exposes Aligni read access to Claude.ai and other MCP clients.

- **Worker source:** `workers/stackabl-mcp/index.js`
- **Worker URL:** `https://stackabl-mcp.operations-dae.workers.dev`
- **MCP endpoint:** `https://stackabl-mcp.operations-dae.workers.dev/mcp`
- **Protocol:** Streamable HTTP (MCP spec 2025-03-26) — JSON responses, no SSE
- **Auth:** OAuth 2.0 + PKCE, single-user consent page at `/authorize`
- **Token storage:** Cloudflare KV namespace `MCP_AUTH` (rotatable without redeploy)
- **IP allowlist:** Anthropic outbound `160.79.104.0/21` on `/mcp` (belt-and-suspenders)
- **Spec:** `tools/mcp-server-spec.md`

### Connecting Claude.ai
1. Settings → Integrations → Add custom integration
2. Enter: `https://stackabl-mcp.operations-dae.workers.dev/mcp`
3. Complete the OAuth consent flow (opens `/authorize` in your browser)

### After deploying MCP changes
After `wrangler deploy`, Claude.ai needs a tool list refresh before new tools appear:
1. Open Settings → Integrations → find the stackabl-mcp integration
2. Trigger a refresh (the "Tools list refreshed" toast confirms it)
3. **Start a new conversation** — existing conversations cache the tool list from when
   they were opened and will not pick up new tools even after a refresh

### Deploying / updating
```
cd workers/stackabl-mcp
wrangler deploy
```
Secrets: `ALIGNI_TOKEN` (same value as `stackabl-aligni-proxy`).
KV namespace `MCP_AUTH` must be created and IDs filled in `wrangler.toml` before first deploy.

### Phase 1 tools (read-only)
| Tool | What it does |
|------|-------------|
| `search_parts` | Substring search across MPN, revision description, revision comment |
| `get_part` | Full part detail: revision, custom params, single-level BOM |
| `get_inventory` | Live on-hand / available quantities with location breakdown |
| `search_vendors` | Vendor name search |
| `get_vendor` | Full vendor detail with contacts |
| `search_manufacturers` | Manufacturer name search |
| `aligni_introspect` | Schema inspection: `describe_type` (type fields/inputs/enums) and `find_in_schema` (substring search across types, queries, mutations). Development-time tool — does not fetch live data. |

---

## Tools Built So Far

| Tool | File | What it does |
|------|------|-------------|
| Felt Inventory Dashboard | tools/felt-inventory.html | Live felt inventory with available sqft and linear inch calculations by colour |
| BOM Importer | tools/bom-importer.html | Bulk import BOM CSVs to Aligni via drag and drop with dry-run preview and release workflow |
| MCP Server | workers/stackabl-mcp/index.js | Phase 1 read-only MCP server: 7 Aligni tools for Claude.ai |

---

## Open Issues

- Aligni rate limit stuck at 10 req/min — support ticket open to activate 
  30/min plan entitlement. Once resolved, change IMPORT_DELAY in 
  tools/bom-importer.html line ~407 from 6100 to 2100.
- Full 37-file BOM batch not yet tested end-to-end — pending rate limit fix.

---

## Future Integrations Planned

- HubSpot → Aligni: Closed Won deal triggers build creation in Aligni
- Inventory webhooks: Aligni stock change → HubSpot task for sales team
- COGS analysis: purchase history × build consumption records
- Demand estimator / revenue modelling dashboard
