// SPDX-License-Identifier: LicenseRef-Proprietary

// `node compare-main.ts --record <golden-record.json> --manifest <manifest.json> [--require-images]`: the version check of #976-T02 between the
// hosted golden snapshot (its pins and its record, the artifact `golden-snapshot-record` of the Golden snapshot workflow) and a build of the
// local VM artifacts. Exit status: 0 they agree, 1 they differ (each difference on stderr), 2 wrong use.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG } from "../snapshot/config.ts";
import { GoldenRecordSchema } from "../snapshot/record.ts";
import { compareWithHosted } from "./compare.ts";
import { parseManifest } from "./verify.ts";

const { values } = parseArgs({
  options: {
    record: { type: "string" },
    manifest: { type: "string" },
    "require-images": { type: "boolean", default: false },
  },
});
if (!values.record || !values.manifest) {
  console.error("compare-main: --record and --manifest are required");
  process.exit(2);
}
const record = GoldenRecordSchema.parse(
  JSON.parse(readFileSync(values.record, "utf8")),
);
const manifest = parseManifest(readFileSync(values.manifest));
const result = compareWithHosted(
  { config: DEFAULT_CONFIG, record },
  {
    dockerd: manifest.components.dockerd,
    buildx: manifest.components.buildx,
    sysbox: manifest.components.sysbox,
    sysboxSha256: manifest.components.sysboxSha256,
    images: manifest.images,
  },
  { requireImages: values["require-images"] },
);
for (const d of result.differences)
  console.error(`DIFFERENT ${d.field}: hosted ${d.hosted}, local ${d.local}`);
for (const d of result.imageDifferences)
  if (!result.differences.some((x) => x.field === d.field))
    console.error(
      `note: image ${d.field} differs (hosted ${d.hosted}, local ${d.local}); not counted without --require-images`,
    );
console.log(result.ok ? "same recipe" : "the recipes differ");
process.exit(result.ok ? 0 : 1);
