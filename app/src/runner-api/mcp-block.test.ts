// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";
import { mcpBlockOf } from "./mcp-block.ts";

const job = { id: "job-1", workspaceId: "w1" } as unknown as Job;

function server(id: string, name: string, transport: string): StoredMcpServer {
  return {
    id,
    workspaceId: "w1",
    name,
    transport,
    // What a stored server has and the job must never carry.
    url: "https://secret-path.example.com/mcp",
    authKind: "header",
    headerNames: ["Authorization"],
  } as StoredMcpServer;
}

function deps(result: { servers: StoredMcpServer[]; unavailable: number }) {
  const lines: string[] = [];
  const asked: string[] = [];
  return {
    lines,
    asked,
    deps: {
      jobMcp: (workspaceId: string) => {
        asked.push(workspaceId);
        return { serversOf: () => Promise.resolve(result) };
      },
      logger: { info: (line: string) => lines.push(line), error: () => {} },
    },
  };
}

describe("the MCP servers a claim puts in the job", () => {
  // #1053-T01
  it("carries the id, the name and the transport of each server and nothing else: no address, no header names", async () => {
    const { deps: d, asked } = deps({
      servers: [
        server("a", "Linear", "streamable-http"),
        server("b", "Docs", "sse"),
      ],
      unavailable: 0,
    });
    const block = await mcpBlockOf(d, {
      job,
      features: ["implementer_mcp"],
      startedByWorkflow: true,
    });
    expect(block).toEqual({
      servers: [
        { id: "a", name: "Linear", transport: "streamable-http" },
        { id: "b", name: "Docs", transport: "sse" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("secret-path");
    expect(JSON.stringify(block)).not.toContain("Authorization");
    expect(asked).toEqual(["w1"]);
  });

  it("counts a server the workspace no longer has, and says so even when none is left", async () => {
    const { deps: d } = deps({ servers: [], unavailable: 2 });
    expect(
      await mcpBlockOf(d, {
        job,
        features: ["implementer_mcp"],
        startedByWorkflow: true,
      }),
    ).toEqual({ servers: [], unavailable: 2 });
  });

  it("is nothing for a step without servers, and nothing is asked for a turn no workflow step started", async () => {
    const none = deps({ servers: [], unavailable: 0 });
    expect(
      await mcpBlockOf(none.deps, {
        job,
        features: ["implementer_mcp"],
        startedByWorkflow: true,
      }),
    ).toBeUndefined();
    const plain = deps({ servers: [server("a", "A", "sse")], unavailable: 0 });
    expect(
      await mcpBlockOf(plain.deps, {
        job,
        features: ["implementer_mcp"],
        startedByWorkflow: false,
      }),
    ).toBeUndefined();
    expect(plain.asked).toEqual([]);
  });

  it("is left out for a caller that did not name the feature, before any lane or server is read, and the log says so (a turn is not refused: the agent only lacks tools)", async () => {
    const {
      deps: d,
      lines,
      asked,
    } = deps({
      servers: [server("a", "Linear", "streamable-http")],
      unavailable: 0,
    });
    expect(
      await mcpBlockOf(d, { job, features: [], startedByWorkflow: true }),
    ).toBeUndefined();
    expect(lines.join("\n")).toContain("job=job-1");
    expect(lines.join("\n")).toContain("implementer_mcp");
    expect(lines.join("\n")).not.toContain("Linear");
    expect(asked).toEqual([]);
  });

  // #1053-T13
  it("does not fail the claim when the servers cannot be resolved: no block, and the log says so with the job and no value", async () => {
    const errors: string[] = [];
    const d = {
      jobMcp: () => ({
        serversOf: () =>
          Promise.reject(new Error('relation "mcp_servers" does not exist')),
      }),
      logger: { info: () => {}, error: (line: string) => errors.push(line) },
    };
    expect(
      await mcpBlockOf(d, {
        job,
        features: ["implementer_mcp"],
        startedByWorkflow: true,
      }),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("job=job-1");
    expect(errors[0]).toContain("runs without them");
  });

  it("is nothing where the deployment has no MCP runtime", async () => {
    expect(
      await mcpBlockOf(
        { logger: { info: () => {}, error: () => {} } },
        { job, features: ["implementer_mcp"], startedByWorkflow: true },
      ),
    ).toBeUndefined();
  });
});
