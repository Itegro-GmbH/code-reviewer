// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The repository list in the inspector of an agent step (#1094, epic #1090): the picker over the workspace's repositories, the branches of the
// repository that is picked for the base, the optional branch, and what is left to type when the routes give nothing.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "./document.ts";
import { Inspector } from "./inspector.tsx";
import { RepoProvider, type RepoPickerApi } from "./repos-context.tsx";
import { reachLookupFor } from "./test-fixtures.ts";

afterEach(cleanup);

const lane = (step: Doc = {}): Doc => ({
  version: 1,
  name: "L",
  trigger: { kind: "manual" },
  steps: [
    {
      id: "work",
      kind: "agent",
      profile: "implementer",
      instruction: "Do it.",
      ...step,
    },
  ],
});

function Step({
  start,
  api,
  seen,
}: {
  start: Doc;
  api: RepoPickerApi | undefined;
  seen?: (doc: Doc) => void;
}) {
  const [doc, setDoc] = useState(start);
  return (
    <RepoProvider api={api}>
      <Inspector
        doc={doc}
        pointer="/steps/0"
        problems={[]}
        profiles={[{ name: "implementer", version: 1 }]}
        lookup={(request) => reachLookupFor(doc)(request)}
        headingRef={{ current: null }}
        onChange={(next) => {
          seen?.(next);
          setDoc(next);
        }}
        onRemove={() => {}}
        onMove={() => {}}
      />
    </RepoProvider>
  );
}

const apiOf = (): RepoPickerApi & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    repositories: () =>
      Promise.resolve({
        ok: true,
        data: {
          repositories: [
            {
              id: "r-app",
              fullName: "acme/app",
              writeGranted: true,
              unwritable: null,
            },
            {
              id: "r-lib",
              fullName: "acme/lib",
              writeGranted: false,
              unwritable: "permission_missing",
            },
          ],
        },
      }),
    branches: (id: string) => {
      asked.push(id);
      return Promise.resolve({
        ok: true,
        data: {
          defaultBranch: "main",
          branches: ["main", "develop"],
          truncated: false,
        },
      });
    },
  } as never;
};

const group = () => screen.getByRole("group", { name: "Repositories" });

describe("the repository list of an agent step in the inspector", () => {
  // #1094-T60
  it("adds a repository, picks it from the workspace, picks its base from its branches and types the branch", async () => {
    const seen: Doc[] = [];
    const api = apiOf();
    render(<Step start={lane()} api={api} seen={(doc) => seen.push(doc)} />);

    await userEvent.click(
      within(group()).getByRole("button", { name: "Add a repository" }),
    );
    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).repos).toEqual([
      { repo: "" },
    ]);

    const picker = await screen.findByLabelText("Repository 1");
    await userEvent.selectOptions(picker, "acme/app");
    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).repos).toEqual([
      { repo: "acme/app" },
    ]);
    // A repository without write access is offered, and said so.
    expect(
      within(picker).getByRole("option", {
        name: "acme/lib (No write access)",
      }),
    ).toBeTruthy();

    await waitFor(() => expect(api.asked).toEqual(["r-app"]));
    const base = await screen.findByLabelText("Base branch 1");
    expect(
      within(base).getByRole("option", {
        name: "The default branch of the repository (main)",
      }),
    ).toBeTruthy();
    await userEvent.selectOptions(base, "develop");
    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).repos).toEqual([
      { repo: "acme/app", base: "develop" },
    ]);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Branch (optional) 1" }),
      "fix-1",
    );
    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).repos).toEqual([
      { repo: "acme/app", base: "develop", branch: "fix-1" },
    ]);
  });

  // #1094-T61
  it("lists every repository of a step that has several, and removes one", async () => {
    const seen: Doc[] = [];
    render(
      <Step
        start={lane({
          repos: [
            { repo: "acme/app", branch: "x" },
            { repo: "{{trigger.input.repo}}" },
          ],
        })}
        api={apiOf()}
        seen={(doc) => seen.push(doc)}
      />,
    );
    expect(await screen.findByLabelText("Repository 1")).toBeTruthy();
    // The second one is a reference: typed, not picked.
    expect(
      screen.getByRole("textbox", { name: /Repository 2 \(owner\/name\)/ }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove repository 1" }),
    );
    expect(((seen.at(-1)?.steps as Doc[])[0] as Doc).repos).toEqual([
      { repo: "{{trigger.input.repo}}" },
    ]);
  });

  // #1094-T64
  it("keeps what was typed with its own repository when an entry before it is removed", async () => {
    render(
      <Step
        start={lane({
          repos: [
            { repo: "acme/app" },
            { repo: "acme/lib" },
            { repo: "acme/app", branch: "x" },
          ],
        })}
        api={apiOf()}
      />,
    );
    // The third one is switched to typing its repository.
    await userEvent.selectOptions(
      await screen.findByLabelText("Repository 3"),
      "\u0000other",
    );
    expect(
      screen.getByRole("textbox", { name: /Repository 3 \(owner\/name\)/ }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove repository 1" }),
    );
    // It is the second now, and still typed; the one before it is still picked.
    expect(
      screen.getByRole("textbox", { name: /Repository 2 \(owner\/name\)/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Repository 1").tagName).toBe("SELECT");
  });

  // #1094-T62
  it("types the repository when the routes give nothing, and says so", async () => {
    const api = {
      repositories: () =>
        Promise.resolve({
          ok: false,
          status: 404,
          code: "NOT_FOUND",
          issues: [],
        }),
      branches: () => Promise.reject(new Error("not asked")),
    } as never as RepoPickerApi;
    render(<Step start={lane({ repos: [{ repo: "acme/app" }] })} api={api} />);
    expect(
      await screen.findByText(
        /repositories of the workspace could not be loaded/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: /Repository 1 \(owner\/name\)/ }),
    ).toBeTruthy();
  });

  // #1094-T63
  it("says that a step that continues a session keeps that session's repositories", () => {
    render(
      <Step start={lane({ session: { continue: "work" } })} api={undefined} />,
    );
    expect(
      screen.getByText(/keeps the repositories of that session/i),
    ).toBeTruthy();
  });
});
