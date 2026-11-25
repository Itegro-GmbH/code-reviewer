// SPDX-License-Identifier: LicenseRef-Proprietary

// What the runner that holds a job announces now (#1150): the entries of its manifest a job may use (`customerAccess`, never `managed`). The fetch of
// a Worker asks it to tell whether the claim chose the runner's own login or the token of the workspace for a turn on `claude-code`, so that it holds
// the Worker to what the claim chose. The runner is looked up in the job's own workspace, by the id the claim wrote into the job (`runner:<id>`).
import type { Job } from "../jobs/job-types.ts";
import {
  customerAccess,
  type HarnessAccess,
} from "../runner-identity/access.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";

type Runners = {
  list(): Promise<
    readonly { id: string; manifest: { harnesses: HarnessAccess[] } }[]
  >;
};

export async function runnerAccessOf(
  runners: (workspaceId: string) => Runners,
  job: Pick<Job, "workspaceId" | "runnerId">,
): Promise<readonly HarnessAccess[]> {
  const prefix = customerRunnerId("");
  if (job.runnerId === null || !job.runnerId.startsWith(prefix)) return [];
  const id = job.runnerId.slice(prefix.length);
  const found = (await runners(job.workspaceId).list()).find(
    (runner) => runner.id === id,
  );
  return found === undefined ? [] : customerAccess(found.manifest.harnesses);
}
