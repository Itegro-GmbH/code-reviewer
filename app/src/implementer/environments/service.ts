// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the environments page and the form's picker (#818): list, read, create, change and delete the environments
// of ONE workspace. Who may do what is the route's (`withWorkspace` with a right of the matrix); every rule about the data is
// here. An environment is a start configuration: nothing points at it from a task (a task copies size and script when it
// starts), so changing or deleting one touches no turn.
import type {
  ImplementerEnvironmentsRepository,
  StoredEnvironment,
} from "../../db/repositories/implementer-environments-repository.ts";
import { EnvironmentError } from "./errors.ts";
import { validateEnvironmentInput } from "./input.ts";
import { ENVIRONMENTS_PER_WORKSPACE_MAX, memoryGbOf } from "./limits.ts";

/** An environment as the page and the picker see it. The script is shown to every member: they can use it. */
export type EnvironmentView = {
  id: string;
  name: string;
  vcpus: number;
  memoryGb: number;
  setupScript: string;
  createdAt: string;
  updatedAt: string;
};

export type EnvironmentList = {
  environments: EnvironmentView[];
  /** How many environments the workspace may hold. */
  maximum: number;
};

/** An environment as the form's picker needs it: no script, only whether there is one. */
export type EnvironmentPickerView = {
  id: string;
  name: string;
  vcpus: number;
  memoryGb: number;
  hasScript: boolean;
};

export type EnvironmentPickerList = {
  environments: EnvironmentPickerView[];
  maximum: number;
};

export type EnvironmentService = {
  list(): Promise<EnvironmentList>;
  /** The list for the picker of the task form: the scripts (up to 64 KB each, 50 of them) are not read, not sent. */
  listForPicker(): Promise<EnvironmentPickerList>;
  get(id: string): Promise<EnvironmentView>;
  create(user: { id: string }, body: unknown): Promise<EnvironmentView>;
  update(id: string, body: unknown): Promise<EnvironmentView>;
  remove(id: string): Promise<void>;
};

const ID_MAX_LENGTH = 128;

function viewOf(environment: StoredEnvironment): EnvironmentView {
  return {
    id: environment.id,
    name: environment.name,
    vcpus: environment.vcpus,
    memoryGb: memoryGbOf(environment.vcpus),
    setupScript: environment.setupScript,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

function notFound(): EnvironmentError {
  return new EnvironmentError(
    "ENVIRONMENT_NOT_FOUND",
    "There is no such environment in this workspace.",
  );
}

/** An id the database is not asked about: not text of a sane length, or with a NUL byte (Postgres refuses it as an error). */
function isUsableId(id: string): boolean {
  return id.length > 0 && id.length <= ID_MAX_LENGTH && !id.includes("\u0000");
}

function checked(body: unknown) {
  const input = validateEnvironmentInput(body);
  if (!input.ok)
    throw new EnvironmentError(
      "ENVIRONMENT_REQUEST_INVALID",
      "The environment is not valid.",
      { issues: input.issues },
    );
  return input.value;
}

function nameTaken(): EnvironmentError {
  return new EnvironmentError(
    "ENVIRONMENT_NAME_TAKEN",
    "The workspace has an environment with this name.",
  );
}

export function createEnvironmentService({
  environments,
}: {
  environments: ImplementerEnvironmentsRepository;
}): EnvironmentService {
  return {
    async list() {
      return {
        environments: (await environments.list()).map(viewOf),
        maximum: ENVIRONMENTS_PER_WORKSPACE_MAX,
      };
    },

    async listForPicker() {
      return {
        environments: (await environments.listSummaries()).map((summary) => ({
          ...summary,
          memoryGb: memoryGbOf(summary.vcpus),
        })),
        maximum: ENVIRONMENTS_PER_WORKSPACE_MAX,
      };
    },

    async get(id) {
      if (!isUsableId(id)) throw notFound();
      const environment = await environments.get(id);
      if (environment === undefined) throw notFound();
      return viewOf(environment);
    },

    async create(user, body) {
      const input = checked(body);
      const outcome = await environments.create(
        { ...input, createdBy: user.id },
        ENVIRONMENTS_PER_WORKSPACE_MAX,
      );
      if (outcome.ok) return viewOf(outcome.environment);
      if (outcome.reason === "name_taken") throw nameTaken();
      throw new EnvironmentError(
        "ENVIRONMENT_LIMIT_REACHED",
        "The workspace holds the most environments it may.",
        { maximum: ENVIRONMENTS_PER_WORKSPACE_MAX },
      );
    },

    async update(id, body) {
      const input = checked(body);
      if (!isUsableId(id)) throw notFound();
      const outcome = await environments.update(id, input);
      if (outcome.ok) return viewOf(outcome.environment);
      if (outcome.reason === "name_taken") throw nameTaken();
      throw notFound();
    },

    async remove(id) {
      if (!isUsableId(id)) throw notFound();
      if (!(await environments.remove(id))) throw notFound();
    },
  };
}
