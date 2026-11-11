// SPDX-License-Identifier: LicenseRef-Proprietary

// Writes the Control template (local-control-template.ts) to the standard output.
import { controlTemplateDocument } from "./local-control-template.ts";

process.stdout.write(await controlTemplateDocument());
