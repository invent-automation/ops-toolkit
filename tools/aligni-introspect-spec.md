# aligni_introspect — Spec

**Tool name:** `aligni_introspect`  
**Worker:** `workers/stackabl-mcp/index.js`  
**Added:** 2026-05-12  
**Phase:** Development-time utility — read-only schema inspection, not a daily-driver data tool.

---

## What It Does

Exposes Aligni's GraphQL schema to MCP clients (Claude.ai) so that design and build
conversations can verify type shapes, field names, and mutation signatures against the
live schema without leaving chat. The tool issues a single standard introspection query
to the Aligni v3 GraphQL endpoint and returns the result in a clean, structured form.

No live data is fetched. No mutations are made. The tool is intentionally limited to
schema inspection.

---

## Operations

The tool takes an `op` parameter that selects one of two operations.

---

### `describe_type`

Returns full details for a named GraphQL type.

**Input:**
```json
{ "op": "describe_type", "typeName": "Part" }
```

**Behavior:** Fetches the full Aligni schema via standard `__schema` introspection,
then looks up the named type (case-insensitive). Returns its kind, description, and
whichever of the following apply to that kind:
- `fields` — for OBJECT and INTERFACE types; each field includes name, description,
  type reference, and args
- `inputFields` — for INPUT_OBJECT types
- `enumValues` — for ENUM types
- `possibleTypes` — for INTERFACE and UNION types

Returns `null` for inapplicable fields (e.g. `inputFields` on an OBJECT type).

**Output shape:**
```json
{
  "name": "Part",
  "kind": "OBJECT",
  "description": null,
  "fields": [
    {
      "name": "id",
      "description": null,
      "args": [],
      "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "ID", "ofType": null } }
    }
  ],
  "inputFields": null,
  "enumValues": null,
  "possibleTypes": null
}
```

**Error — type not found:**
```json
{ "error": { "code": "NOT_FOUND", "message": "Type not found in schema: UnknownType" } }
```

---

### `find_in_schema`

Case-insensitive substring search across all type names, query field names, and mutation
field names in the schema.

**Input:**
```json
{ "op": "find_in_schema", "query": "deviation" }
```

**Behavior:** Fetches the full schema once (same introspection query as `describe_type`),
then searches:
1. All named types (GraphQL built-in types starting with `__` are excluded)
2. All fields on the root Query type
3. All fields on the root Mutation type

Each match is tagged with what kind of thing it is (`type`, `query`, or `mutation`) and
a one-line summary (the description field from the schema, or a generic label if no
description is present).

An empty `query` string matches everything — useful for listing all mutations or all types.
A query that matches nothing returns an empty `matches` array without error.

**Output shape:**
```json
{
  "query": "deviation",
  "matches": [
    { "match": "Deviation",       "kind": "type",     "summary": "object type" },
    { "match": "deviationCreate", "kind": "mutation",  "summary": "Create a deviation record" },
    { "match": "deviationUpdate", "kind": "mutation",  "summary": "" }
  ]
}
```

**Empty result (no error):**
```json
{ "query": "zzz_nonexistent_thing", "matches": [] }
```

---

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "op": {
      "type": "string",
      "enum": ["describe_type", "find_in_schema"],
      "description": "\"describe_type\" to inspect a named type, or \"find_in_schema\" to search by name substring"
    },
    "typeName": {
      "type": "string",
      "description": "Type name to look up (required for describe_type)"
    },
    "query": {
      "type": "string",
      "description": "Substring to search across type names, query fields, and mutation names (required for find_in_schema)"
    }
  },
  "required": ["op"]
}
```

---

## Rate Limit Behaviour

The tool issues one Aligni API call (the `__schema` introspection query) per tool
invocation. It uses the same `aligniGql` function as all other MCP tools and is therefore
subject to the same 6100ms inter-request throttle and retry logic.

The introspection query counts against the shared Aligni rate limit (currently 10 req/min
for the Stacklab account). Because schema inspection is a development-time activity and
not a high-frequency operation, this is not expected to cause collisions in practice.

---

## Caching

The introspection query result is cached in a local variable within the tool function for
the duration of the request. This ensures the schema is fetched at most once even if the
implementation were to call `getSchema()` from multiple paths.

The cache is **not** persisted across requests. The schema is re-fetched on each tool
invocation. This is intentional — the schema is small (relative to live data) and a
module-level cache would complicate testing and could mask schema changes during active
development sessions.

---

## GraphQL Introspection Query

The tool uses a single standard `__schema` introspection query covering:
- `queryType` and `mutationType` names (for `find_in_schema` to locate the right root types)
- All types with: `name`, `kind`, `description`, `fields` (with args and type refs),
  `inputFields`, `enumValues`, `possibleTypes`

Type references are resolved to three levels of nesting (`ofType { ofType { ... } }`)
which handles the most common wrappers (`NonNull(List(NonNull(Scalar)))` patterns).

Introspection against Aligni v3 was confirmed working as of 2026-05-06 (noted in
`mcp-server-spec.md`). If Aligni disables introspection, all calls to this tool will
return an `ALIGNI_ERROR` with the API's error message.

---

## Error Codes

| Code            | When                                                |
|-----------------|-----------------------------------------------------|
| `MISSING_INPUT` | `op` not provided, or required param for op missing |
| `NOT_FOUND`     | `describe_type` called with an unknown type name    |
| `INVALID_INPUT` | `op` is not one of the two supported values         |
| `RATE_LIMITED`  | Aligni rate limit hit after retries                 |
| `ALIGNI_ERROR`  | Aligni returned a GraphQL error                     |

All errors are returned as valid MCP tool results with `isError: true`:
```json
{
  "content": [{ "type": "text", "text": "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"...\"}}" }],
  "isError": true
}
```
