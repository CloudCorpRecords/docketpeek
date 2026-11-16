import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DocketpeekClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real distress-diligence
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/distressdiligence-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const RECALL = "check_recall_exposure";
const PREVIEW = "ch11_preview";
const ALL_TOOLS = [RECALL, PREVIEW];
const OMITTED = ["diligence_brief", "quick_scan", "ch11_feed"];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"matches\":[{\"hazard\":\"fire\",\"units\":1200}]}" }],
  structuredContent: { matches: [{ hazard: "fire", units: 1200 }] },
};

const SAMPLE_ARGS = { name: "Example Imports Inc" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "distress-diligence", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new DocketpeekClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function hasAuthHeader(call: Captured): boolean {
  return Object.keys(call.headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 2 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 2);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 2 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (no title invented)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
      assert.equal("title" in tool, false);
    }
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.ok(
      TOOL_DEFS[0].description.startsWith(
        "FREE: check a business name against CPSC product-recall records",
      ),
    );
    assert.ok(TOOL_DEFS[0].description.endsWith("hazard + units."));
    assert.ok(
      TOOL_DEFS[1].description.startsWith(
        "FREE preview of the most-recent Chapter 11 business filings",
      ),
    );
    assert.ok(TOOL_DEFS[1].description.endsWith("restructuring lane."));
  });

  it("check_recall_exposure requires exactly name", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[0]).required, ["name"]);
  });

  it("ch11_preview carries NO required key, exactly as captured", () => {
    assert.equal("required" in schemaOf(TOOL_DEFS[1]), false);
    assert.equal(schemaOf(TOOL_DEFS[1]).required, undefined);
  });

  it("carries object type and no $schema or additionalProperties marker on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal("$schema" in schemaOf(tool), false);
      assert.equal("additionalProperties" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), ["name"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["days"]);
  });

  it("check_recall_exposure name is a string with the captured description", () => {
    const name = schemaOf(TOOL_DEFS[0]).properties.name;
    assert.equal(name.type, "string");
    assert.equal(
      name.description,
      "Manufacturer/importer/retailer name (required).",
    );
  });

  it("ch11_preview days is an integer with the captured description", () => {
    const days = schemaOf(TOOL_DEFS[1]).properties.days;
    assert.equal(days.type, "integer");
    assert.equal(days.description, "Lookback window in days (default 14).");
  });

  it("isKnownTool recognises the built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("recall"), false);
    assert.equal(isKnownTool("ch11"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omissions: diligence_brief, quick_scan and ch11_feed are absent", () => {
  it("no omitted tool is among the served tool names (registry level)", () => {
    for (const name of OMITTED) {
      assert.equal(TOOL_NAMES.includes(name), false, name);
      assert.equal(TOOL_DEFS.some((t) => t.name === name), false, name);
    }
    assert.equal(TOOL_DEFS.length, 2);
  });

  it("isKnownTool rejects every omitted tool (registry level)", () => {
    for (const name of OMITTED) {
      assert.equal(isKnownTool(name), false, name);
    }
  });

  it("the MCP layer rejects diligence_brief as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "diligence_brief", { name: "Example Imports Inc" }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP layer rejects quick_scan as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "quick_scan", { name: "Example Imports Inc" }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP layer rejects ch11_feed as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "ch11_feed", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(
      DEFAULT_ENDPOINT_URL,
      "https://diligence.dropwatchhq.com/mcp",
    );
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name docketpeek and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECALL, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "docketpeek", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECALL, SAMPLE_ARGS);
    await c.callTool(PREVIEW, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the DISTRESSDILIGENCE_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new DocketpeekClient({
      fetchFn: upstream.fetchFn,
      env: { DISTRESSDILIGENCE_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { DISTRESSDILIGENCE_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new DocketpeekClient({
      fetchFn: upstream.fetchFn,
      env: { DISTRESSDILIGENCE_MCP_URL: "   " },
    });
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !hasAuthHeader(call)));
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new DocketpeekClient({
      fetchFn: upstream.fetchFn,
      env: {
        DISTRESSDILIGENCE_API_KEY: "should-never-be-sent",
        API_KEY: "also-ignored",
        AUTHORIZATION: "Bearer planted",
      },
    });
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(upstream.calls.length, 3);
    assert.ok(upstream.calls.every((call) => !hasAuthHeader(call)));
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new DocketpeekClient({
      fetchFn: upstream.fetchFn,
      env: { DISTRESSDILIGENCE_API_KEY: "should-never-be-sent" },
    });
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECALL, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a check_recall_exposure call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECALL, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RECALL);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a ch11_preview call with a days window verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PREVIEW, { days: 30 });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PREVIEW);
    assert.deepEqual(params.arguments, { days: 30 });
  });

  it("forwards check_recall_exposure and ch11_preview under their own names", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(RECALL, SAMPLE_ARGS);
    await c.callTool(PREVIEW, {});
    const callParams = upstream.calls
      .filter((call) => call.body.method === "tools/call")
      .map((call) => call.body.params as Record<string, unknown>);
    assert.deepEqual(callParams.map((p) => p.name), [RECALL, PREVIEW]);
    assert.deepEqual(callParams[0].arguments, SAMPLE_ARGS);
    assert.deepEqual(callParams[1].arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "recall lookup failed" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      PREVIEW,
      { days: 7 },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PREVIEW);
    assert.deepEqual(params.arguments, { days: 7 });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as docketpeek error text", () => {
  it("maps a JSON-RPC error to `docketpeek error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "recall lookup failed upstream" },
    });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "docketpeek error: recall lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to docketpeek error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "docketpeek error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "docketpeek error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "docketpeek error: malformed response");
  });

  it("maps a non-2xx upstream status to docketpeek error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "docketpeek error: HTTP 500");
  });

  it("maps a throwing fetch to docketpeek error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^docketpeek error: /);
  });

  it("maps a throwing initialize fetch to docketpeek error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "docketpeek error: socket hang up");
  });

  it("maps a timed-out call to docketpeek error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(RECALL, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^docketpeek error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, RECALL, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, RECALL, "name=Example"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid check_recall_exposure call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, RECALL, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PREVIEW, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /check_recall_exposure, ch11_preview/);
  });

  it("the omitted diligence_brief tool is not a CLI command and exits 2", () => {
    const res = runCli(["diligence_brief", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*diligence_brief/);
  });

  it("the omitted quick_scan tool is not a CLI command and exits 2", () => {
    const res = runCli(["quick_scan", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*quick_scan/);
  });

  it("the omitted ch11_feed tool is not a CLI command and exits 2", () => {
    const res = runCli(["ch11_feed", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*ch11_feed/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([RECALL, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([RECALL, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
