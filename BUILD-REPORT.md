# BUILD REPORT — docketpeek

Clean-room rebuild of `com.dropwatchhq/distress-diligence`
v1.0.0 (remote-only MCP server at
`https://diligence.dropwatchhq.com/mcp`), built
2026-10-28 as a forwarding client. Package:
`@reneturcios/docketpeek` 0.1.0, registry name
`io.github.CloudCorpRecords/docketpeek`.

## Surface built

Labelled subset: **2 of 5 captured tools built**, 3
omitted (see below).

| Tool | Required fields as served |
|------|---------------------------|
| `check_recall_exposure` | `name` |
| `ch11_preview` | NO `required` key in the capture — served verbatim, none invented |

Each served tool carries exactly the keys `name`,
`description`, `inputSchema`, exactly as captured: the
capture carries NO `title` keys, so none are served.
The tool literals were generated programmatically from
`harness/fixtures/distressdiligence-tools-original.json`
by the script at
`/tmp/b46-docketpeek-scratch/gen_forward.py` (parse +
re-serialise into `src/forward.ts` via a placeholder,
never retyped) — and a post-generation check (a
standalone deep-equality script, the
registration-integrity test suite, plus the parity
harness) confirmed the served literals deep-equal the
fixture's 2 tool objects, in order. Tools are
registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema`
handlers), not McpServer+zod.

The kept surface is two free public-record reads.
`check_recall_exposure` returns the public CPSC
recall register's own matched records (hazard +
units) for a business name, verbatim as data — the
filingscope dataset shape: no score, no verdict, and
no exclusion-list screening of the subject. It is
distinguished on the record from exclusion/sanctions
screening tools (which return a match verdict against
sanctions/exclusion lists for onboarding decisions):
this returns the register's published recall entries.
`ch11_preview` is a free read of recent Chapter 11
case headers from public dockets.

## Omissions — `diligence_brief`, `quick_scan`, `ch11_feed`

- OMITTED: `diligence_brief` — its own captured
  description prices the full brief at "$0.50 USDC on
  Base mainnet" via x402 pay-per-call, AND the brief
  embeds federal exclusion/sanctions screening (OFAC
  SDN + OIG LEIE) of a caller-named business among its
  combined signals. Priced and named-screening both;
  not built.
- OMITTED (SAFETY): `quick_scan` — returns
  distress/liability counts plus a one-line
  "go/caution/stop" VERDICT for a caller-named target
  business. A risk verdict on a named entity is the
  named-entity risk-scoring family; it is also the
  paid brief's free teaser, drawing on the same signal
  set (which includes the exclusion/sanctions leg per
  the brief's own description).
- OMITTED: `ch11_feed` — its own captured description
  prices the full feed at "$0.50 USDC on Base mainnet"
  via x402 pay-per-call ("free header preview
  included" — that free preview is the separate
  `ch11_preview` tool, which is kept).
- None of the three is registered, appears in
  tools/list, or is a CLI command.
- Absence assertions in `test/forward.test.ts`:
  - Registry level: `TOOL_NAMES` includes none of the
    three, no `TOOL_DEFS` entry carries any of their
    names, `TOOL_DEFS.length === 2`, and
    `isKnownTool(...) === false` for each.
  - MCP layer: `handleCallTool` rejects each of the
    three with McpError MethodNotFound before any
    network hop (upstream call count 0).
  - CLI level: `docketpeek diligence_brief '{}'`,
    `docketpeek quick_scan '{}'` and
    `docketpeek ch11_feed '{}'` each print Usage on
    stderr and exit 2, and the usage tool list names
    none of them.

## Fixture conflicts

**None.** The spec and the fixture agree on both built
tools' names, descriptions, required fields
(`name` for `check_recall_exposure`; no `required`
key for `ch11_preview`) and property shapes. The
spec's note that the capture carries no `title` keys
matches the fixture exactly, and the fixture's
`_source` note records the same labelled subset and
omission reasons as the spec.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned:
  `https://diligence.dropwatchhq.com/mcp`.
- Env override `DISTRESSDILIGENCE_MCP_URL` — labelled
  reconstruction.
- The registry record declares NO headers on the
  remote: no auth header is ever sent. Tests assert
  that no `Authorization` header is sent under any
  environment — including with key-like env vars
  (`DISTRESSDILIGENCE_API_KEY`, `API_KEY`,
  `AUTHORIZATION`) set — and that no `X-API-Key`
  header is ever sent; upstream requests carry only
  `Content-Type`, `Accept` and, when issued,
  `Mcp-Session-Id`.
- Error rendering `docketpeek error:` text for
  upstream failures — labelled reconstruction.
- Upstream results pass through verbatim, including
  `isError` and extra fields. tools/call is forwarded
  as streamable-HTTP JSON-RPC: initialize
  (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued; plain-JSON and SSE
  replies are both parsed. The forwarding core takes
  an injectable fetch; tests stub the upstream — no
  live network calls in tests.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir
  with no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3).
- Parses as JSON; `name` == `@reneturcios/docketpeek`.
- Package entries: **128**.
- sha256: `ad5053db64fac6687e50bf3ebf8aa6d7088342dce8faf344bb79c347bc3ca1b7`
  (re-verified unchanged after the subsequent offline
  `npm ci`).

## server.json

- Description exactly: "CPSC recall-register matches
  for a business name, plus recent Chapter 11 filing
  headers." — **88 characters**.
- npm package entry carries `"version": "0.1.0"`; the
  OCI entry (`ghcr.io/cloudcorprecords/docketpeek:0.1.0`)
  carries **no** `version` field. Both entries carry
  packageArguments `[{type: positional, value: mcp}]`
  and transport stdio. Dockerfile (node:20-alpine,
  both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/docketpeek"`.
  Container workflow `IMAGE` is
  `ghcr.io/cloudcorprecords/docketpeek` and its smoke
  test asserts the server name `docketpeek`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced
   (cli, forward, index, mcp, types — .js, .d.ts,
   .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **62 tests, 62 pass, 0 fail**
   (registration-integrity suite deep-equals the
   served tools/list against the fixture's 2 tools,
   including the no-title assertion and the
   no-`required`-key assertion for `ch11_preview`,
   plus the `diligence_brief` / `quick_scan` /
   `ch11_feed` absence assertions at registry, MCP
   and CLI level, session handling/reuse, env
   override, the no-Authorization-header assertions
   under any environment, verbatim argument forwarding
   and result pass-through including upstream isError,
   SSE parsing, error rendering as `docketpeek error:`,
   MCP-layer validation, and CLI behaviour for each
   subcommand).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/distressdiligence-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/docketpeek/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/docketpeek/parity-out` → **verdict PASS, parity 100.0**
   (2/2 identical, 0 missing, 0 extra, no schema
   diffs). Output in `parity-out/`.
