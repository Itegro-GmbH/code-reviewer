// SPDX-License-Identifier: LicenseRef-Proprietary

// What `/proc/self/mountinfo` of a VM would say after the mounts the Sandbox-Launcher asked for (#760), for the doubles
// of the Sandbox platform: they run no mount, so the file is derived from the commands they were given. Only the
// two forms the Launcher uses are understood: `mount --bind <dir> <dir>` adds a mount of the plain options, and
// `mount -o remount,bind,<options> <dir>` sets the options of that mount. Anything else changes nothing. Test use only.

type Command = { cmd: string; args: readonly string[] };

/** The text of a mountinfo with the root mount and one line per bind mount made by the commands, in order. */
export function mountinfoAfter(commands: readonly Command[]): string {
  const mounts = new Map<string, string>();
  for (const { cmd, args } of commands) {
    if (cmd !== "mount") continue;
    if (args[0] === "--bind" && args[1] !== undefined && args[1] === args[2]) {
      mounts.set(args[1], "rw,relatime");
      continue;
    }
    const remount = args[0] === "-o" ? args[1] : undefined;
    const directory = args[2];
    if (
      remount?.startsWith("remount,bind,") === true &&
      directory !== undefined &&
      mounts.has(directory)
    )
      mounts.set(
        directory,
        `${remount.slice("remount,bind,".length)},relatime`,
      );
  }
  const lines = ["22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw"];
  let id = 100;
  for (const [directory, options] of mounts) {
    lines.push(
      `${id} 22 8:1 ${directory} ${directory} ${options} shared:1 - ext4 /dev/sda1 rw`,
    );
    id += 1;
  }
  return `${lines.join("\n")}\n`;
}
