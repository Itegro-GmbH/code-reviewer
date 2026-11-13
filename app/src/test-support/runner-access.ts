// SPDX-License-Identifier: LicenseRef-Proprietary

// The entries a test runner announces (#973), so a test of the claim names what its runner can run in one place.
import type { HarnessAccess } from "../runner-identity/access.ts";

/** A runner with the base alone: OpenCode on a key of the app. */
export const OPENCODE_ACCESS: readonly HarnessAccess[] = [
  { harness: "opencode", version: "1.19.0", auth: "app-key" },
];

/** A runner that also has a Claude Code login on its device (any model). */
export const CLAUDE_CODE_ACCESS: readonly HarnessAccess[] = [
  ...OPENCODE_ACCESS,
  { harness: "claude-code", version: "2.1.311", auth: "subscription" },
];
