# Claude Code Instructions — Stacklab Ops Toolkit

Read DEV_ENVIRONMENT.md before doing anything in this repo.

---

## DEFAULT BEHAVIOUR

At the start of every session, before doing anything else:
1. Run `git pull` to get the latest changes from GitHub
2. Confirm to the user: "Pulled latest from GitHub. Ready to work."

Do not push to GitHub unless the user explicitly asks. When the user 
asks to push, run:
  git add .
  git commit -m "[brief description of what was built or changed]"
  git push origin main

Then confirm: "Pushed to GitHub. Changes will be live on GitHub Pages 
in a minute or two."

---

## DEVSUM

When the user says DEVSUM, generate a structured handoff report 
covering this build session. Format it exactly like this:

"DEVSUM — Build Session Report
[date]

TOOL BUILT: [name and file path]

WHAT IT DOES:
[2-3 sentence plain English description]

GRAPHQL OPERATIONS USED:
- [mutation/query name]: [what it does, key input fields]
- [repeat for each]

ALIGNI DISCOVERIES (corrections or new knowledge):
- [anything that differed from what the brief expected]
- [field names that weren't obvious]
- [quirks, errors, rate limit or sequencing gotchas]

DECISIONS MADE DURING BUILD:
- [anything not in the brief that had to be figured out]

OUTSTANDING ISSUES / WATCH POINTS:
- [anything fragile or needing future attention]

CONTEXT UPDATES NEEDED:
- DEV_ENVIRONMENT.md: [specific line or section to add/correct]
- Project Log: [one paragraph summary for the log]
- Spec file saved at: [path]"

After generating the report, audit all docs in the ops-toolkit repo 
and in this Claude project. Identify: (1) any duplication or overlap, 
(2) any drift between sources of truth, (3) any docs that should be 
consolidated, split, or retired. Produce a consolidation plan before 
changing anything.

---

## Architecture

This repo implements a three-layer architecture:

```
Aligni GraphQL API
↑
Capabilities layer (Cloudflare Workers)
  Atomic operations: single Aligni-domain actions
  (search parts, get BOM, create vendor, etc.)
  Composite workflows: multi-step orchestrations
  encoding Stacklab domain knowledge
  (set up new SKU with variants + alternates, etc.)
↑
Three peer interfaces:
  Browser tools (human-facing)
  MCP server (agent-facing)
  Triggered workflows (event-facing: webhooks, schedulers)
```

Logic lives in the capabilities layer. Interfaces are thin and 
disposable. The same capability is consumed by all three interfaces 
without duplication.

### Atomic vs. composite

**Atomic operations** are single domain actions with clear inputs and 
outputs. They map closely to Aligni concepts (parts, BOMs, vendors).

**Composite workflows** chain atomic operations into meaningful 
multi-step actions that encode Stacklab-specific patterns. Examples: 
`new-sku-setup`, `clone-sku-with-variant`, `bulk-bom-from-template`.

Composites emerge from observed usage. Don't design composites 
speculatively — build atomic operations, observe what gets repeatedly 
orchestrated, and promote those patterns into composite endpoints when 
they prove out.

---

## Stated principles

**Endpoint-first.** Multi-step Aligni workflows live in dedicated 
Cloudflare Worker smart endpoints (separate from the dumb proxy). 
Browser tools, MCP servers, scripts, and triggered workflows are all 
thin consumers of these endpoints. Every new tool follows this 
pattern. Existing tools are refactored opportunistically when next 
touched, not in big-bang sprints.

**Agent-first capability design.** Every capability endpoint is 
designed for an LLM agent as a first-class consumer, not an 
afterthought. Concretely:
- JSON schemas are clean and self-describing
- Errors are structured objects, not human-readable strings
- Operations are idempotent where possible — re-running shouldn't 
  double-create or corrupt state
- Names match domain language, not implementation details
- Required fields are explicit; no "the user will figure it out" 
  defaults

This rule shapes contract design from the start, even for endpoints 
whose first consumer is a browser form. Anything an agent can't reason 
about cleanly is a contract bug.

**Pattern emergence over speculation.** New composite workflows are 
extracted from observed atomic-tool usage, not designed up front. 
Build atomic operations first, use them, then promote patterns.
