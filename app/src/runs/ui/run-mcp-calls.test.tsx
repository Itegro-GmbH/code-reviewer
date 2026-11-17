// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// "MCP tool calls" on the detail page of a run of the Implementer (#1055, epic #1049): each call of the agent through the MCP proxy as one line
// (server, tool, duration, how it ended), a refusal shown as one, nothing at all for a run without calls, a poll of the run as the clock, new
// calls merged after a cursor, and every text rendered as text.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { McpCallsSnapshot, McpCallView } from "../mcp-calls-view.ts";
import type { RunsApi } from "./api.ts";
import { RunMcpCalls } from "./run-mcp-calls.tsx";

afterEach(cleanup);

const RUN = "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11";
const SERVER = "11111111-1111-4111-8111-111111111111";

const callView = (
  seq: number,
  over: Partial<McpCallView> = {},
): McpCallView => ({
  seq,
  serverId: SERVER,
  serverName: "Linear",
  rpcMethod: "tools/call",
  tool: "list_issues",
  status: 200,
  outcome: "ok",
  result: "ok",
  durationMs: 120,
  requestBytes: 90,
  responseBytes: 4000,
  at: "2026-11-17T08:00:00.000Z",
  ...over,
});

const answer = (
  calls: McpCallView[],
  options: {
    cursor?: number;
    hasMore?: boolean;
    full?: boolean;
    omitted?: number;
  } = {},
): RequestResult<McpCallsSnapshot> => ({
  ok: true,
  data: {
    calls,
    cursor: options.cursor ?? Math.max(0, ...calls.map((call) => call.seq)),
    hasMore: options.hasMore ?? false,
    full: options.full ?? false,
    omitted: options.omitted ?? 0,
  },
});

function apiAnswering(...answers: RequestResult<McpCallsSnapshot>[]) {
  const mcpCalls = vi.fn<RunsApi["mcpCalls"]>(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next ?? answer([]);
  });
  return { api: { mcpCalls } as unknown as RunsApi, mcpCalls };
}

async function show(api: RunsApi, tick = "t1") {
  const view = render(<RunMcpCalls api={api} runId={RUN} tick={tick} />);
  await act(async () => {});
  return {
    ...view,
    again: async (next: string) => {
      view.rerender(<RunMcpCalls api={api} runId={RUN} tick={next} />);
      await act(async () => {});
    },
  };
}

describe("the MCP tool calls of a run", () => {
  // #1055-T01
  it("shows each call with the server, the tool, the duration and how it ended", async () => {
    const { api } = apiAnswering(
      answer([
        callView(1),
        callView(2, {
          serverName: "Sentry",
          tool: "get_event",
          durationMs: 2500,
        }),
      ]),
    );

    await show(api);

    expect(screen.getByRole("region", { name: "MCP tool calls" })).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Linear");
    expect(rows[0]?.textContent).toContain("list_issues");
    expect(rows[0]?.textContent).toContain("120 ms");
    expect(rows[0]?.textContent).toContain("done");
    expect(rows[1]?.textContent).toContain("Sentry");
    expect(rows[1]?.textContent).toContain("get_event");
    expect(rows[1]?.textContent).toContain("2.5 s");
  });

  // #1055-T01
  it("shows nothing at all for a run that made no MCP call", async () => {
    const { api } = apiAnswering(answer([]));

    const view = await show(api);

    expect(screen.queryByRole("region", { name: "MCP tool calls" })).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  // #1055-T06
  it("shows a refusal as one, with the status the agent got and why, and a failure as a failure", async () => {
    const { api } = apiAnswering(
      answer([
        callView(1, {
          serverName: "",
          status: 404,
          outcome: "mcp_server_unavailable",
          result: "refused",
          durationMs: 0,
        }),
        callView(2, {
          status: 429,
          outcome: "mcp_call_limit_reached",
          result: "refused",
        }),
        callView(3, {
          status: 503,
          outcome: "mcp_credential_broken",
          result: "refused",
        }),
        callView(4, {
          status: 503,
          outcome: "mcp_proxy_timeout",
          result: "failed",
        }),
        callView(5, { outcome: "cancelled", result: "cancelled" }),
      ]),
    );

    await show(api);

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.getAttribute("data-result")).toBe("refused");
    expect(rows[0]?.textContent).toContain("404");
    expect(rows[0]?.textContent).toMatch(/refused.*not available/i);
    // No name where the server was not looked up: the id, shortened, stands for it.
    expect(rows[0]?.textContent).toContain("11111111");
    expect(rows[1]?.textContent).toMatch(/refused.*call limit/i);
    expect(rows[1]?.textContent).toContain("429");
    expect(rows[2]?.textContent).toMatch(/refused.*credential/i);
    expect(rows[2]?.textContent).toContain("503");
    expect(rows[3]?.getAttribute("data-result")).toBe("failed");
    expect(rows[3]?.textContent).toMatch(/failed.*timed out/i);
    expect(rows[4]?.textContent).toMatch(/cancelled/i);
  });

  // #1055-T02
  it("renders the names as text, never as markup", async () => {
    const { api } = apiAnswering(
      answer([
        callView(1, {
          serverName: "<img src=x onerror=alert(1)>",
          tool: "<b>bold</b>",
        }),
      ]),
    );

    const view = await show(api);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("b")).toBeNull();
    expect(view.container.textContent).toContain("<b>bold</b>");
  });

  // #1055-T01
  it("asks again with each new snapshot of the run, after the cursor, and adds the new calls", async () => {
    const { api, mcpCalls } = apiAnswering(
      answer([callView(1)]),
      answer([callView(2, { tool: "get_issue" })]),
    );
    const view = await show(api, "t1");

    await view.again("t2");

    expect(mcpCalls).toHaveBeenNthCalledWith(1, RUN, 0);
    expect(mcpCalls).toHaveBeenNthCalledWith(2, RUN, 1);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("get_issue")).toBeTruthy();
  });

  // #1055-T01
  it("takes a call that arrives twice once", async () => {
    const { api } = apiAnswering(
      answer([callView(1)]),
      answer([callView(1), callView(2)], { cursor: 2 }),
    );
    const view = await show(api, "t1");

    await view.again("t2");

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  // #1055-T03
  it("says when the list is as long as the record keeps it", async () => {
    const { api } = apiAnswering(answer([callView(1)], { full: true }));

    await show(api);

    expect(screen.getByText(/first 2,000 calls/)).toBeTruthy();
  });

  // #1055-T01
  it("keeps what it has and says so when an update fails", async () => {
    const mcpCalls = vi
      .fn<RunsApi["mcpCalls"]>()
      .mockResolvedValueOnce(answer([callView(1)]))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        code: "NETWORK_ERROR",
        issues: [],
      });
    const api = { mcpCalls } as unknown as RunsApi;
    const view = await show(api, "t1");

    await view.again("t2");

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/could not be updated/i)).toBeTruthy();
  });

  it("shows only the newest calls of a long list and adds earlier ones on request", async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      callView(index + 1, { tool: `tool_${String(index + 1)}` }),
    );
    const { api } = apiAnswering(answer(many));

    await show(api);

    expect(screen.getAllByRole("listitem")).toHaveLength(200);
    expect(screen.getByText("tool_250")).toBeTruthy();
    expect(screen.queryByText("tool_1")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /earlier calls \(50 hidden\)/i }),
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(250);
  });

  // #1055-T03
  it("says how many refusals of 'too many calls at once' were counted and not listed", async () => {
    const { api } = apiAnswering(answer([callView(1)], { omitted: 1234 }));

    await show(api);

    expect(screen.getByText(/1,234 more calls were refused/)).toBeTruthy();
  });

  // #1055-T03: the answer starts a few rows behind the cursor; a row that came late is added once, the others are not shown twice
  it("adds a row that became visible late and shows no call twice", async () => {
    const { api } = apiAnswering(
      answer([callView(1, { tool: "first" }), callView(3, { tool: "third" })]),
      answer(
        [
          callView(1, { tool: "first" }),
          callView(2, { tool: "late" }),
          callView(3, { tool: "third" }),
        ],
        { cursor: 3 },
      ),
    );
    const view = await show(api, "t1");

    await view.again("t2");

    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("late"),
      expect.stringContaining("third"),
    ]);
  });

  // #1055-T03
  it("stops asking for good when the route refuses the cursor", async () => {
    const mcpCalls = vi
      .fn<RunsApi["mcpCalls"]>()
      .mockResolvedValueOnce(answer([callView(1)]))
      .mockResolvedValue({
        ok: false,
        status: 400,
        code: "STEPS_QUERY_INVALID",
        issues: [],
      });
    const api = { mcpCalls } as unknown as RunsApi;
    const view = await show(api, "t1");

    await view.again("t2");
    await view.again("t3");
    await view.again("t4");

    expect(mcpCalls).toHaveBeenCalledTimes(2);
  });
});
