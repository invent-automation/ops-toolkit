# stackabl-mcp Worker — Spec (Phase 1, Read-Only)

**Worker URL:** `https://stackabl-mcp.operations-dae.workers.dev`  
**MCP endpoint:** `https://stackabl-mcp.operations-dae.workers.dev/mcp`  
**Protocol:** MCP Streamable HTTP transport, version `2025-03-26`  
**Phase:** 1 — read-only. Seven tools. No write operations of any kind.

---

## Architecture

```
Claude.ai
  ↓ OAuth 2.0 + PKCE (consent flow)
  ↓ Bearer token on every request
stackabl-mcp Worker
  ├── OAuth endpoints (/.well-known/*, /authorize, /register, /token)
  ├── IP allowlist check (Anthropic outbound 160.79.104.0/21)
  ├── MCP protocol handler (/mcp)
  └── Direct Aligni GraphQL calls (ALIGNI_TOKEN never leaves the Worker)
```

The Worker is the smart endpoint. It owns all Aligni read logic.  
The MCP protocol is the consumer — Claude.ai is a thin client.

---

## Auth: Minimal Single-User OAuth 2.0 + PKCE

Anthropic's connector spec requires OAuth with user consent. This is the minimum
implementation that satisfies the spec for a single-user deployment.

### Token storage choice: Cloudflare KV
Selected over a hardcoded Worker secret so tokens can be rotated by re-running
the OAuth flow, without a redeployment. KV namespace binding: `MCP_AUTH`.

- **Auth codes:** `code:{uuid}` → `{clientId, redirectUri, codeChallenge, codeChallengeMethod}`, TTL 10 min (single-use)
- **Access tokens:** `token:{uuid}-{uuid}` → `{clientId, issuedAt}`, no TTL (rotated manually by re-authorizing)

### Client registration
Single hardcoded `client_id: stackabl-ops-agent-1`. All DCR registrations return
this same ID — we don't actually issue distinct clients.

### IP allowlist
All `/mcp` requests are also checked against Anthropic's outbound CIDR `160.79.104.0/21`
(sourced from `request.headers.get('CF-Connecting-IP')`). This is belt-and-suspenders —
the bearer token is the primary gate. OAuth endpoints are NOT IP-restricted, because
Jordan's browser hits them during the consent flow.

**Verification needed:** Confirm during live testing whether Anthropic's infrastructure
makes a backend call to `/token`. If so, that endpoint may also need the IP rule.

---

## OAuth Endpoints

All OAuth endpoints accept requests from any IP (required — Jordan's browser initiates
the consent flow).

### `GET /.well-known/oauth-authorization-server`
Returns server metadata per RFC 8414.
```json
{
  "issuer": "https://stackabl-mcp.operations-dae.workers.dev",
  "authorization_endpoint": "https://stackabl-mcp.operations-dae.workers.dev/authorize",
  "token_endpoint": "https://stackabl-mcp.operations-dae.workers.dev/token",
  "registration_endpoint": "https://stackabl-mcp.operations-dae.workers.dev/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

### `GET /.well-known/oauth-protected-resource`
Returns resource metadata per RFC 9728.
```json
{
  "resource": "https://stackabl-mcp.operations-dae.workers.dev",
  "authorization_servers": ["https://stackabl-mcp.operations-dae.workers.dev"]
}
```

### `GET /authorize`
Renders consent page (STACKABL style guide). Query params:
- `client_id` — must equal `stackabl-ops-agent-1`
- `redirect_uri` — where to send the code
- `state` — passed through unchanged
- `code_challenge` — PKCE S256 challenge
- `code_challenge_method` — must be `S256`
- `response_type` — must be `code`

Returns: styled HTML consent page with "Authorize Stacklab Operations" button.

### `POST /authorize`
Same query params as GET. Form body must include `action=authorize`.  
On success: redirects to `redirect_uri?code={uuid}&state={state}`.

### `POST /register`
Dynamic Client Registration (RFC 7591). Accepts any registration body.  
Always returns the same hardcoded `client_id`. Status 201.

### `POST /token`
Accepts `application/json` or `application/x-www-form-urlencoded`.

Required fields: `grant_type=authorization_code`, `code`, `redirect_uri` (if provided at auth), `code_verifier`.

On success:
```json
{
  "access_token": "{uuid}-{uuid}",
  "token_type": "bearer",
  "expires_in": 31536000
}
```

Error responses follow RFC 6749: `invalid_grant`, `unsupported_grant_type`, etc.

---

## MCP Endpoint

### `POST /mcp`
Handles all MCP JSON-RPC traffic. Requires:
1. IP from `160.79.104.0/21` (when `CF-Connecting-IP` is present)
2. `Authorization: Bearer {token}` matching a live KV entry

Returns `application/json` (no SSE streaming in Phase 1).

### `GET /mcp`
Returns `405 Method Not Allowed`. SSE server-push not implemented.

### MCP methods supported
- `initialize` → returns capabilities
- `notifications/initialized` → 202 Accepted
- `tools/list` → returns all 7 tools
- `tools/call` → dispatches to tool implementation
- `ping` → returns `{}`

---

## Tools

### 1. `search_parts`

**Description:** Search parts by substring across manufacturer PN, revision description,
and revision comment. No exclusions — all parts including generic pivot parts are returned.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query":        { "type": "string", "description": "Substring to match" },
    "partTypeName": { "type": "string", "description": "Filter by part type name, e.g. \"Felt\"" },
    "collection":   { "type": "string", "description": "Filter by manufacturer family name" }
  },
  "required": ["query"]
}
```

**Search fields (confirmed via schema introspection 2026-05-06):**
- `Part.manufacturerPn`
- `PartRevision.description` (exists — confirmed in introspection)
- `PartRevision.comment`

Note: Aligni has no `contains` filter operator. The Worker fetches all parts (paginated,
cached 5 min) and filters client-side. First search after cache miss may take several
seconds due to the 6100ms inter-request delay on pagination.

**Aligni GraphQL:**
```graphql
parts(first: 200, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes {
    id partNumber manufacturerPn
    partType { name }
    manufacturerFamily { name }
    activeRevision { revisionName comment description }
  }
}
```
Paginated until exhausted. Result cached 5 min in module-level variable.

**Output shape (per item):**
```json
{
  "partNumber": "100463",
  "manufacturerPn": "SA-CUT-DISC5-FT-529CHAM3",
  "partType": "Sheet-Cut Profile",
  "collection": "FilzFelt",
  "activeRevisionName": "2",
  "comment": "5-inch charcoal disc"
}
```

---

### 2. `get_part`

**Description:** Full part detail including active revision, custom parameters, and
single-level BOM (subparts of the active revision only — no recursion).

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "manufacturerPn": { "type": "string", "description": "MPN — preferred" },
    "partNumber":     { "type": "string", "description": "Numeric part number" }
  }
}
```
At least one of `manufacturerPn` or `partNumber` is required.

**Aligni GraphQL:**
```graphql
parts(filters: [{field: "manufacturerPn", value: {eq: "$mpn"}}]) {
  nodes {
    partNumber manufacturerPn
    partType { name }
    manufacturerFamily { name }
    unit { name }
    activeRevision {
      revisionName status comment description
      customParameters { nodes { name value } }
      subparts { nodes {
        quantity designator comment
        childPart {
          partNumber manufacturerPn
          partType { name }
          activeRevision { revisionName }
        }
      }}
    }
  }
}
```
Filter field for partNumber lookup: `{field: "partNumber", value: {eq: "..."}}`.
Note: `manufacturerPn` filter is confirmed working. `partNumber` filter uses the same
pattern and should work but was not separately verified in production — flag in DEVSUM.

**Output shape:**
```json
{
  "partNumber": "100463",
  "manufacturerPn": "SA-CUT-DISC5-FT-529CHAM3",
  "partType": "Sheet-Cut Profile",
  "collection": "FilzFelt",
  "unit": "each",
  "activeRevision": {
    "name": "2",
    "status": "released",
    "comment": "...",
    "description": "...",
    "customParameters": [
      { "name": "Thickness (mm)", "value": "3" },
      { "name": "Colour/Sheen", "value": "Charcoal" }
    ]
  },
  "bom": [
    {
      "quantity": 1,
      "designator": null,
      "comment": null,
      "partNumber": "100464",
      "manufacturerPn": "100464",
      "partType": "Operations General",
      "revisionName": "1"
    }
  ]
}
```

**Error:**
```json
{ "error": { "code": "NOT_FOUND", "message": "No part found: SA-UNKNOWN" } }
```

---

### 3. `get_inventory`

**Description:** Live inventory quantities for a part. Never cached.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "manufacturerPn": { "type": "string" }
  },
  "required": ["manufacturerPn"]
}
```

**Aligni GraphQL:** Fetches `Part.inventoryUnits` in one query (avoids separate round-trip).

**Known schema limitation:** `InventoryUnit` exposes `quantity` (on-hand) and
`quantityAvailable` (available) but does NOT separately expose reserved vs. allocated
quantities. `unavailable = onHand - available` but the split between reserved and
allocated is not visible at this API level.

**Output shape:**
```json
{
  "partNumber": "100463",
  "manufacturerPn": "SA-CUT-DISC5-FT-529CHAM3",
  "unit": "each",
  "summary": {
    "onHand": 120,
    "available": 95,
    "unavailable": 25
  },
  "locations": [
    {
      "warehouse": "Main",
      "zone": "Receiving",
      "bin": "B-12",
      "quantity": 120,
      "quantityAvailable": 95
    }
  ]
}
```

---

### 4. `search_vendors`

**Description:** Search vendors by name substring. Client-side filter on cached list.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" }
  },
  "required": ["query"]
}
```

**Aligni GraphQL:**
```graphql
vendors(first: 200, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes { id legacyId name website }
}
```
Paginated until exhausted. Cached 5 min.

**Output shape (per item):**
```json
{
  "id": "01HN...",
  "legacyId": "42",
  "name": "Acme Fabrics",
  "website": "https://acmefabrics.com"
}
```

---

### 5. `get_vendor`

**Description:** Full vendor detail including contacts. Accepts ULID or legacy numeric ID.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "description": "Aligni ULID or legacy numeric ID" }
  },
  "required": ["id"]
}
```

If `id` is purely numeric, the Worker resolves it to a ULID via the cached vendor list
before making the `vendor(id)` query.

**Aligni GraphQL:**
```graphql
vendor(id: "$ulid") {
  id legacyId name shortName website accountNumber defaultPaymentTerms
  contacts { nodes {
    id legacyId firstName lastName email jobPosition canReceivePos canReceiveRfqs
  }}
}
```

**Output shape:**
```json
{
  "id": "01HN...",
  "legacyId": "42",
  "name": "Acme Fabrics",
  "shortName": "Acme",
  "website": "https://acmefabrics.com",
  "accountNumber": "AC-001",
  "defaultPaymentTerms": "Net 30",
  "contacts": [
    {
      "id": "01HN...",
      "legacyId": "7",
      "firstName": "Jane",
      "lastName": "Smith",
      "email": "jane@acmefabrics.com",
      "jobPosition": "Sales",
      "canReceivePos": true,
      "canReceiveRfqs": true
    }
  ]
}
```

---

### 6. `search_manufacturers`

**Description:** Search manufacturers by name substring. Client-side filter on cached list.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" }
  },
  "required": ["query"]
}
```

**Aligni GraphQL:**
```graphql
manufacturers(first: 200, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes { id legacyId name website }
}
```
Cached 5 min.

**Output shape (per item):**
```json
{
  "id": "01HN...",
  "legacyId": "5",
  "name": "FilzFelt",
  "website": "https://filzfelt.com"
}
```

---

### 7. `aligni_introspect`

**Description:** Inspect Aligni's GraphQL schema. Use `describe_type` to see a specific
type's fields, inputs, or enum values. Use `find_in_schema` to search for types, mutations,
or queries by name substring. Read-only — does not fetch live data. Useful for confirming
mutation shapes and field names before writing tools that call them.

Full spec: `tools/aligni-introspect-spec.md`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "op":       { "type": "string", "enum": ["describe_type", "find_in_schema"] },
    "typeName": { "type": "string", "description": "Required for describe_type" },
    "query":    { "type": "string", "description": "Required for find_in_schema" }
  },
  "required": ["op"]
}
```

**Operations:**

`describe_type` — fetches the full schema via standard `__schema` introspection and
returns the named type's kind, description, fields, inputFields, enumValues, and
possibleTypes (whichever apply to that kind). Case-insensitive type name lookup.

`find_in_schema` — case-insensitive substring search across all type names, root query
field names, and root mutation field names. GraphQL built-in types (`__Type` etc.) are
excluded. Returns an empty `matches` array (not an error) when nothing matches.

**Output shapes:**
```json
// describe_type
{
  "name": "Part",
  "kind": "OBJECT",
  "description": "the most connected entity in Aligni",
  "fields": [ { "name": "id", "description": null, "args": [], "type": { ... } } ],
  "inputFields": null,
  "enumValues": null,
  "possibleTypes": null
}

// find_in_schema
{
  "query": "vendor",
  "matches": [
    { "match": "Vendor",       "kind": "type",     "summary": "object type" },
    { "match": "vendorCreate", "kind": "mutation",  "summary": "" },
    { "match": "vendor",       "kind": "query",     "summary": "" }
  ]
}
```

**Caching:** Schema fetched once per request via `aligniGql`, cached in a local variable
for that invocation. Not persisted across requests.

**Rate limit:** Counts as one Aligni API call; subject to the same 6100ms throttle as
all other tools.

---

## Error Handling

All tool errors are returned as valid MCP tool results with `isError: true`:

```json
{
  "content": [{ "type": "text", "text": "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"...\"}}" }],
  "isError": true
}
```

Error codes: `NOT_FOUND`, `MISSING_INPUT`, `ALIGNI_ERROR`, `ERROR`.

---

## Caching Policy

| Data | Cached | TTL | Rationale |
|------|--------|-----|-----------|
| Vendor list | Yes | 5 min | Slow-changing; needed for search and legacyId resolution |
| Manufacturer list | Yes | 5 min | Slow-changing; needed for search |
| Parts (search fields only) | Yes | 5 min | No `contains` filter in Aligni; client-side search requires full list. Deviation from brief's explicit cache list — documented here as a build decision. |
| Individual part details | No | — | Real-time; `get_part` always fetches fresh |
| Inventory | No | — | Real-time; `get_inventory` always fetches fresh |
| Vendor details | No | — | Real-time; `get_vendor` always fetches fresh |

---

## Rate Limit Behaviour

Aligni is currently rate-limited at 10 req/min (account entitlement is 30/min —
support ticket open). The Worker enforces a 6100ms minimum delay between Aligni calls.

**Collision scenario:** The `stackabl-aligni-proxy` Worker (used by the felt-inventory
dashboard) and this Worker share the same Aligni token and compete for the same rate
budget. A felt-dashboard refresh while an MCP search is paginating will cause one to
hit Aligni's rate limit and receive an error. No coordination exists between the two
Workers' rate limiters.

Mitigation when 30/min ticket resolves: drop `RATE_DELAY_MS` to `2100` in
`workers/stackabl-mcp/index.js` AND `IMPORT_DELAY` in `tools/bom-importer.html`.

Long-term fix if collisions become real: centralized Durable Object rate limiter
(see `IDEAS_BACKLOG.md`).

---

## Deployment Checklist

1. `wrangler kv:namespace create MCP_AUTH` — create KV namespace
2. Fill `id` and `preview_id` in `wrangler.toml`
3. `wrangler secret put ALIGNI_TOKEN` — same value as `stackabl-aligni-proxy`
4. `wrangler deploy`
5. Add to Claude.ai: Settings → Integrations → Add custom integration → `https://stackabl-mcp.operations-dae.workers.dev/mcp`
6. Complete OAuth consent flow
7. Test all 6 tools with live data
