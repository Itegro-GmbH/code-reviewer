// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// "MCP tool calls" on the detail page of a run of the Implementer (#1055, epic #1049): what the agent did with MCP tools, one line for each call
// (the server, the tool, how long it took, how it ended), a refusal shown as one (the app did not call the server) and a failure as a failure.
// The arguments and the answers of a tool are not stored, so none can be shown. Everything in it is text from the agent or from people and is
// rendered as text. A run that made no call shows nothing at all, so a run without MCP is as it was. It follows the poll of the run
// (`use-run-mcp-calls.ts`) and shows the newest calls first-class: a long list renders only the newest and adds more on request.
import { useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import type { McpCallView } from "../mcp-calls-view.ts";
import type { RunsApi } from "./api.ts";
import { RENDER_CALLS } from "./mcp-calls-merge.ts";
import {
  callDurationText,
  earlierCallsText,
  MCP_CALLS_COPY,
  omittedCallsText,
  outcomeText,
} from "./mcp-calls-messages.ts";
import { useRunMcpCalls } from "./use-run-mcp-calls.ts";

/** The name of the server, or where it was not looked up the start of its id. */
function serverLabel(call: McpCallView): string {
  return call.serverName === ""
    ? `${MCP_CALLS_COPY.unknownServer} ${call.serverId.slice(0, 8)}`
    : call.serverName;
}

function CallLine({ call }: { call: McpCallView }) {
  const bad = call.result === "refused" || call.result === "failed";
  return (
    <li
      data-slot="run-mcp-call"
      data-result={call.result}
      className="flex flex-wrap items-baseline gap-x-2 text-sm break-words"
    >
      <span className="min-w-0 font-semibold break-all">
        {serverLabel(call)}
      </span>
      <span className="min-w-0 font-mono break-all">
        {call.tool ?? call.rpcMethod ?? ""}
      </span>
      <span className={bad ? "text-danger" : "text-muted-foreground"}>
        {outcomeText(call.result, call.outcome)}
        {bad ? ` (${String(call.status)})` : ""}
      </span>
      <span className="text-muted-foreground">
        {callDurationText(call.durationMs)}
      </span>
    </li>
  );
}

export function RunMcpCalls({
  api,
  runId,
  tick,
}: {
  api: RunsApi;
  runId: string;
  /** The stamp of the newest snapshot of the run: every new one asks for the calls once. */
  tick: string;
}) {
  const { calls, full, omitted, failure } = useRunMcpCalls({
    api,
    runId,
    tick,
  });
  const [cap, setCap] = useState(RENDER_CALLS);
  const headingId = useId();
  if (calls.length === 0) return null;
  const hidden = Math.max(0, calls.length - cap);
  const shown = calls.slice(hidden);
  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle>
          <h2
            id={headingId}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {MCP_CALLS_COPY.title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{MCP_CALLS_COPY.intro}</p>
        {failure === null ? null : (
          <p data-slot="run-mcp-calls-failed" className="text-sm text-warning">
            {MCP_CALLS_COPY.failed}
          </p>
        )}
        {full ? (
          <p
            data-slot="run-mcp-calls-full"
            className="text-xs text-muted-foreground"
          >
            {MCP_CALLS_COPY.full}
          </p>
        ) : null}
        {omitted > 0 ? (
          <p
            data-slot="run-mcp-calls-omitted"
            className="text-xs text-muted-foreground"
          >
            {omittedCallsText(omitted)}
          </p>
        ) : null}
        {hidden === 0 ? null : (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setCap((before) => before + RENDER_CALLS)}
            >
              {earlierCallsText(hidden)}
            </Button>
          </div>
        )}
        <ul
          aria-label={MCP_CALLS_COPY.logLabel}
          className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto rounded-lg border border-border p-3"
        >
          {shown.map((call) => (
            <CallLine key={call.seq} call={call} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
