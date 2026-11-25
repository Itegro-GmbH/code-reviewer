// SPDX-License-Identifier: LicenseRef-Proprietary

// What the project tools share (#1145).
import { z } from "zod";
import type {
  ProjectListEntry,
  StoredProject,
} from "../../../db/repositories/projects-repository.ts";

export const projectIdArg = z
  .string()
  .min(1)
  .max(128)
  .describe("The id of the project, as `list_projects` shows it.");

/** A project as the tools answer it: its ids and ticket source, without the review settings (not what an AI controls the factory by). */
export function projectView(project: StoredProject) {
  return {
    id: project.id,
    repositoryId: project.repositoryId,
    active: project.active,
    ticketSource: project.ticketSource,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function repositoryView(entry: ProjectListEntry) {
  return {
    id: entry.repository.id,
    fullName: entry.repository.fullName,
    url: entry.repository.url,
    available: entry.repository.available,
    integration: {
      type: entry.repository.integration.type,
      status: entry.repository.integration.status,
    },
  };
}
