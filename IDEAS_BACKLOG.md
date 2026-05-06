# Ops Toolkit — Ideas Backlog

## Active
(nothing — supplier intake deleted; MCP Phase 1 is next)

## Next up
- stackabl-mcp Phase 1: atomic read operations (search parts, get BOM, 
  get vendor, etc.) as MCP tools for Claude sessions

## Ideas
- Vendor/supplier write capabilities as MCP tools — let emerge from 
  observed Phase 1 usage patterns; do not design speculatively

## Refactors
- Endpoint-ify the BOM importer's core operation (currently UI-coupled)
- Endpoint-ify the lead time calculator
- Endpoint-ify the safety stock calculator
- Pattern rule: every new tool is built endpoint-first; existing
  tools get refactored when next touched

## Won't do (yet)
- Bulk supplier import — single-entry covers the realistic volume for 
  Stacklab; revisit only if a real bulk need surfaces
