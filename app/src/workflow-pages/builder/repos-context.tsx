// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Where the repository list of an agent step gets the repositories of the workspace and the branches of one (#1094): the routes of the
// Implementer form (`GET .../implementer/repositories` and `.../repositories/:id/branches`). The builder provides the calls; the lists are
// loaded when a step first asks and kept (branches per repository), so moving between steps does not ask again. Without a provider (or where
// the routes do not exist) the list is empty and the field is typed.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RequestResult } from "../../ui/json-request.ts";
import type {
  BranchChoices,
  RepositoryChoice,
} from "../../implementer/service.ts";

export type RepoPickerApi = {
  repositories(): Promise<RequestResult<{ repositories: RepositoryChoice[] }>>;
  branches(repositoryId: string): Promise<RequestResult<BranchChoices>>;
};

export type RepoChoices = {
  /** `loading` until the first answer; `failed` when the routes answered with an error (or are not there). */
  status: "loading" | "ready" | "failed";
  repositories: readonly RepositoryChoice[];
  /** The branches of a repository once loaded, or `loading` / `failed` / undefined (not asked yet). */
  branchesOf(
    repositoryId: string,
  ): BranchChoices | "loading" | "failed" | undefined;
  /** Asks for the branches of a repository, once. */
  loadBranches(repositoryId: string): void;
};

const EMPTY: RepoChoices = {
  status: "failed",
  repositories: [],
  branchesOf: () => undefined,
  loadBranches: () => undefined,
};

type ContextValue = { choices: RepoChoices; request: () => void };

const RepoContext = createContext<ContextValue>({
  choices: EMPTY,
  request: () => undefined,
});

type BranchState = BranchChoices | "loading" | "failed";

export function RepoProvider({
  api,
  children,
}: {
  api: RepoPickerApi | undefined;
  children: ReactNode;
}) {
  // The repositories are asked for when the first agent step shows its list, not for every lane that never opens one.
  const [wanted, setWanted] = useState(false);
  const request = useCallback(() => setWanted(true), []);
  const [repositories, setRepositories] = useState<{
    status: RepoChoices["status"];
    list: readonly RepositoryChoice[];
  }>({ status: api === undefined ? "failed" : "loading", list: [] });
  const [branches, setBranches] = useState<ReadonlyMap<string, BranchState>>(
    new Map(),
  );
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (api === undefined || !wanted) return;
    let live = true;
    void api.repositories().then((answer) => {
      if (!live) return;
      setRepositories(
        answer.ok
          ? { status: "ready", list: answer.data.repositories }
          : { status: "failed", list: [] },
      );
    });
    return () => {
      live = false;
    };
  }, [api, wanted]);
  const loadBranches = useCallback(
    (repositoryId: string) => {
      if (api === undefined || asked.current.has(repositoryId)) return;
      asked.current.add(repositoryId);
      setBranches((map) => new Map(map).set(repositoryId, "loading"));
      void api
        .branches(repositoryId)
        .then((answer) =>
          setBranches((map) =>
            new Map(map).set(repositoryId, answer.ok ? answer.data : "failed"),
          ),
        );
    },
    [api],
  );
  const value = useMemo<ContextValue>(
    () => ({
      request,
      choices: {
        status: repositories.status,
        repositories: repositories.list,
        branchesOf: (id) => branches.get(id),
        loadBranches,
      },
    }),
    [request, repositories, branches, loadBranches],
  );
  return <RepoContext.Provider value={value}>{children}</RepoContext.Provider>;
}

/** The choices; the first use asks the routes for the repositories. */
export function useRepoChoices(): RepoChoices {
  const { choices, request } = useContext(RepoContext);
  useEffect(request, [request]);
  return choices;
}
