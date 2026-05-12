// STACKABL MCP Worker — Phase 1 (read-only)
// Exposes 6 Aligni read tools via Model Context Protocol (Streamable HTTP transport).
// Auth: minimal single-user OAuth 2.0 with PKCE + IP allowlist belt-and-suspenders.
// Token storage: Cloudflare KV (MCP_AUTH binding) — rotatable without redeploy.

// ── Constants ──────────────────────────────────────────────────────────────────
const ALIGNI_GQL = 'https://stacklab.aligni.com/api/v3/graphql';
const RATE_DELAY_MS = 6100;          // 10 req/min limit; drop to 2100 when Aligni upgrades
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute in-memory cache for slow-changing lists
const ANTHROPIC_CIDR = '160.79.104.0/21';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const SERVER_VERSION = '1.0.0';
// Hardcoded client_id: DCR registrations always return this value.
// Single-user — we don't actually issue distinct clients.
const CLIENT_ID = 'stackabl-ops-agent-1';

// Standard GraphQL introspection query — fetches everything needed for describe_type
// and find_in_schema in a single round trip. Does not use fragments (inlined for clarity).
const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name kind description
      fields(includeDeprecated: false) {
        name description
        args { name description type { kind name ofType { kind name ofType { kind name } } } }
        type { kind name ofType { kind name ofType { kind name } } }
      }
      inputFields {
        name description
        type { kind name ofType { kind name ofType { kind name } } }
      }
      enumValues(includeDeprecated: false) { name description }
      possibleTypes { name kind }
    }
  }
}`;

// ── Module-level state (persists within a warm isolate) ────────────────────────
let _lastAligniCallAt = 0;
let _vendorsCache = null,      _vendorsCacheAt = 0;
let _mfrsCache = null,         _mfrsCacheAt = 0;
let _partsSearchCache = null,  _partsSearchCacheAt = 0;
let _rateLimitNote = null; // set when a rate-limit retry occurred; included in next tool result

// ── Generic helpers ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Escape values inlined into GraphQL query strings.
// OperatorScalar rejects GraphQL variables — values must be inlined.
function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function htmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function mcpOk(id, result) {
  return jsonResp({ jsonrpc: '2.0', id, result });
}

function mcpErr(id, code, message) {
  return jsonResp({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolContent(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

// ── IP allowlist (160.79.104.0/21 = Anthropic outbound) ───────────────────────
function ipToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return 0;
  return ((parseInt(p[0], 10) << 24) | (parseInt(p[1], 10) << 16) |
          (parseInt(p[2], 10) << 8)  | parseInt(p[3], 10)) >>> 0;
}

function isInCidr(ip, cidr) {
  const [range, bits] = cidr.split('/');
  const prefixLen = parseInt(bits, 10);
  const mask = (prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

// ── Aligni GraphQL call with rate-limit throttle and retry ────────────────────
async function aligniGql(token, query) {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Throttle: enforce minimum gap between calls
    const elapsed = Date.now() - _lastAligniCallAt;
    if (_lastAligniCallAt && elapsed < RATE_DELAY_MS) await sleep(RATE_DELAY_MS - elapsed);
    _lastAligniCallAt = Date.now();

    const resp = await fetch(ALIGNI_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    const data = await resp.json();

    // Detect rate limit: HTTP 429 or GraphQL error mentioning rate limit
    const isRateLimit = resp.status === 429 ||
      (data.errors && data.errors.some(e => e.message.toLowerCase().includes('rate')));

    if (isRateLimit) {
      if (attempt < MAX_RETRIES) {
        // Wait a full rate-limit window then retry
        _rateLimitNote = `Aligni rate limit hit — waited ${RATE_DELAY_MS / 1000}s and retried (attempt ${attempt + 2} of ${MAX_RETRIES + 1}).`;
        await sleep(RATE_DELAY_MS);
        _lastAligniCallAt = Date.now();
        continue;
      }
      throw { code: 'RATE_LIMITED', message: `Aligni rate limit reached after ${MAX_RETRIES + 1} attempts. Wait ~30 seconds and try again.` };
    }

    if (data.errors) throw { code: 'ALIGNI_ERROR', message: data.errors[0].message };
    return data.data;
  }
}

// ── Paginated fetch helper ─────────────────────────────────────────────────────
async function fetchAllPages(token, queryFn, connKey) {
  const items = [];
  let cursor = null;
  do {
    const data = await aligniGql(token, queryFn(cursor));
    const conn = connKey.split('.').reduce((d, k) => d[k], data);
    items.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

// ── Cached list fetchers ───────────────────────────────────────────────────────
async function getVendors(token) {
  if (_vendorsCache && Date.now() - _vendorsCacheAt < CACHE_TTL_MS) return _vendorsCache;
  _vendorsCache = await fetchAllPages(
    token,
    c => `{ vendors(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor }
      nodes { id legacyId name website }
    }}`,
    'vendors',
  );
  _vendorsCacheAt = Date.now();
  return _vendorsCache;
}

async function getManufacturers(token) {
  if (_mfrsCache && Date.now() - _mfrsCacheAt < CACHE_TTL_MS) return _mfrsCache;
  _mfrsCache = await fetchAllPages(
    token,
    c => `{ manufacturers(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor }
      nodes { id legacyId name website }
    }}`,
    'manufacturers',
  );
  _mfrsCacheAt = Date.now();
  return _mfrsCache;
}

// Parts search cache: includes all fields needed for search_parts output.
// Caching the full list is necessary here — Aligni has no substring filter,
// so search requires client-side filtering across all parts. A 5-min cache
// keeps search responsive while respecting the 10 req/min rate limit.
async function getPartsForSearch(token) {
  if (_partsSearchCache && Date.now() - _partsSearchCacheAt < CACHE_TTL_MS) return _partsSearchCache;
  _partsSearchCache = await fetchAllPages(
    token,
    c => `{ parts(first: 200${c ? `, after: "${esc(c)}"` : ''}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id partNumber manufacturerPn
        partType { name }
        manufacturerFamily { name }
        activeRevision {
          revisionName comment description
          customParameters { nodes { name value } }
        }
      }
    }}`,
    'parts',
  );
  _partsSearchCacheAt = Date.now();
  return _partsSearchCache;
}

// ── MCP tool implementations ───────────────────────────────────────────────────
async function toolSearchParts(args, token) {
  const { query = '', partTypeName, collection } = args;
  const q = query.toLowerCase();
  const allParts = await getPartsForSearch(token);

  let results = allParts.filter(p => {
    if (!q) return true;
    const rev = p.activeRevision || {};
    const customParamText = (rev.customParameters?.nodes ?? [])
      .map(cp => cp.value ?? '').join(' ').toLowerCase();
    return (p.manufacturerPn || '').toLowerCase().includes(q)
      || (rev.comment || '').toLowerCase().includes(q)
      || (rev.description || '').toLowerCase().includes(q)
      || customParamText.includes(q);
  });

  if (partTypeName) {
    results = results.filter(p =>
      (p.partType?.name || '').toLowerCase() === partTypeName.toLowerCase());
  }
  if (collection) {
    results = results.filter(p =>
      (p.manufacturerFamily?.name || '').toLowerCase() === collection.toLowerCase());
  }

  return results.map(p => ({
    partNumber:        p.partNumber,
    manufacturerPn:    p.manufacturerPn,
    partType:          p.partType?.name ?? null,
    collection:        p.manufacturerFamily?.name ?? null,
    activeRevisionName: p.activeRevision?.revisionName ?? null,
    comment:           p.activeRevision?.comment ?? null,
  }));
}

async function toolGetPart(args, token) {
  const { manufacturerPn, partNumber } = args;
  if (!manufacturerPn && !partNumber) {
    throw { code: 'MISSING_INPUT', message: 'Provide manufacturerPn or partNumber' };
  }

  const filterClause = manufacturerPn
    ? `filters: [{field: "manufacturerPn", value: {eq: "${esc(manufacturerPn)}"}}]`
    : `filters: [{field: "partNumber", value: {eq: "${esc(partNumber)}"}}]`;

  const query = `{
    parts(${filterClause}) {
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
  }`;

  const data = await aligniGql(token, query);
  const part = data.parts.nodes[0];
  if (!part) {
    throw { code: 'NOT_FOUND', message: `No part found: ${manufacturerPn || partNumber}` };
  }

  const rev = part.activeRevision || {};
  return {
    partNumber:      part.partNumber,
    manufacturerPn:  part.manufacturerPn,
    partType:        part.partType?.name ?? null,
    collection:      part.manufacturerFamily?.name ?? null,
    unit:            part.unit?.name ?? null,
    activeRevision: {
      name:            rev.revisionName,
      status:          rev.status,
      comment:         rev.comment ?? null,
      description:     rev.description ?? null,
      customParameters: (rev.customParameters?.nodes ?? []).map(cp => ({
        name: cp.name, value: cp.value,
      })),
    },
    bom: (rev.subparts?.nodes ?? []).map(sp => ({
      quantity:      sp.quantity,
      designator:    sp.designator ?? null,
      comment:       sp.comment ?? null,
      partNumber:    sp.childPart?.partNumber ?? null,
      manufacturerPn: sp.childPart?.manufacturerPn ?? null,
      partType:      sp.childPart?.partType?.name ?? null,
      revisionName:  sp.childPart?.activeRevision?.revisionName ?? null,
    })),
  };
}

async function toolGetInventory(args, token) {
  const { manufacturerPn } = args;
  const query = `{
    parts(filters: [{field: "manufacturerPn", value: {eq: "${esc(manufacturerPn)}"}}]) {
      nodes {
        partNumber manufacturerPn
        unit { name }
        inventoryUnits { nodes {
          quantity quantityAvailable
          warehouse { name }
          zone { name }
          zoneBin
        }}
      }
    }
  }`;

  const data = await aligniGql(token, query);
  const part = data.parts.nodes[0];
  if (!part) {
    throw { code: 'NOT_FOUND', message: `No part found: ${manufacturerPn}` };
  }

  const units = part.inventoryUnits?.nodes ?? [];
  const onHand    = units.reduce((s, u) => s + (u.quantity ?? 0), 0);
  const available = units.reduce((s, u) => s + (u.quantityAvailable ?? 0), 0);

  return {
    partNumber:     part.partNumber,
    manufacturerPn: part.manufacturerPn,
    unit:           part.unit?.name ?? null,
    summary: {
      onHand,
      available,
      // unavailable = onHand - available; Aligni does not expose reserved/allocated
      // as separate fields at the InventoryUnit level — see mcp-server-spec.md
      unavailable: Math.round((onHand - available) * 1e6) / 1e6,
    },
    locations: units.map(u => ({
      warehouse:         u.warehouse?.name ?? null,
      zone:              u.zone?.name ?? null,
      bin:               u.zoneBin ?? null,
      quantity:          u.quantity,
      quantityAvailable: u.quantityAvailable,
    })),
  };
}

async function toolSearchVendors(args, token) {
  const { query = '' } = args;
  const q = query.toLowerCase();
  const vendors = await getVendors(token);
  return vendors
    .filter(v => (v.name || '').toLowerCase().includes(q))
    .map(v => ({
      id: v.id, legacyId: v.legacyId, name: v.name, website: v.website ?? null,
    }));
}

async function toolGetVendor(args, token) {
  const { id } = args;
  let ulid = id;

  // If id is purely numeric, treat as legacyId — resolve to ULID via cached list
  if (/^\d+$/.test(id)) {
    const vendors = await getVendors(token);
    const found = vendors.find(v => String(v.legacyId) === String(id));
    if (!found) throw { code: 'NOT_FOUND', message: `No vendor with legacy ID: ${id}` };
    ulid = found.id;
  }

  const query = `{
    vendor(id: "${esc(ulid)}") {
      id legacyId name shortName website accountNumber defaultPaymentTerms
      contacts { nodes {
        id legacyId firstName lastName email jobPosition canReceivePos canReceiveRfqs
      }}
    }
  }`;

  const data = await aligniGql(token, query);
  if (!data.vendor) throw { code: 'NOT_FOUND', message: `No vendor found: ${id}` };

  const v = data.vendor;
  return {
    id:                  v.id,
    legacyId:            v.legacyId,
    name:                v.name,
    shortName:           v.shortName ?? null,
    website:             v.website ?? null,
    accountNumber:       v.accountNumber ?? null,
    defaultPaymentTerms: v.defaultPaymentTerms ?? null,
    contacts: (v.contacts?.nodes ?? []).map(c => ({
      id:            c.id,
      legacyId:      c.legacyId,
      firstName:     c.firstName ?? null,
      lastName:      c.lastName,
      email:         c.email ?? null,
      jobPosition:   c.jobPosition ?? null,
      canReceivePos:  c.canReceivePos,
      canReceiveRfqs: c.canReceiveRfqs,
    })),
  };
}

async function toolSearchManufacturers(args, token) {
  const { query = '' } = args;
  const q = query.toLowerCase();
  const mfrs = await getManufacturers(token);
  return mfrs
    .filter(m => (m.name || '').toLowerCase().includes(q))
    .map(m => ({
      id: m.id, legacyId: m.legacyId, name: m.name, website: m.website ?? null,
    }));
}

async function toolAligniIntrospect(args, token) {
  const { op, typeName, query } = args;
  if (!op) {
    throw { code: 'MISSING_INPUT', message: 'op is required: "describe_type" or "find_in_schema"' };
  }

  // Per-request schema cache: fetch once, reuse within this call.
  // Not persisted across requests — schema is re-fetched each invocation.
  let _schema = null;
  const getSchema = async () => {
    if (_schema) return _schema;
    const data = await aligniGql(token, INTROSPECTION_QUERY);
    _schema = data.__schema;
    return _schema;
  };

  if (op === 'describe_type') {
    if (!typeName) throw { code: 'MISSING_INPUT', message: 'typeName is required for describe_type' };
    const schema = await getSchema();
    const type = schema.types.find(t => t.name.toLowerCase() === typeName.toLowerCase());
    if (!type) {
      throw { code: 'NOT_FOUND', message: `Type not found in schema: ${typeName}` };
    }
    return {
      name:         type.name,
      kind:         type.kind,
      description:  type.description ?? null,
      fields:       type.fields?.length      ? type.fields       : null,
      inputFields:  type.inputFields?.length  ? type.inputFields  : null,
      enumValues:   type.enumValues?.length   ? type.enumValues   : null,
      possibleTypes: type.possibleTypes?.length ? type.possibleTypes : null,
    };
  }

  if (op === 'find_in_schema') {
    if (query === undefined || query === null) {
      throw { code: 'MISSING_INPUT', message: 'query is required for find_in_schema' };
    }
    const q = query.toLowerCase();
    const schema = await getSchema();
    const matches = [];

    // Type names — skip GraphQL built-ins (__Type, __Field, etc.)
    for (const t of schema.types) {
      if (t.name.startsWith('__')) continue;
      if (t.name.toLowerCase().includes(q)) {
        matches.push({ match: t.name, kind: 'type', summary: t.description || `${t.kind.toLowerCase()} type` });
      }
    }

    // Query field names
    if (schema.queryType) {
      const qt = schema.types.find(t => t.name === schema.queryType.name);
      for (const f of qt?.fields ?? []) {
        if (f.name.toLowerCase().includes(q)) {
          matches.push({ match: f.name, kind: 'query', summary: f.description || '' });
        }
      }
    }

    // Mutation field names
    if (schema.mutationType) {
      const mt = schema.types.find(t => t.name === schema.mutationType.name);
      for (const f of mt?.fields ?? []) {
        if (f.name.toLowerCase().includes(q)) {
          matches.push({ match: f.name, kind: 'mutation', summary: f.description || '' });
        }
      }
    }

    return { query, matches };
  }

  throw { code: 'INVALID_INPUT', message: `Unknown op: "${op}". Use "describe_type" or "find_in_schema"` };
}

// ── MCP tool registry ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_parts',
    description: 'Search parts by substring across manufacturer part number, revision description, and revision comment. Optional filters: partTypeName (e.g. "Felt"), collection (manufacturer family name). Returns all matching parts — no exclusions.',
    inputSchema: {
      type: 'object',
      properties: {
        query:        { type: 'string', description: 'Substring to match in manufacturerPn, revision description, or revision comment' },
        partTypeName: { type: 'string', description: 'Filter by part type name, e.g. "Felt", "Sheet-Cut Profile", "Operations General"' },
        collection:   { type: 'string', description: 'Filter by manufacturer family / collection name' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_part',
    description: 'Get full part details: active revision info, custom parameters (Thickness, Colour/Sheen, etc.), and single-level BOM. Look up by manufacturer part number (preferred) or numeric part number.',
    inputSchema: {
      type: 'object',
      properties: {
        manufacturerPn: { type: 'string', description: 'Manufacturer part number (MPN) — preferred lookup key' },
        partNumber:     { type: 'string', description: 'Numeric part number — use manufacturerPn when known' },
      },
    },
  },
  {
    name: 'get_inventory',
    description: 'Get live inventory for a part by manufacturer part number. Returns on-hand and available totals with per-location breakdown (warehouse, zone, bin). Never cached — always live.',
    inputSchema: {
      type: 'object',
      properties: {
        manufacturerPn: { type: 'string', description: 'Manufacturer part number (MPN)' },
      },
      required: ['manufacturerPn'],
    },
  },
  {
    name: 'search_vendors',
    description: 'Search vendors by name substring. Returns matching vendors with Aligni IDs for use with get_vendor.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match in vendor names' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_vendor',
    description: 'Get full vendor details including contacts. Look up by Aligni ULID (preferred) or legacy numeric ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Vendor Aligni ULID (preferred) or legacy numeric ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_manufacturers',
    description: 'Search manufacturers by name substring. Returns matching manufacturers with Aligni IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match in manufacturer names' },
      },
      required: ['query'],
    },
  },
  {
    name: 'aligni_introspect',
    description: 'Inspect Aligni\'s GraphQL schema. Use describe_type to see a specific type\'s fields, inputs, or enum values. Use find_in_schema to search for types, mutations, or queries by name substring. Read-only — does not fetch live data. Useful for confirming mutation shapes and field names before writing tools that call them.',
    inputSchema: {
      type: 'object',
      properties: {
        op:       { type: 'string', enum: ['describe_type', 'find_in_schema'], description: '"describe_type" to inspect a named type, or "find_in_schema" to search by name substring' },
        typeName: { type: 'string', description: 'Type name to look up (required for describe_type)' },
        query:    { type: 'string', description: 'Substring to search across type names, query fields, and mutation names (required for find_in_schema)' },
      },
      required: ['op'],
    },
  },
];

// ── MCP protocol handler ───────────────────────────────────────────────────────
async function handleMcp(request, env) {
  if (request.method === 'GET') {
    // Streamable HTTP: GET is for SSE server→client push. We don't implement it.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  // Belt-and-suspenders: IP allowlist for Anthropic's outbound range.
  // Primary gate is the OAuth bearer token below.
  // CF-Connecting-IP is always present in Cloudflare production; absent in local dev.
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  if (clientIp && !isInCidr(clientIp, ANTHROPIC_CIDR)) {
    return jsonResp({ error: { code: 'FORBIDDEN', message: 'IP not in allowlist' } }, 403);
  }

  // Bearer token validation
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  const bearerToken = authHeader.slice(7).trim();
  const tokenData = await env.MCP_AUTH.get('token:' + bearerToken);
  if (!tokenData) {
    return new Response(null, {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    });
  }

  let body;
  try { body = await request.json(); }
  catch { return mcpErr(null, -32700, 'Parse error'); }

  const { jsonrpc, method, id, params } = body;
  if (jsonrpc !== '2.0') return mcpErr(id ?? null, -32600, 'Invalid Request');

  switch (method) {
    case 'initialize':
      return mcpOk(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'stackabl-mcp', version: SERVER_VERSION },
        instructions: 'Stacklab Operations read-only Aligni connector. Phase 1: search parts, get part details and BOM, get live inventory, search vendors, get vendor with contacts, search manufacturers. No write operations.',
      });

    case 'notifications/initialized':
      return new Response(null, { status: 202 });

    case 'tools/list':
      return mcpOk(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args = {} } = params || {};
      if (!TOOLS.find(t => t.name === name)) {
        return mcpErr(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const tok = env.ALIGNI_TOKEN;
        _rateLimitNote = null;
        let result;
        switch (name) {
          case 'search_parts':         result = await toolSearchParts(args, tok);        break;
          case 'get_part':             result = await toolGetPart(args, tok);            break;
          case 'get_inventory':        result = await toolGetInventory(args, tok);       break;
          case 'search_vendors':       result = await toolSearchVendors(args, tok);      break;
          case 'get_vendor':           result = await toolGetVendor(args, tok);          break;
          case 'search_manufacturers': result = await toolSearchManufacturers(args, tok); break;
          case 'aligni_introspect':    result = await toolAligniIntrospect(args, tok);   break;
        }
        // If a rate-limit retry happened during this call, surface it so Claude mentions it
        if (_rateLimitNote) result = { _notice: _rateLimitNote, ...result };
        _rateLimitNote = null;
        return mcpOk(id, toolContent(result));
      } catch (err) {
        return mcpOk(id, toolContent(
          { error: { code: err.code || 'ERROR', message: err.message || String(err) } },
          true,
        ));
      }
    }

    case 'ping':
      return mcpOk(id, {});

    default:
      return mcpErr(id ?? null, -32601, `Method not found: ${method}`);
  }
}

// ── OAuth helpers ──────────────────────────────────────────────────────────────
function getBase(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function handleOAuthServerMeta(request) {
  const base = getBase(request);
  return jsonResp({
    issuer:                    base,
    authorization_endpoint:    `${base}/authorize`,
    token_endpoint:            `${base}/token`,
    registration_endpoint:     `${base}/register`,
    response_types_supported:  ['code'],
    grant_types_supported:     ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

function handleOAuthResourceMeta(request) {
  const base = getBase(request);
  return jsonResp({ resource: base, authorization_servers: [base] });
}

async function handleAuthorize(request, env, url) {
  const clientId             = url.searchParams.get('client_id') || '';
  const redirectUri          = url.searchParams.get('redirect_uri') || '';
  const state                = url.searchParams.get('state') || '';
  const codeChallenge        = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod  = url.searchParams.get('code_challenge_method') || 'S256';
  const responseType         = url.searchParams.get('response_type') || '';

  if (clientId !== CLIENT_ID) {
    return new Response('Unknown client_id', { status: 400 });
  }
  if (responseType !== 'code') {
    return new Response('Unsupported response_type — only "code" is supported', { status: 400 });
  }
  if (!redirectUri) {
    return new Response('Missing redirect_uri', { status: 400 });
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    if (form.get('action') !== 'authorize') {
      return new Response('Authorization denied', { status: 400 });
    }

    const code = crypto.randomUUID();
    await env.MCP_AUTH.put('code:' + code, JSON.stringify({
      clientId, redirectUri, codeChallenge, codeChallengeMethod,
    }), { expirationTtl: 600 }); // 10-minute auth code window

    const dest = new URL(redirectUri);
    dest.searchParams.set('code', code);
    if (state) dest.searchParams.set('state', state);
    return Response.redirect(dest.toString(), 302);
  }

  // GET — render consent page
  return new Response(buildConsentPage(clientId, redirectUri, state, codeChallenge, codeChallengeMethod), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function buildConsentPage(clientId, redirectUri, state, codeChallenge, codeChallengeMethod) {
  // URL-encode all params so they survive the form action round-trip
  const formAction = `/authorize?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`
    + `&code_challenge=${encodeURIComponent(codeChallenge)}`
    + `&code_challenge_method=${encodeURIComponent(codeChallengeMethod)}`
    + `&response_type=code`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authorize — Stacklab Operations</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  background: #000;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 40px 20px;
}
.card {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 4px;
  padding: 36px;
  max-width: 480px;
  width: 100%;
}
.brand {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #E6E6E6;
  margin-bottom: 28px;
}
.title {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #E6E6E6;
  margin-bottom: 12px;
}
.desc {
  font-size: 0.75rem;
  line-height: 1.65;
  color: #BFBFBF;
  margin-bottom: 24px;
}
.scope-list {
  background: #000;
  border: 1px solid #1a1a1a;
  border-radius: 2px;
  padding: 16px;
  margin-bottom: 28px;
}
.scope-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 0.75rem;
  color: #BFBFBF;
  margin-bottom: 8px;
}
.scope-item:last-child { margin-bottom: 0; }
.dot {
  width: 4px; height: 4px; border-radius: 50%;
  background: #444; flex-shrink: 0; margin-top: 5px;
}
hr {
  border: none;
  border-top: 1px solid #1e1e1e;
  margin: 0 0 28px;
}
button[type="submit"] {
  width: 100%;
  background: #BFBFBF;
  color: #000;
  border: none;
  border-radius: 2px;
  padding: 14px;
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
button[type="submit"]:hover { background: #E6E6E6; }
.note {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  color: #444;
  text-align: center;
  margin-top: 16px;
}
</style>
</head>
<body>
<div class="card">
  <div class="brand">Stacklab Operations</div>
  <div class="title">Authorize MCP Access</div>
  <div class="desc">
    Claude is requesting read-only access to your Aligni PLM data
    via the Stacklab Operations MCP server.
  </div>
  <div class="scope-list">
    <div class="scope-item"><div class="dot"></div><span>Search and look up parts, including active revision details and BOMs</span></div>
    <div class="scope-item"><div class="dot"></div><span>Read live inventory quantities by location</span></div>
    <div class="scope-item"><div class="dot"></div><span>Search vendors and retrieve vendor contacts</span></div>
    <div class="scope-item"><div class="dot"></div><span>Search manufacturers</span></div>
  </div>
  <hr>
  <form method="POST" action="${htmlEsc(formAction)}">
    <input type="hidden" name="action" value="authorize">
    <button type="submit">Authorize Stacklab Operations</button>
  </form>
  <div class="note">Read-only &nbsp;·&nbsp; No writes will be made to Aligni</div>
</div>
</body>
</html>`;
}

async function handleRegister(request) {
  // Dynamic Client Registration (RFC 7591).
  // Single-user: always return the same hardcoded client_id regardless of input.
  // Claude's connector infrastructure uses DCR; we satisfy it without issuing distinct clients.
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  return jsonResp({
    client_id:                 CLIENT_ID,
    client_secret_expires_at:  0,
    redirect_uris:             ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    grant_types:               ['authorization_code'],
    response_types:            ['code'],
    code_challenge_methods:    ['S256'],
  }, 201);
}

async function handleToken(request, env) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  let params;
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    params = await request.json();
  } else {
    // application/x-www-form-urlencoded (RFC 6749 default)
    params = Object.fromEntries(new URLSearchParams(await request.text()));
  }

  const { grant_type, code, redirect_uri, code_verifier } = params;

  if (grant_type !== 'authorization_code') {
    return jsonResp({ error: 'unsupported_grant_type' }, 400);
  }
  if (!code) {
    return jsonResp({ error: 'invalid_request', error_description: 'missing code' }, 400);
  }

  const raw = await env.MCP_AUTH.get('code:' + code);
  if (!raw) {
    return jsonResp({ error: 'invalid_grant', error_description: 'code not found or expired' }, 400);
  }

  const { clientId, redirectUri, codeChallenge, codeChallengeMethod } = JSON.parse(raw);

  if (redirect_uri && redirect_uri !== redirectUri) {
    return jsonResp({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
  }

  // PKCE verification (S256)
  if (codeChallenge) {
    if (!code_verifier) {
      return jsonResp({ error: 'invalid_grant', error_description: 'code_verifier required' }, 400);
    }
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(code_verifier));
    const b64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (b64url !== codeChallenge) {
      return jsonResp({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
  }

  // Consume auth code (single-use)
  await env.MCP_AUTH.delete('code:' + code);

  // Issue access token — stored in KV, effectively permanent (rotatable via new auth flow)
  const accessToken = crypto.randomUUID() + '-' + crypto.randomUUID();
  await env.MCP_AUTH.put('token:' + accessToken, JSON.stringify({
    clientId,
    issuedAt: Date.now(),
  }));

  return jsonResp({
    access_token: accessToken,
    token_type:   'bearer',
    expires_in:   31536000, // 1 year; refresh reactively on 401
  });
}

// ── Main router ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // CORS preflight for MCP endpoint
    if (request.method === 'OPTIONS' && path === '/mcp') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
          'Access-Control-Max-Age':       '86400',
        },
      });
    }

    if (path === '/.well-known/oauth-authorization-server') return handleOAuthServerMeta(request);
    if (path === '/.well-known/oauth-protected-resource')   return handleOAuthResourceMeta(request);
    if (path === '/authorize') return handleAuthorize(request, env, url);
    if (path === '/register')  return handleRegister(request);
    if (path === '/token')     return handleToken(request, env);
    if (path === '/mcp')       return handleMcp(request, env);

    return jsonResp({ error: 'Not Found' }, 404);
  },
};
