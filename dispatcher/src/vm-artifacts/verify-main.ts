// SPDX-License-Identifier: LicenseRef-Proprietary

// `node verify-main.ts --dir <dir> --manifest <manifest.json> --signature <manifest.sig> (--public-key <b64> | --channel <release-channel.json>) [--min-release N]`
// checks a release of the VM artifacts (#976): the signature, then every file. The install and update of the local Dispatcher (#982) use
// the same `verifyArtifacts`. Exit status: 0 verified, 1 the check failed (the code is on stderr), 2 wrong use.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { VmArtifactsError, verifyArtifacts } from "./verify.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    manifest: { type: "string" },
    signature: { type: "string" },
    "public-key": { type: "string" },
    channel: { type: "string" },
    "min-release": { type: "string" },
  },
});
function usage(message: string): never {
  console.error(`verify-main: ${message}`);
  process.exit(2);
}
if (!values.dir || !values.manifest || !values.signature)
  usage("--dir, --manifest and --signature are required");
const publicKey =
  values["public-key"] ??
  (values.channel
    ? (
        JSON.parse(readFileSync(values.channel, "utf8")) as {
          publicKey?: string;
        }
      ).publicKey
    : undefined);
if (publicKey === undefined) usage("--public-key or --channel is required");

try {
  const manifest = await verifyArtifacts({
    dir: values.dir,
    manifest: readFileSync(values.manifest),
    signature: readFileSync(values.signature),
    publicKey,
    ...(values["min-release"] === undefined
      ? {}
      : { minRelease: Number(values["min-release"]) }),
  });
  console.log(
    `verified release ${manifest.release} (${Object.keys(manifest.files).length} files)`,
  );
} catch (error) {
  if (!(error instanceof VmArtifactsError)) throw error;
  console.error(`verify-main: ${error.message}`);
  process.exit(1);
}
