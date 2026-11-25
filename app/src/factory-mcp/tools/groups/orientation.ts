// SPDX-License-Identifier: LicenseRef-Proprietary

// The orientation tools (#1144): who am I, what is this factory, how is a lane written.
import type { FactoryTool } from "../define.ts";
import { describeFactory } from "../orientation/describe-factory.ts";
import { getLaneSchema } from "../orientation/get-lane-schema.ts";
import { whoami } from "../orientation/whoami.ts";

export const orientationTools: readonly FactoryTool[] = [
  whoami,
  describeFactory,
  getLaneSchema,
];
