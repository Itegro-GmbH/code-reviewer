// SPDX-License-Identifier: LicenseRef-Proprietary

// `node recipe-main.ts <dir>`: writes the golden snapshot's install scripts and pins for the local root file system build (docker/vm/rootfs/build.sh).
import { writeRecipe } from "./recipe.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: recipe-main.ts <dir>");
  process.exit(2);
}
writeRecipe(dir);
console.error(`recipe-main: wrote the recipe to ${dir}`);
