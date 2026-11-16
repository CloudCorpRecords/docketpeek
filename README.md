# docketpeek

Has this business sold something that got recalled, and who filed for Chapter 11 this month? docketpeek is a local forwarding client for the hosted distress-diligence MCP service: it answers `tools/list` locally from the captured tool definitions and forwards every call to the service, returning the answers exactly as the service sends them back.

This rebuild deliberately serves a subset of the captured surface — the two free public-record reads:

- **`check_recall_exposure`** — Look a business name up in the public CPSC product-recall register. The service returns the register's own matched recall records, with hazard and units, as data. There is no score, no verdict, and no screening of the business against any exclusion list; you get the published recall entries that match the name. `name` is required.
- **`ch11_preview`** — A free preview of the most recent Chapter 11 business filings: case headers only (business name, court, filing date, docket link). Pass `days` to set the lookback window (default 14). No required parameters.

Three captured tools are intentionally not part of this rebuild. `diligence_brief` sells a full brief per call via x402 crypto payment and folds federal exclusion/sanctions screening of a named business into that brief. `quick_scan` compresses distress signals about a named business into a go/caution/stop verdict — a risk judgment about someone else's company, which this rebuild does not issue. `ch11_feed` is the paid full version of the filing feed; its free preview is `ch11_preview` above. None of the three is served, registered, or available from the CLI.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/docketpeek mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "docketpeek": {
      "command": "npx",
      "args": ["-y", "@reneturcios/docketpeek", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/docketpeek
docker run --rm ghcr.io/cloudcorprecords/docketpeek ch11_preview '{}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
docketpeek check_recall_exposure '{"name":"Example Imports Inc"}'
docketpeek ch11_preview '{"days":7}'
docketpeek ch11_preview
docketpeek --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `DISTRESSDILIGENCE_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://diligence.dropwatchhq.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `docketpeek error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (the 2 kept tools, deep-equal, in order, with no titles invented and no `required` key added to `ch11_preview`), asserts the absence of `diligence_brief`, `quick_scan` and `ch11_feed` at the registry, MCP and CLI levels, exercises the session handshake and its reuse, verifies that no `Authorization` header is ever sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
