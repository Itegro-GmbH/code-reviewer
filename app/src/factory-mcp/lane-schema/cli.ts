// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm lane-guide:generate` writes `guide.generated.json`; `--check` fails when the committed copy is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATED_FILE,
  generateGuideData,
  renderGuideData,
} from "./generate.ts";

const here = import.meta.dirname;
const root = join(here, "..", "..", "..", "..");
const target = join(here, GENERATED_FILE);
const rendered = renderGuideData(generateGuideData(root));

if (process.argv.includes("--check")) {
  const committed = readFileSync(target, "utf8");
  if (committed !== rendered) {
    console.error(
      `${GENERATED_FILE} is out of date: run pnpm lane-guide:generate.`,
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, rendered);
}
