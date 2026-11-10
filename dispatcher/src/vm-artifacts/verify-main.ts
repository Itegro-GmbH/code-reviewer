// SPDX-License-Identifier: LicenseRef-Proprietary

// `node verify-main.ts --dir <dir> --manifest <manifest.json> --signature <manifest.sig> (--public-key <b64> | --channel <release-channel.json>)
// [--min-release N] [--exact-dir]` checks a release of the VM artifacts (#976): the signature, then every file. N is a whole number and the release
// must be HIGHER than it (the release in use, or the last one published). --exact-dir refuses anything in --dir that the manifest does not name,
// besides the manifest and the signature file when they are in it. The install and update of the local Dispatcher (#982) use
// the same `verifyArtifacts`. Exit status: 0 verified, 1 the check failed (the code is on stderr), 2 wrong use.
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VmArtifactsError, verifyArtifacts } from "./verify.ts";

function usage(message: string): never {
  console.error(`verify-main: ${message}`);
  process.exit(2);
}

function parse() {
  try {
    return parseArgs({
      options: {
        dir: { type: "string" },
        manifest: { type: "string" },
        signature: { type: "string" },
        "public-key": { type: "string" },
        channel: { type: "string" },
        "min-release": { type: "string" },
        "exact-dir": { type: "boolean" },
      },
    }).values;
  } catch (error) {
    // An argument that is no option (`--min-release -1` reads "-1" as one) is wrong use, not a crash.
    return usage(error instanceof Error ? error.message : "wrong arguments");
  }
}
const values = parse();
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
// Number("abc") is NaN, and a release is never "not newer" than NaN: a mistyped number must stop the run, not switch the check off.
if (
  values["min-release"] !== undefined &&
  !/^(0|[1-9][0-9]{0,15})$/.test(values["min-release"])
)
  usage("--min-release must be a whole number (0 or more)");
// The manifest and the signature are what came with the release: they may be in the directory next to its files.
const alsoAllowed = [values.manifest, values.signature]
  .filter((file) => resolve(dirname(file)) === resolve(values.dir ?? ""))
  .map((file) => basename(file));

try {
  const manifest = await verifyArtifacts({
    dir: values.dir,
    manifest: readFileSync(values.manifest),
    signature: readFileSync(values.signature),
    publicKey,
    ...(values["min-release"] === undefined
      ? {}
      : { minRelease: Number(values["min-release"]) }),
    ...(values["exact-dir"] ? { exactDir: alsoAllowed } : {}),
  });
  console.log(
    `verified release ${manifest.release} (${Object.keys(manifest.files).length} files)`,
  );
} catch (error) {
  if (!(error instanceof VmArtifactsError)) throw error;
  console.error(`verify-main: ${error.message}`);
  process.exit(1);
}
