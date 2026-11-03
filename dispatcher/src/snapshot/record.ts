// SPDX-License-Identifier: LicenseRef-Proprietary

// The record a successful run leaves: what the Dispatcher is configured with (#330). Nothing in it is secret.
import { z } from "zod";

export const GoldenRecordSchema = z.strictObject({
  version: z.literal(1),
  /** The snapshot the Sandbox-Launcher (#329) creates job VMs from. */
  snapshotId: z.string().min(3).max(128),
  /** The id of the Worker image inside the snapshot: the Launcher compares it with `docker image inspect`. */
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The id of the Implementer's agent image inside the snapshot (plan implementer-sandbox, step 4); older records have none. */
  agentImageDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  builtAt: z.iso.datetime(),
  region: z.literal("fra1"),
  target: z.string(),
  commit: z.string().optional(),
  /**
   * Whether Sysbox is installed in the snapshot and its proof (a container that runs its own Docker, on a network with no
   * exit) passed in the check VM. `unproven` is not a failure of the snapshot: reviews do not use Sysbox, so a snapshot
   * whose Sysbox is broken still goes live and the Implementer's own boot step names the problem.
   */
  sysbox: z.enum(["proven", "unproven"]).optional(),
});
export type GoldenRecord = z.infer<typeof GoldenRecordSchema>;
