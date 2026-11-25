// SPDX-License-Identifier: LicenseRef-Proprietary

// Slice #1146 (run control, ToDos and tickets): start_run, list_runs, get_run, get_step, get_step_log, list_run_mcp_calls, answer_run,
// pause_run, resume_run, cancel_run, discard_run, wait_for_run, list_todos, resolve_todo, list_issues, sync_issues, list_pull_requests,
// list_reviews. Each tool is a file of its own below `../runs/` and `../todos/`; this file only lists them, and no other slice edits it.
import type { FactoryTool } from "../define.ts";
import { answerRun } from "../runs/answer-run.ts";
import { cancelRun } from "../runs/cancel-run.ts";
import { discardRun } from "../runs/discard-run.ts";
import { getRun } from "../runs/get-run.ts";
import { getStep } from "../runs/get-step.ts";
import { getStepLog } from "../runs/get-step-log.ts";
import { listRunMcpCalls } from "../runs/list-run-mcp-calls.ts";
import { listRuns } from "../runs/list-runs.ts";
import { pauseRun } from "../runs/pause-run.ts";
import { resumeRun } from "../runs/resume-run.ts";
import { startRun } from "../runs/start-run.ts";
import { waitForRun } from "../runs/wait-for-run.ts";

export const runAndTodoTools: readonly FactoryTool[] = [
  startRun,
  listRuns,
  getRun,
  waitForRun,
  getStep,
  getStepLog,
  listRunMcpCalls,
  answerRun,
  pauseRun,
  resumeRun,
  cancelRun,
  discardRun,
];
