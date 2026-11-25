// SPDX-License-Identifier: LicenseRef-Proprietary

// The `vercel` entry: Vercel builds a Hono app from a default export of this file with no further
// configuration. The Launcher is the Sandbox-Launcher (#329) when a golden snapshot is configured
// (SANDBOX_SNAPSHOT_ID, see launchers/sandbox-env.ts); without one it is `noLauncher`, which advertises no
// engine, so every wake-up call is ignored. The Sandbox SDK is loaded on the first job, not at start. This file
// and what it imports must never reach `node:child_process` (the Node entry, node.ts, is a separate file for
// that reason; see src/bundle/serverless-bundle.test.ts). With a snapshot the reaper's cron route (#364) is mounted too.
//
// Why this file imports Hono, and why no other file named app, index or server does (#416): the Hono builder of the
// Vercel CLI takes as the function's entry the first of app, index and server (in the project root, then in src/) whose
// text imports "hono". The type import below is what makes this file qualify; a file such as the former src/app.ts,
// which imports Hono and default-exports no app, would be taken instead and the function would die on its first request.
// src/vercel-config.test.ts holds the rule, and CI starts the built function (scripts/check-built-function.mjs).
import { waitUntil } from "@vercel/functions";
import type { Hono } from "hono";
import { composeDispatcher } from "./compose.ts";
import { sandboxFromEnvironment } from "./launchers/sandbox-env.ts";

const sandbox = sandboxFromEnvironment(
  process.env,
  () => import("@vercel/sandbox"),
);

const { app } = composeDispatcher({
  env: process.env,
  launcher: sandbox.launcher,
  secrets: sandbox.secrets,
  reaper: sandbox.reaper,
  ...(sandbox.claimFeatures === undefined
    ? {}
    : { claimFeatures: sandbox.claimFeatures }),
  background: (work) => waitUntil(work),
});

export default app satisfies Hono;
