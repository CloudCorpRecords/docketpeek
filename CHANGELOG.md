# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted distress-diligence MCP server, built as a labelled subset of the captured surface. The 2 kept tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `check_recall_exposure` (requires `name`) and `ch11_preview` (no `required` key in the capture — served verbatim, none invented). The capture carries no `title` keys, so none are served.
- Omitted from the captured surface of 5, by design: `diligence_brief` (x402-priced full brief that also embeds federal exclusion/sanctions screening of a caller-named business), `quick_scan` (distress counts plus a go/caution/stop risk verdict on a caller-named business), and `ch11_feed` (x402-priced full feed). None of the three is served, registered or offered.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `docketpeek error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `DISTRESSDILIGENCE_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
