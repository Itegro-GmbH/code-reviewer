// SPDX-License-Identifier: LicenseRef-Proprietary

// The tenant isolation of every data route of a workspace, through the real route files with the wiring the
// running server uses (the database opened at start, the services, the workspace access); only the session
// lookup and `connection()` are replaced, they need Next.js's request scope. Two workspaces hold data of
// their own. A person who is a member of one of them
//
// - asks for the other by its address: every route answers 404 `not_found`, the very answer for a
//   workspace that does not exist, with nothing of the other workspace in it, and nothing of it changes;
// - asks for their own workspace with the ids of the other (a repository, a run, a member, an invitation):
//   404 again, nothing of the other in the answer, nothing of it changes;
// - is refused, for every route, whatever the role is below the one the route needs (403 `forbidden`), and
//   is let through at that role and above (the role matrix of src/workspaces/permissions.ts at the level of
//   the routes).
//
// The table must hold every method of every route below `/api/w/[workspace]`, so a route added later
// without a row here fails the last test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createInvitationsRepository } from "../../src/db/repositories/invitations-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createSecretsRepository } from "../../src/db/repositories/secrets-repository.ts";
import { createWorkflowRunsRepository } from "../../src/db/repositories/workflow-runs-repository.ts";
import { createWorkspacesRepository } from "../../src/db/repositories/workspaces-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { jobQueueFor } from "../../src/jobs/shared.ts";
import { createWorkspaceLlm } from "../../src/llm/assemble.ts";
import {
  TEST_APP_ID,
  testAppKeys,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createImplementerEnvironmentsRepository } from "../../src/db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../../src/db/repositories/implementer-repository.ts";
import { createProfilesRepository } from "../../src/db/repositories/profiles-repository.ts";
import { createWorkflowsRepository } from "../../src/db/repositories/workflows-repository.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import { discoverRoutes } from "../../src/test-support/routes.ts";
import { MINIMUM_ROLE } from "../../src/workspaces/permissions.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({
  currentLookup: session.currentLookup,
  // The id of the session a state of the binding of an installation is bound to.
  lookupSessionId: async () => "session-of-the-test",
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const fakes: FakeGithub[] = [];
/** An environment every seeded workspace has, which the workflows of the matrix name. */
const SHARED_ENVIRONMENT = "shared";
const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

type Ids = {
  integrationId: string;
  repositoryId: string;
  runId: string;
  /** #841: a running Implementer session of the workspace and the job of its first turn. */
  sessionId: string;
  turnRunId: string;
  userId: string;
  invitationId: string;
  environmentId: string;
  workflowId: string;
  workflowRunId: string;
  profileId: string;
  runnerId: string;
};

/** What a row of the table needs to make a request: the parts of the address and the body. */
type Entry = {
  /** `GET /api/w/[workspace]/runs`, as `discoverRoutes` names the route, with the method. */
  name: string;
  route: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The lowest role that may call it. */
  minRole: WorkspaceRole;
  /** The path below `/api/w/<slug>`. */
  path: (ids: Ids) => string;
  body?: (ids: Ids) => unknown;
  /** Route parameters besides the workspace. */
  params: (ids: Ids) => Record<string, string>;
  /** The route file, imported when the first request is made. */
  file: string;
  /** Not asked with the ids of another workspace (it takes none). */
  takesNoIds?: boolean;
  /**
   * Left out of the matrix of roles: every member may call it, and what the role may do with it is decided
   * by the service (a person may leave; who may remove whom is src/workspaces/members.integration.test.ts).
   */
  notInRoleMatrix?: boolean;
  /**
   * The route is a missing path while billing is off or its adapter has no checkout: the instance gets billing on with
   * Stripe (made-up credentials that are never used: no workspace here has a billing profile, so nothing is sent) first.
   */
  billing?: boolean;
  /**
   * The route exists only with the capability `implementer` (#755): the deployment of the request is the factory with it, as
   * the proxy and the route file ask. Without it every request would be the 404 of a path that does not exist.
   */
  implementer?: boolean;
};

const ENTRIES: Entry[] = [
  {
    name: "GET runs",
    route: "/api/w/[workspace]/runs",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/runs",
    params: () => ({}),
    file: "runs/route.ts",
    takesNoIds: true,
  },
  {
    // #282-T07: the plan and usage view of the workspace in the address, for every member.
    name: "GET plan",
    route: "/api/w/[workspace]/plan",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/plan",
    params: () => ({}),
    file: "plan/route.ts",
    takesNoIds: true,
  },
  {
    name: "GET runs/[id]",
    route: "/api/w/[workspace]/runs/[id]",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: (ids) => `/runs/${ids.runId}`,
    params: (ids) => ({ id: ids.runId }),
    file: "runs/[id]/route.ts",
  },
  {
    // #745: the steps of the agent's work are read like the run, by every member of the workspace in the address.
    name: "GET runs/[id]/steps",
    route: "/api/w/[workspace]/runs/[id]/steps",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: (ids) => `/runs/${ids.runId}/steps`,
    params: (ids) => ({ id: ids.runId }),
    file: "runs/[id]/steps/route.ts",
    implementer: true,
  },
  {
    name: "PUT repositories/[repositoryId]/project",
    route: "/api/w/[workspace]/repositories/[repositoryId]/project",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_projects,
    path: (ids) => `/repositories/${ids.repositoryId}/project`,
    body: () => ({ active: true }),
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/project/route.ts",
  },
  {
    name: "GET repositories/[repositoryId]/project/settings",
    route: "/api/w/[workspace]/repositories/[repositoryId]/project/settings",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: (ids) => `/repositories/${ids.repositoryId}/project/settings`,
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/project/settings/route.ts",
  },
  {
    name: "PUT repositories/[repositoryId]/project/settings",
    route: "/api/w/[workspace]/repositories/[repositoryId]/project/settings",
    method: "PUT",
    minRole: MINIMUM_ROLE.change_project_settings,
    path: (ids) => `/repositories/${ids.repositoryId}/project/settings`,
    // #194-T04: a project-only save (kind, Dynamic model, skill) goes through the same role and
    // isolation policy as any other settings save. #430-T10: so does a save of the providers.
    body: () => ({
      settings: {
        maxFindings: 3,
        provider: "openrouter",
        reviewKind: "dynamic",
        dynamicProvider: "openrouter",
        dynamicModel: "vendor/dynamic-model",
        reviewSkill: "Review this pull request dynamically.",
      },
    }),
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/project/settings/route.ts",
  },
  {
    name: "DELETE repositories/[repositoryId]/project/settings",
    route: "/api/w/[workspace]/repositories/[repositoryId]/project/settings",
    method: "DELETE",
    minRole: MINIMUM_ROLE.change_project_settings,
    path: (ids) => `/repositories/${ids.repositoryId}/project/settings`,
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/project/settings/route.ts",
  },
  {
    name: "GET repositories/[repositoryId]/pull-requests",
    route: "/api/w/[workspace]/repositories/[repositoryId]/pull-requests",
    method: "GET",
    minRole: MINIMUM_ROLE.start_review,
    path: (ids) => `/repositories/${ids.repositoryId}/pull-requests`,
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/pull-requests/route.ts",
  },
  {
    // #923: the tickets of the project from the ticket mirror, read by every member; the full sync is a project setting.
    name: "GET repositories/[repositoryId]/issues",
    route: "/api/w/[workspace]/repositories/[repositoryId]/issues",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: (ids) => `/repositories/${ids.repositoryId}/issues`,
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/issues/route.ts",
    implementer: true,
  },
  {
    name: "POST repositories/[repositoryId]/issues/sync",
    route: "/api/w/[workspace]/repositories/[repositoryId]/issues/sync",
    method: "POST",
    minRole: MINIMUM_ROLE.change_project_settings,
    path: (ids) => `/repositories/${ids.repositoryId}/issues/sync`,
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/issues/sync/route.ts",
    implementer: true,
  },
  {
    name: "POST repositories/[repositoryId]/reviews",
    route: "/api/w/[workspace]/repositories/[repositoryId]/reviews",
    method: "POST",
    minRole: MINIMUM_ROLE.start_review,
    path: (ids) => `/repositories/${ids.repositoryId}/reviews`,
    body: () => ({ prNumber: 7, command: "review" }),
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "repositories/[repositoryId]/reviews/route.ts",
  },
  {
    name: "GET review-settings",
    route: "/api/w/[workspace]/review-settings",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/review-settings",
    params: () => ({}),
    file: "review-settings/route.ts",
    takesNoIds: true,
  },
  {
    name: "PUT review-settings",
    route: "/api/w/[workspace]/review-settings",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_review_defaults,
    path: () => "/review-settings",
    // #430-T10: the workspace default provider is a write of the workspace in the address like any other.
    body: () => ({ settings: { maxFindings: 3, provider: "openrouter" } }),
    params: () => ({}),
    file: "review-settings/route.ts",
    takesNoIds: true,
  },
  {
    name: "GET llm-key",
    route: "/api/w/[workspace]/llm-key",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/llm-key",
    params: () => ({}),
    file: "llm-key/route.ts",
    takesNoIds: true,
  },
  {
    name: "PUT llm-key",
    route: "/api/w/[workspace]/llm-key",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-key",
    body: () => ({
      provider: "openrouter",
      apiKey: "sk-or-v1-key-written-by-the-isolation-test",
    }),
    params: () => ({}),
    file: "llm-key/route.ts",
    takesNoIds: true,
  },
  {
    name: "DELETE llm-key",
    route: "/api/w/[workspace]/llm-key",
    method: "DELETE",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-key",
    params: () => ({}),
    file: "llm-key/route.ts",
    takesNoIds: true,
  },
  {
    name: "POST llm-key/test",
    route: "/api/w/[workspace]/llm-key/test",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-key/test",
    // No key in the body and none stored for the person's own workspace: nothing is sent anywhere.
    body: () => ({}),
    params: () => ({}),
    file: "llm-key/test/route.ts",
    takesNoIds: true,
  },
  {
    // #426-T10: the key of one provider, beside the alias above.
    name: "GET llm-keys/[provider]",
    route: "/api/w/[workspace]/llm-keys/[provider]",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/llm-keys/openrouter",
    params: () => ({ provider: "openrouter" }),
    file: "llm-keys/[provider]/route.ts",
    takesNoIds: true,
  },
  {
    name: "PUT llm-keys/[provider]",
    route: "/api/w/[workspace]/llm-keys/[provider]",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-keys/openrouter",
    body: () => ({ apiKey: "sk-or-v1-key-written-by-the-isolation-test" }),
    params: () => ({ provider: "openrouter" }),
    file: "llm-keys/[provider]/route.ts",
    takesNoIds: true,
  },
  {
    name: "DELETE llm-keys/[provider]",
    route: "/api/w/[workspace]/llm-keys/[provider]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-keys/openrouter",
    params: () => ({ provider: "openrouter" }),
    file: "llm-keys/[provider]/route.ts",
    takesNoIds: true,
  },
  {
    name: "POST llm-keys/[provider]/test",
    route: "/api/w/[workspace]/llm-keys/[provider]/test",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-keys/openrouter/test",
    // No key in the body and none stored for the person's own workspace: nothing is sent anywhere.
    body: () => ({}),
    params: () => ({ provider: "openrouter" }),
    file: "llm-keys/[provider]/test/route.ts",
    takesNoIds: true,
  },
  {
    // #555-T08: the models of a catalog provider for the picker of a project; a workspace on the operator's key gets a 404.
    name: "GET llm-catalog/[provider]/models",
    route: "/api/w/[workspace]/llm-catalog/[provider]/models",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/llm-catalog/deepseek/models",
    params: () => ({ provider: "deepseek" }),
    file: "llm-catalog/[provider]/models/route.ts",
    takesNoIds: true,
  },
  {
    // #755-T09: the four routes behind the Implementer form are for every member, like starting a review.
    name: "GET implementer/repositories",
    route: "/api/w/[workspace]/implementer/repositories",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/implementer/repositories",
    params: () => ({}),
    file: "implementer/repositories/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "GET implementer/repositories/[repositoryId]/branches",
    route:
      "/api/w/[workspace]/implementer/repositories/[repositoryId]/branches",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/implementer/repositories/${ids.repositoryId}/branches`,
    params: (ids) => ({ repositoryId: ids.repositoryId }),
    file: "implementer/repositories/[repositoryId]/branches/route.ts",
    implementer: true,
  },
  {
    name: "GET implementer/models",
    route: "/api/w/[workspace]/implementer/models",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/implementer/models",
    params: () => ({}),
    file: "implementer/models/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    // #841: the next instruction of a session; another workspace's session is not found, and nothing is written there.
    name: "POST implementer/sessions/[sessionId]/turns",
    route: "/api/w/[workspace]/implementer/sessions/[sessionId]/turns",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/implementer/sessions/${ids.sessionId}/turns`,
    body: () => ({
      instruction: "Add a test.",
      clientRequestId: "follow-up-request-1",
    }),
    params: (ids) => ({ sessionId: ids.sessionId }),
    file: "implementer/sessions/[sessionId]/turns/route.ts",
    implementer: true,
  },
  {
    // #841: what the Continue form of a run needs, read like the run by every member of the workspace in the address.
    name: "GET runs/[id]/continuation",
    route: "/api/w/[workspace]/runs/[id]/continuation",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: (ids) => `/runs/${ids.turnRunId}/continuation`,
    params: (ids) => ({ id: ids.turnRunId }),
    file: "runs/[id]/continuation/route.ts",
    implementer: true,
  },
  {
    // #891: a member stops a run of the Implementer; another workspace's run is not found, and nothing is marked or ended there.
    name: "POST implementer/runs/[runId]/cancel",
    route: "/api/w/[workspace]/implementer/runs/[runId]/cancel",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/implementer/runs/${ids.turnRunId}/cancel`,
    params: (ids) => ({ runId: ids.turnRunId }),
    file: "implementer/runs/[runId]/cancel/route.ts",
    implementer: true,
  },
  {
    name: "POST implementer/tasks",
    route: "/api/w/[workspace]/implementer/tasks",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/implementer/tasks",
    // The repository of the ids it is given: a repository of another workspace is not found, and nothing is written.
    body: (ids) => ({
      repositoryId: ids.repositoryId,
      baseBranch: "main",
      branch: "implementer/abc123",
      instruction: "Add a health endpoint.",
      model: { provider: "deepseek", model: "deepseek-chat" },
      clientRequestId: "request-1",
    }),
    params: () => ({}),
    file: "implementer/tasks/route.ts",
    implementer: true,
  },
  {
    // #818-T16: every member lists the environments of their own workspace; the other workspace's are not reachable.
    name: "GET environments",
    route: "/api/w/[workspace]/environments",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/environments",
    params: () => ({}),
    file: "environments/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    // #818-T16: creating, changing and deleting are for an Owner and an Admin.
    name: "POST environments",
    route: "/api/w/[workspace]/environments",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_implementer_environments,
    path: () => "/environments",
    body: () => ({ name: "Created by the matrix", vcpus: 2, setupScript: "" }),
    params: () => ({}),
    file: "environments/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "PUT environments/[environmentId]",
    route: "/api/w/[workspace]/environments/[environmentId]",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_implementer_environments,
    path: (ids) => `/environments/${ids.environmentId}`,
    body: () => ({ name: "Changed by the matrix", vcpus: 8, setupScript: "x" }),
    params: (ids) => ({ environmentId: ids.environmentId }),
    file: "environments/[environmentId]/route.ts",
    implementer: true,
  },
  {
    name: "DELETE environments/[environmentId]",
    route: "/api/w/[workspace]/environments/[environmentId]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.manage_implementer_environments,
    path: (ids) => `/environments/${ids.environmentId}`,
    params: (ids) => ({ environmentId: ids.environmentId }),
    file: "environments/[environmentId]/route.ts",
    implementer: true,
  },
  {
    // #833-M1-T228: every member lists the workflows of their own workspace; the other workspace's are not reachable.
    name: "GET workflows",
    route: "/api/w/[workspace]/workflows",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/workflows",
    params: () => ({}),
    file: "workflows/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "POST workflows",
    route: "/api/w/[workspace]/workflows",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/workflows",
    body: () => ({
      version: 1,
      name: "Created by the matrix",
      // Both workspaces have an environment of this name, so the document is valid whichever workspace the request is for.
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
      },
      steps: [
        {
          id: "work",
          kind: "agent",
          profile: "implementer",
          environment: SHARED_ENVIRONMENT,
          instruction: "x",
        },
      ],
    }),
    params: () => ({}),
    file: "workflows/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "POST workflows/validate",
    route: "/api/w/[workspace]/workflows/validate",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/workflows/validate",
    body: () => ({}),
    params: () => ({}),
    file: "workflows/validate/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "GET workflows/[workflowId]",
    route: "/api/w/[workspace]/workflows/[workflowId]",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/workflows/${ids.workflowId}`,
    params: (ids) => ({ workflowId: ids.workflowId }),
    file: "workflows/[workflowId]/route.ts",
    implementer: true,
  },
  {
    name: "PUT workflows/[workflowId]",
    route: "/api/w/[workspace]/workflows/[workflowId]",
    method: "PUT",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/workflows/${ids.workflowId}`,
    body: () => ({
      version: 1,
      name: "Changed by the matrix",
      // Both workspaces have an environment of this name, so the document is valid whichever workspace the request is for.
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
      },
      steps: [
        {
          id: "work",
          kind: "agent",
          profile: "implementer",
          environment: SHARED_ENVIRONMENT,
          instruction: "x",
        },
      ],
    }),
    params: (ids) => ({ workflowId: ids.workflowId }),
    file: "workflows/[workflowId]/route.ts",
    implementer: true,
  },
  {
    // #833-M1-T359: every member archives a workflow of their own workspace; the other workspace's is not reachable.
    name: "DELETE workflows/[workflowId]",
    route: "/api/w/[workspace]/workflows/[workflowId]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/workflows/${ids.workflowId}`,
    params: (ids) => ({ workflowId: ids.workflowId }),
    file: "workflows/[workflowId]/route.ts",
    implementer: true,
  },
  {
    // #844-T156: every member lists the runs of a workflow of their own workspace; another workspace's workflow is not reachable.
    name: "GET workflows/[workflowId]/runs",
    route: "/api/w/[workspace]/workflows/[workflowId]/runs",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/workflows/${ids.workflowId}/runs`,
    params: (ids) => ({ workflowId: ids.workflowId }),
    file: "workflows/[workflowId]/runs/route.ts",
    implementer: true,
  },
  {
    // The body names a repository that is none of the workspace's, so the start ends before it asks GitHub or writes anything.
    name: "POST workflows/[workflowId]/runs",
    route: "/api/w/[workspace]/workflows/[workflowId]/runs",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/workflows/${ids.workflowId}/runs`,
    body: () => ({
      input: { repo: "nobody/nothing" },
      clientRequestId: "matrix-request",
    }),
    params: (ids) => ({ workflowId: ids.workflowId }),
    file: "workflows/[workflowId]/runs/route.ts",
    implementer: true,
  },
  {
    name: "GET workflows/[workflowId]/runs/[runId]",
    route: "/api/w/[workspace]/workflows/[workflowId]/runs/[runId]",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/workflows/${ids.workflowId}/runs/${ids.workflowRunId}`,
    params: (ids) => ({
      workflowId: ids.workflowId,
      runId: ids.workflowRunId,
    }),
    file: "workflows/[workflowId]/runs/[runId]/route.ts",
    implementer: true,
  },
  {
    // #891: a member stops a run of a workflow; another workspace's run is not found, and nothing is marked there.
    name: "POST workflows/[workflowId]/runs/[runId]/cancel",
    route: "/api/w/[workspace]/workflows/[workflowId]/runs/[runId]/cancel",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) =>
      `/workflows/${ids.workflowId}/runs/${ids.workflowRunId}/cancel`,
    params: (ids) => ({
      workflowId: ids.workflowId,
      runId: ids.workflowRunId,
    }),
    file: "workflows/[workflowId]/runs/[runId]/cancel/route.ts",
    implementer: true,
  },
  {
    // #843-T120: every member lists the profiles of their own workspace; the other workspace's are not reachable.
    name: "GET profiles",
    route: "/api/w/[workspace]/profiles",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/profiles",
    params: () => ({}),
    file: "profiles/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "POST profiles",
    route: "/api/w/[workspace]/profiles",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/profiles",
    body: () => ({}),
    params: () => ({}),
    file: "profiles/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "POST profiles/validate",
    route: "/api/w/[workspace]/profiles/validate",
    method: "POST",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/profiles/validate",
    body: () => ({}),
    params: () => ({}),
    file: "profiles/validate/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    name: "GET profiles/[profileId]",
    route: "/api/w/[workspace]/profiles/[profileId]",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/profiles/${ids.profileId}`,
    params: (ids) => ({ profileId: ids.profileId }),
    file: "profiles/[profileId]/route.ts",
    implementer: true,
  },
  {
    name: "PUT profiles/[profileId]",
    route: "/api/w/[workspace]/profiles/[profileId]",
    method: "PUT",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/profiles/${ids.profileId}`,
    body: () => ({}),
    params: (ids) => ({ profileId: ids.profileId }),
    file: "profiles/[profileId]/route.ts",
    implementer: true,
  },
  {
    // #843-T121: every member archives a profile of their own workspace; the other workspace's is not reachable.
    name: "DELETE profiles/[profileId]",
    route: "/api/w/[workspace]/profiles/[profileId]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: (ids) => `/profiles/${ids.profileId}`,
    params: (ids) => ({ profileId: ids.profileId }),
    file: "profiles/[profileId]/route.ts",
    implementer: true,
  },
  {
    // #925: every member reads how many ToDos of their own workspace are open (the count on the sidebar link); nothing of another.
    name: "GET todos/count",
    route: "/api/w/[workspace]/todos/count",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/todos/count",
    params: () => ({}),
    file: "todos/count/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    // #854-T140: every member lists the runners of their own workspace; the other workspace's are not reachable.
    name: "GET runners",
    route: "/api/w/[workspace]/runners",
    method: "GET",
    minRole: MINIMUM_ROLE.start_implementer_task,
    path: () => "/runners",
    params: () => ({}),
    file: "runners/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    // #854-T141: an Owner or an Admin makes a registration token for their own workspace.
    name: "POST runners/tokens",
    route: "/api/w/[workspace]/runners/tokens",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_runners,
    path: () => "/runners/tokens",
    params: () => ({}),
    file: "runners/tokens/route.ts",
    takesNoIds: true,
    implementer: true,
  },
  {
    // #854-T142: an Owner or an Admin revokes a runner of their own workspace; the other workspace's is not reachable.
    name: "POST runners/[runnerId]/revoke",
    route: "/api/w/[workspace]/runners/[runnerId]/revoke",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_runners,
    path: (ids) => `/runners/${ids.runnerId}/revoke`,
    params: (ids) => ({ runnerId: ids.runnerId }),
    file: "runners/[runnerId]/revoke/route.ts",
    implementer: true,
  },
  {
    name: "POST plan-handoff",
    route: "/api/w/[workspace]/plan-handoff",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_plan,
    path: () => "/plan-handoff",
    params: () => ({}),
    file: "plan-handoff/route.ts",
    takesNoIds: true,
  },
  {
    // #501-T04: a top-up is for an Admin and an Owner. No workspace of this table has a billing profile, so the answer at the
    // right role is 409 `profile_required` and Stripe is never called.
    name: "POST billing/top-ups",
    route: "/api/w/[workspace]/billing/top-ups",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/top-ups",
    body: () => ({ amountCents: 2500, confirmBusiness: true }),
    params: () => ({}),
    file: "billing/top-ups/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    // #499-T04: the monthly total limit is read and set by an Admin and an Owner, and by nobody of another workspace.
    name: "GET billing/monthly-limit",
    route: "/api/w/[workspace]/billing/monthly-limit",
    method: "GET",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/monthly-limit",
    params: () => ({}),
    file: "billing/monthly-limit/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    name: "PUT billing/monthly-limit",
    route: "/api/w/[workspace]/billing/monthly-limit",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/monthly-limit",
    body: () => ({ monthlyLimitCents: 5_000 }),
    params: () => ({}),
    file: "billing/monthly-limit/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    // #496-T07: the key mode of the workspace is read by every member of the workspace in the address and set by an Admin and an
    // Owner, and by nobody of another workspace.
    name: "GET llm-key-mode",
    route: "/api/w/[workspace]/llm-key-mode",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/llm-key-mode",
    params: () => ({}),
    file: "llm-key-mode/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    name: "PUT llm-key-mode",
    route: "/api/w/[workspace]/llm-key-mode",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_llm_key,
    path: () => "/llm-key-mode",
    body: () => ({ keyMode: "managed" }),
    params: () => ({}),
    file: "llm-key-mode/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    // #505-T02: the journal is read by every member of the workspace in the address and by nobody of another one.
    name: "GET billing/journal",
    route: "/api/w/[workspace]/billing/journal",
    method: "GET",
    minRole: MINIMUM_ROLE.view,
    path: () => "/billing/journal",
    params: () => ({}),
    file: "billing/journal/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    // #659-T03: the invoices are listed for an Admin and an Owner, of the workspace of the address only (its own Stripe customer).
    name: "GET billing/invoices",
    route: "/api/w/[workspace]/billing/invoices",
    method: "GET",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/invoices",
    params: () => ({}),
    file: "billing/invoices/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    // #505-T02, T03: the billing details are read and kept by an Admin and an Owner, and by nobody of another workspace.
    name: "GET billing/profile",
    route: "/api/w/[workspace]/billing/profile",
    method: "GET",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/profile",
    params: () => ({}),
    file: "billing/profile/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    name: "PUT billing/profile",
    route: "/api/w/[workspace]/billing/profile",
    method: "PUT",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/profile",
    // An empty profile: at the right role the answer is 422 and nothing is stored, so the top-up entries above keep a workspace without one.
    body: () => ({}),
    params: () => ({}),
    file: "billing/profile/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    // #502-T15: "Check payment" is for an Admin and an Owner. The intent of the address is looked up in the workspace of the
    // address only (a foreign intent is `intent_not_found`, proven in src/billing/topup-check-http.integration.test.ts); here the
    // intent does not exist, so the answer at the right role is 404 `intent_not_found` and Stripe is never called.
    name: "POST billing/top-ups/[id]/check",
    route: "/api/w/[workspace]/billing/top-ups/[id]/check",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_billing,
    path: () => "/billing/top-ups/no-such-intent/check",
    params: () => ({ id: "no-such-intent" }),
    file: "billing/top-ups/[id]/check/route.ts",
    takesNoIds: true,
    billing: true,
  },
  {
    name: "PATCH workspace",
    route: "/api/w/[workspace]",
    method: "PATCH",
    minRole: MINIMUM_ROLE.rename_workspace,
    path: () => "",
    body: () => ({ name: "Renamed" }),
    params: () => ({}),
    file: "route.ts",
    takesNoIds: true,
  },
  {
    // #658: only an Owner. The name typed is wrong on purpose, so an Owner's call is a 422 and the workspace stays for the
    // next case; the deletion itself is proven in src/workspaces/delete-workspace.integration.test.ts.
    name: "DELETE workspace",
    route: "/api/w/[workspace]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.delete_workspace,
    path: () => "",
    body: () => ({ confirmName: "not the name" }),
    params: () => ({}),
    file: "route.ts",
    takesNoIds: true,
  },
  {
    name: "PATCH members/[userId]",
    route: "/api/w/[workspace]/members/[userId]",
    method: "PATCH",
    minRole: MINIMUM_ROLE.change_member_roles,
    path: (ids) => `/members/${ids.userId}`,
    body: () => ({ role: "member" }),
    params: (ids) => ({ userId: ids.userId }),
    file: "members/[userId]/route.ts",
  },
  {
    name: "DELETE members/[userId]",
    route: "/api/w/[workspace]/members/[userId]",
    method: "DELETE",
    // Every member may call it (to leave); what the role may remove is decided by the service.
    minRole: MINIMUM_ROLE.view_members,
    notInRoleMatrix: true,
    path: (ids) => `/members/${ids.userId}`,
    params: (ids) => ({ userId: ids.userId }),
    file: "members/[userId]/route.ts",
  },
  {
    name: "POST invitations",
    route: "/api/w/[workspace]/invitations",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_invitations,
    path: () => "/invitations",
    body: () => ({ email: "new-person@example.test", role: "member" }),
    params: () => ({}),
    file: "invitations/route.ts",
    takesNoIds: true,
  },
  {
    name: "POST github/connect",
    route: "/api/w/[workspace]/github/connect",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_connections,
    path: () => "/github/connect",
    body: () => ({}),
    params: () => ({}),
    file: "github/connect/route.ts",
    takesNoIds: true,
  },
  {
    name: "POST github/installations",
    route: "/api/w/[workspace]/github/installations",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_connections,
    path: () => "/github/installations",
    body: () => ({}),
    params: () => ({}),
    file: "github/installations/route.ts",
    takesNoIds: true,
  },
  {
    name: "POST github/installations/choose",
    route: "/api/w/[workspace]/github/installations/choose",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_connections,
    path: () => "/github/installations/choose",
    body: () => ({ picker: "not-a-list", installationId: "4343" }),
    params: () => ({}),
    file: "github/installations/choose/route.ts",
    takesNoIds: true,
  },
  {
    name: "DELETE integrations/[integrationId]",
    route: "/api/w/[workspace]/integrations/[integrationId]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.manage_connections,
    path: (ids) => `/integrations/${ids.integrationId}`,
    params: (ids) => ({ integrationId: ids.integrationId }),
    file: "integrations/[integrationId]/route.ts",
  },
  {
    name: "POST integrations/sync",
    route: "/api/w/[workspace]/integrations/sync",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_connections,
    path: () => "/integrations/sync",
    body: () => ({}),
    params: () => ({}),
    file: "integrations/sync/route.ts",
    takesNoIds: true,
  },
  {
    name: "DELETE invitations/[invitationId]",
    route: "/api/w/[workspace]/invitations/[invitationId]",
    method: "DELETE",
    minRole: MINIMUM_ROLE.manage_invitations,
    path: (ids) => `/invitations/${ids.invitationId}`,
    params: (ids) => ({ invitationId: ids.invitationId }),
    file: "invitations/[invitationId]/route.ts",
  },
  {
    name: "POST invitations/[invitationId]/resend",
    route: "/api/w/[workspace]/invitations/[invitationId]/resend",
    method: "POST",
    minRole: MINIMUM_ROLE.manage_invitations,
    path: (ids) => `/invitations/${ids.invitationId}/resend`,
    params: (ids) => ({ invitationId: ids.invitationId }),
    file: "invitations/[invitationId]/resend/route.ts",
  },
];

const RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 };

async function seedWorkspace(
  slug: string,
  names: { owner: string; repo: string },
) {
  const db = getDatabase();
  const workspaces = createWorkspacesRepository(db);
  const workspace = await workspaces.create({
    name: `Marker ${slug}`,
    slug,
    createdBy: null,
  });
  const integration = await createIntegrationsRepository(
    db,
    workspace.id,
  ).create({
    type: "github_app",
    displayName: `account-of-${slug}`,
    externalId: slug === "alpha" ? "4242" : "4343",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspace.id);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: slug === "alpha" ? "7001" : "7002",
      fullName: names.repo,
      url: `https://github.test/${names.repo}`,
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  await createProjectsRepository(db, workspace.id).activate(repository.id);
  const job = await jobQueueFor(workspace.id).enqueue({
    repositoryId: repository.id,
    prNumber: 7,
    prUrl: `https://github.com/${names.repo}/pull/7`,
    headSha: HEAD,
    command: "review",
    triggerKind: "manual",
    actorLogin: `login-of-${slug}`,
  });
  if (job.status !== "created") throw new Error("seeding failed");
  // The workspace's own LLM key, with a sentinel that must never show up in an answer for another workspace.
  const keySentinel = `sk-or-v1-sentinel-key-of-${slug}-0123456789`;
  await createWorkspaceLlm({
    db,
    appSecret: () => "isolation-test-secret-0123456789-0123456789",
    env: () => ({}),
  })
    .keyServiceFor(workspace.id)
    .save({ provider: "openrouter", apiKey: keySentinel }, null);
  const owner = await signedInMember(db, {
    id: names.owner,
    workspaceId: workspace.id,
    role: "owner",
  });
  // A running session of the Implementer with its first turn (#841): the next-instruction route of the other workspace must not reach it.
  const started = await createImplementerRepository(
    db,
    workspace.id,
  ).createSessionWithTurn(
    {
      repositoryId: repository.id,
      baseBranch: "main",
      branch: `implementer/${slug}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: `entry-${slug}` },
      costLimitCents: null,
      createdBy: names.owner,
    },
    async (trx, { slot }) => {
      const id = `turn-job-of-${slug}`;
      await trx
        .insertInto("jobs")
        .values({
          id,
          workspace_id: workspace.id,
          repository_id: repository.id,
          pr_number: -slot,
          pr_url: `https://github.test/${names.repo}/tree/implementer/${slug}`,
          head_sha: HEAD,
          command: "review",
          review_kind: "implementer",
          args: "",
          trigger_kind: "manual",
          actor_login: `login-of-${slug}`,
          delivery_id: `implementer:${workspace.id}:seed`,
          status: "running",
          run_after: "2026-11-05T08:00:00.000Z",
          attempts: 0,
          created_at: "2026-11-05T08:00:00.000Z",
          updated_at: "2026-11-05T08:00:00.000Z",
        })
        .execute();
      return id;
    },
  );
  const invitation = await createInvitationsRepository(db, workspace.id).create(
    {
      id: `invitation-of-${slug}`,
      email: `invited-by-${slug}@example.test`,
      role: "member",
      invitedBy: names.owner,
      tokenHash: `hash-of-${slug}`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  );
  // An environment of the Implementer (#818): a request under the other workspace's slug must not reach it.
  const environment = await createImplementerEnvironmentsRepository(
    db,
    workspace.id,
  ).create(
    {
      name: `Environment of ${slug}`,
      vcpus: 4,
      setupScript: `echo ${slug}`,
      createdBy: names.owner,
    },
    50,
  );
  if (!environment.ok) throw new Error("seeding failed");
  const shared = await createImplementerEnvironmentsRepository(
    db,
    workspace.id,
  ).create(
    {
      name: SHARED_ENVIRONMENT,
      vcpus: 4,
      setupScript: "",
      createdBy: names.owner,
    },
    50,
  );
  if (!shared.ok) throw new Error("seeding failed");
  // A workflow (#833): the other workspace's must not be reachable through this one's address, nor changed.
  const workflow = await createWorkflowsRepository(db, workspace.id).create(
    {
      name: `Workflow of ${slug}`,
      document: `{"of":"${slug}"}`,
      createdBy: names.owner,
    },
    100,
  );
  if (!workflow.ok) throw new Error("seeding failed");
  // A run of that workflow (#844): the other workspace's must not be reachable through this one's address.
  const workflowRun = await createWorkflowRunsRepository(
    db,
    workspace.id,
  ).createRun({
    workflowId: workflow.workflow.id,
    workflowVersion: 1,
    repositoryId: repository.id,
    baseBranch: "main",
    triggerInput: `{"of":"${slug}"}`,
    budgetMicroUsd: 20_000_000,
    clientRequestId: `run-${slug}`,
    createdBy: names.owner,
    actorLogin: "octocat",
  });
  // A profile (#843): the workflows of the matrix run it, and the other workspace's must not be reachable through this one's address.
  const profile = await createProfilesRepository(db, workspace.id).create(
    {
      name: "implementer",
      content: {
        description: `Profile of ${slug}`,
        model: { entryId: `entry-${slug}` },
        instructions: "",
        costLimitCents: null,
        canPush: true,
        defaultResult: null,
      },
      createdBy: names.owner,
    },
    100,
  );
  if (!profile.ok) throw new Error("seeding failed");
  // A runner on a customer's machine (#854): the other workspace's must not be revocable through this one's address.
  await db
    .insertInto("runners")
    .values({
      id: `runner-${slug}`,
      workspace_id: workspace.id,
      name: `box ${slug}`,
      labels: "linux",
      base_version: "1.0.0",
      manifest: "{}",
      limits: "{}",
      credential_hash: `hash-${slug}`,
      previous_credential_hash: null,
      created_at: "2026-11-05T08:00:00.000Z",
      last_seen_at: "2026-11-05T08:00:00.000Z",
      revoked_at: null,
    })
    .execute();
  return {
    workspace,
    owner,
    keySentinel,
    ids: {
      environmentId: environment.environment.id,
      workflowId: workflow.workflow.id,
      workflowRunId: workflowRun.run.id,
      profileId: profile.profile.id,
      runnerId: `runner-${slug}`,
      integrationId: integration.id,
      repositoryId: repository.id,
      runId: job.job.id,
      sessionId: started.session.id,
      turnRunId: started.turn.jobId,
      userId: names.owner,
      invitationId: invitation.id,
    } satisfies Ids,
  };
}

/** Billing on with the Stripe adapter: the switch, the rates, a passed check and the two credentials (present, never used). */
async function switchBillingOnWithStripe() {
  const db = getDatabase();
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    {
      enabled: true,
      adapter: "stripe",
      factorA: 50_000,
      minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
      diffAiReserveMicroUsd: 150_000,
      stripe: {
        checkedAt: "2026-10-21T10:00:00.000Z",
        checkedEnvironment: "test",
      },
      legal: { termsUrl: "https://example.com/terms" },
    },
    null,
  );
  for (const name of ["stripe_api_key", "stripe_webhook_secret"] as const)
    await createSecretsRepository(db).put({
      name,
      ciphertext: "c",
      nonce: "n",
      keyVersion: 1,
      lastFour: null,
      updatedBy: null,
    });
}

async function start() {
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
  });
  fakes.push(fake);
  for (const [name, value] of Object.entries(
    testGithubAppEnv({
      GITHUB_API_BASE_URL: fake.baseUrl,
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    }),
  ))
    if (value !== undefined) vi.stubEnv(name, value);
  // The address the app is reached at (the links of invitations are made from it) and the master key.
  vi.stubEnv("BETTER_AUTH_URL", "https://app.test");
  vi.stubEnv("APP_SECRET", "isolation-test-secret-0123456789-0123456789");
  await openRouteTestDatabase();
  // Anybody may sign up, so anybody may be invited.
  await createInstanceSettingsRepository(getDatabase()).set(
    "sign_up_rule",
    { kind: "everyone" },
    null,
  );
  // The instance has a plan management page: without one, "Manage plan" is a missing path for everybody.
  await createInstanceSettingsRepository(getDatabase()).set(
    "plan_management_url",
    "https://plans.example/manage",
    null,
  );
  // The registry reads the environment on first use, so the route files load after it was set.
  vi.resetModules();
  const alpha = await seedWorkspace("alpha", {
    owner: "owner-alpha",
    repo: "acme-alpha/secret-alpha-repo",
  });
  const beta = await seedWorkspace("beta", {
    owner: "owner-beta",
    repo: "acme-beta/secret-beta-repo",
  });
  const db = getDatabase();
  // Somebody in alpha with each role.
  const people: Record<WorkspaceRole, SessionLookup> = {
    owner: alpha.owner,
    admin: await signedInMember(db, {
      id: "admin-alpha",
      workspaceId: alpha.workspace.id,
      role: "admin",
    }),
    member: await signedInMember(db, {
      id: "member-alpha",
      workspaceId: alpha.workspace.id,
      role: "member",
    }),
  };
  const modules = new Map<string, Record<string, unknown>>();
  async function call(entry: Entry, slug: string, ids: Ids): Promise<Response> {
    let route = modules.get(entry.file);
    if (route === undefined) {
      route = (await import(
        `../../src/app/api/w/[workspace]/${entry.file}`
      )) as Record<string, unknown>;
      modules.set(entry.file, route);
    }
    const handler = route[entry.method] as (
      request: Request,
      context: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;
    if (entry.billing === true) await switchBillingOnWithStripe();
    if (entry.implementer === true) {
      vi.stubEnv("PRODUCT_ID", "factory");
      vi.stubEnv(
        "PRODUCT_CAPABILITIES",
        "review,dynamic-review,billing,implementer",
      );
    }
    const body = entry.body?.(ids);
    return handler(
      new Request(`https://app.test/api/w/${slug}${entry.path(ids)}`, {
        method: entry.method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ workspace: slug, ...entry.params(ids) }) },
    );
  }
  /** Everything stored for a workspace, to see that a request changed nothing. */
  async function rowsOf(workspaceId: string) {
    const select = (
      table:
        | "integrations"
        | "repositories"
        | "jobs"
        | "invitations"
        | "workspace_members"
        | "plan_handoff_tokens"
        | "billing_workspace_settings"
        | "implementer_environments"
        | "implementer_sessions"
        | "workflows"
        | "workflow_versions"
        | "workflow_runs"
        | "workflow_step_runs"
        | "profiles"
        | "profile_versions",
    ) =>
      db
        .selectFrom(table)
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .execute();
    return {
      workspace: await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", workspaceId)
        .execute(),
      integrations: await select("integrations"),
      repositories: await select("repositories"),
      jobs: await select("jobs"),
      invitations: await select("invitations"),
      members: await select("workspace_members"),
      planHandoffTokens: await select("plan_handoff_tokens"),
      billingWorkspaceSettings: await select("billing_workspace_settings"),
      implementerEnvironments: await select("implementer_environments"),
      implementerSessions: await select("implementer_sessions"),
      workflows: await select("workflows"),
      workflowVersions: await select("workflow_versions"),
      workflowRuns: await select("workflow_runs"),
      workflowStepRuns: await select("workflow_step_runs"),
      profiles: await select("profiles"),
      profileVersions: await select("profile_versions"),
      projects: await db
        .selectFrom("projects")
        .innerJoin("repositories", "repositories.id", "projects.repository_id")
        .selectAll("projects")
        .where("repositories.workspace_id", "=", workspaceId)
        .execute(),
      settings: await db
        .selectFrom("app_settings")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .execute(),
      secrets: await db
        .selectFrom("workspace_secrets")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .execute(),
    };
  }
  return { fake, alpha, beta, people, call, rowsOf, db };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

const MARKERS = [
  "beta",
  "secret-beta-repo",
  "login-of-beta",
  "owner-beta",
  "invited-by-beta",
  "account-of-beta",
  "sentinel-key-of-beta",
];

describe("a member of one workspace asking for another by its address", () => {
  // #101-WM-06, #101-WM-07
  it.each(ENTRIES.map((entry) => [entry.name, entry] as const))(
    "gets a 404 that is the answer for a workspace that does not exist, for %s, and changes nothing",
    async (_name, entry) => {
      const t = await start();
      session.currentLookup.mockResolvedValue(t.people.owner);
      const before = await t.rowsOf(t.beta.workspace.id);

      const foreign = await t.call(entry, "beta", t.beta.ids);
      const missing = await t.call(entry, "no-such-workspace", t.beta.ids);

      for (const response of [foreign, missing]) {
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const foreignBody = await foreign.text();
      expect(foreignBody).toBe(await missing.text());
      expect(JSON.parse(foreignBody)).toEqual({ error: "not_found" });
      expect(await t.rowsOf(t.beta.workspace.id)).toEqual(before);
    },
  );
});

describe("a member of a workspace asking for it with the ids of another one", () => {
  // #101-WM-07
  it.each(
    ENTRIES.filter((entry) => entry.takesNoIds !== true).map(
      (entry) => [entry.name, entry] as const,
    ),
  )(
    "finds nothing of the other workspace for %s and changes nothing there",
    async (_name, entry) => {
      const t = await start();
      session.currentLookup.mockResolvedValue(t.people.owner);
      const before = await t.rowsOf(t.beta.workspace.id);

      const response = await t.call(entry, "alpha", t.beta.ids);
      const text = await response.text();

      expect(response.status, text).toBe(404);
      for (const marker of MARKERS) expect(text).not.toContain(marker);
      expect(await t.rowsOf(t.beta.workspace.id)).toEqual(before);
    },
  );

  // #101-WM-07
  it("sees only its own runs, repositories and members in the answers that list things", async () => {
    const t = await start();
    session.currentLookup.mockResolvedValue(t.people.owner);
    const list = ENTRIES.find((entry) => entry.name === "GET runs");
    if (list === undefined)
      throw new Error("the table has no row for the list");

    const response = await t.call(list, "alpha", t.alpha.ids);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("secret-alpha-repo");
    for (const marker of MARKERS) expect(text).not.toContain(marker);
  });
});

describe("an account that may not use the app", () => {
  // #101-WM-02
  it.each(ENTRIES.map((entry) => [entry.name, entry] as const))(
    "gets nothing from %s: not without a workspace, not before the address is confirmed, not without a session",
    async (_name, entry) => {
      const t = await start();
      const before = await t.rowsOf(t.alpha.workspace.id);
      const user = (await signedInMember(t.db, { id: "owner-alpha" })).user;
      const lookups: Array<[SessionLookup, number, string]> = [
        [{ kind: "no_workspace", user }, 403, "no_workspace_access"],
        [{ kind: "unverified", user }, 403, "email_not_verified"],
        [{ kind: "none" }, 401, "UNAUTHENTICATED"],
      ];

      for (const [lookup, status, code] of lookups) {
        session.currentLookup.mockResolvedValue(lookup);
        const response = await t.call(entry, "alpha", t.alpha.ids);
        const text = await response.text();
        expect(response.status, `${lookup.kind}: ${text}`).toBe(status);
        expect(JSON.parse(text)).toEqual({ error: code });
      }
      expect(await t.rowsOf(t.alpha.workspace.id)).toEqual(before);
    },
  );
});

describe("the role a route needs", () => {
  const cases = ENTRIES.filter(
    (entry) => entry.notInRoleMatrix !== true,
  ).flatMap((entry) =>
    (["member", "admin", "owner"] as const).map((role) => ({
      name: entry.name,
      entry,
      role,
    })),
  );

  // #101-WM-08
  it.each(cases)(
    "$name: a person with the role $role is refused below the role the route needs and not refused at it",
    async ({ entry, role }) => {
      const t = await start();
      session.currentLookup.mockResolvedValue(t.people[role]);
      const before = await t.rowsOf(t.alpha.workspace.id);

      const response = await t.call(entry, "alpha", t.alpha.ids);
      const text = await response.text();

      if (RANK[role] < RANK[entry.minRole]) {
        expect(response.status, text).toBe(403);
        expect(JSON.parse(text)).toEqual({ error: "forbidden" });
        expect(await t.rowsOf(t.alpha.workspace.id)).toEqual(before);
      } else {
        expect(response.status, text).not.toBe(403);
        expect(response.status, text).not.toBe(401);
        expect(text).not.toContain('"error":"forbidden"');
      }
    },
  );
});

describe("the table of routes", () => {
  // #101-WM-07
  it("holds every method of every data route of a workspace", async () => {
    const files = discoverRoutes().filter(
      ({ route, file }) =>
        route.startsWith("/api/w/") && /route\.ts$/.test(file),
    );
    const known = new Set(
      ENTRIES.map((entry) => `${entry.method} ${entry.route}`),
    );
    const found: string[] = [];
    for (const { route, file } of files) {
      const routeModule = (await import(file)) as Record<string, unknown>;
      for (const method of Object.keys(routeModule))
        if (/^[A-Z]+$/.test(method)) found.push(`${method} ${route}`);
    }

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) expect(known, row).toContain(row);
    expect([...known].sort()).toEqual([...new Set(found)].sort());
  });
});
