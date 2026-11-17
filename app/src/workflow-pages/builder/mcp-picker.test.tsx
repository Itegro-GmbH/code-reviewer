// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The pickers of MCP servers in the lane builder (#1052): on the lane card for the lane, in the inspector of an agent step to narrow it.
// They show servers by name and write ids; a server that failed its last test is marked; one the lane names and the workspace no longer
// has can be taken out.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "./document.ts";
import { Inspector } from "./inspector.tsx";
import { LaneCard } from "./lane-card.tsx";
import type { McpServerOption } from "./mcp-edit.ts";
import { reachLookupFor } from "./test-fixtures.ts";

afterEach(cleanup);

const SERVERS: McpServerOption[] = [
  { id: "id-github", name: "GitHub", status: "ok" },
  { id: "id-linear", name: "Linear", status: "untested" },
  { id: "id-sentry", name: "Sentry", status: "failed" },
];

const lane = (over: Doc = {}): Doc => ({
  version: 1,
  name: "L",
  trigger: { kind: "manual" },
  steps: [
    {
      id: "work",
      kind: "agent",
      profile: "implementer",
      instruction: "Do it.",
    },
  ],
  ...over,
});

function Card({
  start,
  servers = SERVERS,
  seen,
}: {
  start: Doc;
  servers?: McpServerOption[];
  seen?: (doc: Doc) => void;
}) {
  const [doc, setDoc] = useState(start);
  return (
    <LaneCard
      doc={doc}
      version={1}
      versions={[]}
      mcpServers={servers}
      mcpHref="/w/acme/mcp"
      onChange={(next) => {
        seen?.(next);
        setDoc(next);
      }}
    />
  );
}

function Step({
  start,
  servers = SERVERS,
  seen,
}: {
  start: Doc;
  servers?: McpServerOption[];
  seen?: (doc: Doc) => void;
}) {
  const [doc, setDoc] = useState(start);
  return (
    <Inspector
      doc={doc}
      pointer="/steps/0"
      problems={[]}
      profiles={[{ name: "implementer", version: 1 }]}
      mcpServers={servers}
      lookup={(request) => reachLookupFor(doc)(request)}
      headingRef={{ current: null }}
      onChange={(next) => {
        seen?.(next);
        setDoc(next);
      }}
      onRemove={() => {}}
      onMove={() => {}}
    />
  );
}

const group = (name: string) => screen.getByRole("group", { name });

describe("the MCP servers on the lane card", () => {
  // #1052-T01
  it("lists the servers of the workspace by name, none checked on a lane that names none, and writes the id of the one that is checked", async () => {
    const seen: Doc[] = [];
    render(<Card start={lane()} seen={(doc) => seen.push(doc)} />);

    const servers = group("MCP servers");
    for (const name of ["GitHub", "Linear", "Sentry"])
      expect(
        (
          within(servers).getByRole("checkbox", { name }) as HTMLButtonElement
        ).getAttribute("aria-checked"),
      ).toBe("false");
    await userEvent.click(
      within(servers).getByRole("checkbox", { name: "Linear" }),
    );
    await userEvent.click(
      within(servers).getByRole("checkbox", { name: "GitHub" }),
    );

    expect(seen.at(-1)?.mcp).toEqual(["id-linear", "id-github"]);
    await userEvent.click(
      within(servers).getByRole("checkbox", { name: "Linear" }),
    );
    await userEvent.click(
      within(servers).getByRole("checkbox", { name: "GitHub" }),
    );
    // A lane that names nothing again has no `mcp` at all.
    expect(seen.at(-1)).not.toHaveProperty("mcp");
  });

  // #1052-T02
  it("marks a server whose last test failed as broken, and a server that was never tested as nothing worse", () => {
    render(<Card start={lane({ mcp: ["id-sentry", "id-linear"] })} />);

    const servers = group("MCP servers");
    expect(within(servers).getByText(/last test failed/i)).toBeTruthy();
    expect(within(servers).getAllByText(/last test failed/i)).toHaveLength(1);
  });

  // #1052-T02
  it("shows a server the lane names and the workspace does not have as missing, and takes it out when unchecked", async () => {
    const seen: Doc[] = [];
    render(
      <Card
        start={lane({ mcp: ["id-github", "id-gone"] })}
        seen={(doc) => seen.push(doc)}
      />,
    );

    const servers = group("MCP servers");
    expect(
      within(servers).getByText(/no longer in this workspace/i),
    ).toBeTruthy();
    await userEvent.click(
      within(servers).getByRole("checkbox", { name: /id-gone/ }),
    );

    expect(seen.at(-1)?.mcp).toEqual(["id-github"]);
  });

  // #1052-T01
  it("takes a server out of the steps that named it when the lane drops it", async () => {
    const seen: Doc[] = [];
    const start = lane({ mcp: ["id-github", "id-linear"] });
    (start.steps as Doc[])[0]!.mcp = ["id-linear"];
    render(<Card start={start} seen={(doc) => seen.push(doc)} />);

    await userEvent.click(
      within(group("MCP servers")).getByRole("checkbox", { name: "Linear" }),
    );

    expect(seen.at(-1)?.mcp).toEqual(["id-github"]);
    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).mcp).toEqual([]);
  });

  // #1052-T03
  it("says so, and points to the MCP page, when the workspace has no server; the lane stays as it is", () => {
    render(<Card start={lane()} servers={[]} />);

    expect(screen.getByText(/no mcp servers in this workspace/i)).toBeTruthy();
    expect(
      (
        screen.getByRole("link", { name: /mcp page/i }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/w/acme/mcp");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("the MCP servers of an agent step", () => {
  // #1052-T01
  it("shows the lane's servers all checked while the step follows the lane, and narrows to an explicit list when one is unchecked", async () => {
    const seen: Doc[] = [];
    render(
      <Step
        start={lane({ mcp: ["id-github", "id-linear"] })}
        seen={(doc) => seen.push(doc)}
      />,
    );

    const servers = group("MCP servers of this step");
    const box = (name: string) =>
      within(servers).getByRole("checkbox", { name });
    expect(box("GitHub").getAttribute("aria-checked")).toBe("true");
    expect(box("Linear").getAttribute("aria-checked")).toBe("true");
    // A server the lane does not name is not offered.
    expect(
      within(servers).queryByRole("checkbox", { name: "Sentry" }),
    ).toBeNull();

    await userEvent.click(box("Linear"));

    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).mcp).toEqual([
      "id-github",
    ]);
    expect(box("Linear").getAttribute("aria-checked")).toBe("false");
    // Checked again: it follows the lane again, the key is gone.
    await userEvent.click(box("Linear"));
    expect((seen.at(-1)?.steps as Doc[])[0]).not.toHaveProperty("mcp");
  });

  // #1052-T01
  it("writes an empty list for none, and says that the step then uses no server", async () => {
    const seen: Doc[] = [];
    render(
      <Step
        start={lane({ mcp: ["id-github"] })}
        seen={(doc) => seen.push(doc)}
      />,
    );

    await userEvent.click(
      within(group("MCP servers of this step")).getByRole("checkbox", {
        name: "GitHub",
      }),
    );

    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).mcp).toEqual([]);
    expect(screen.getByText(/uses no mcp server/i)).toBeTruthy();
  });

  // #1052-T03
  it("offers nothing to pick on a lane that names no server, and says where to add them", () => {
    render(<Step start={lane()} />);

    expect(
      screen.queryByRole("group", { name: "MCP servers of this step" }),
    ).toBeNull();
    expect(screen.getByText(/lane names no mcp server/i)).toBeTruthy();
  });

  // #1052-T02
  it("shows a server of the step's own list that its lane does not name, so it can be taken out", async () => {
    const seen: Doc[] = [];
    const start = lane({ mcp: ["id-github"] });
    (start.steps as Doc[])[0]!.mcp = ["id-github", "id-sentry"];
    render(<Step start={start} seen={(doc) => seen.push(doc)} />);

    const servers = group("MCP servers of this step");
    expect(within(servers).getByText(/not in the lane/i)).toBeTruthy();
    await userEvent.click(
      within(servers).getByRole("checkbox", { name: "Sentry" }),
    );

    // What is left is the lane's list: the step follows the lane.
    expect((seen.at(-1)?.steps as Doc[])[0]).not.toHaveProperty("mcp");
  });
});
