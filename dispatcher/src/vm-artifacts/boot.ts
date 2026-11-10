// SPDX-License-Identifier: LicenseRef-Proprietary

// How a Firecracker microVM is started from the release's artifacts (#976): the kernel command line and the machine configuration. The build
// and the smoke boot in CI use it (boot-main.ts); the launcher of the local Dispatcher (#978) starts a job's VM the same way, with the
// boot arguments and the init command the release's manifest carries (`kernel.bootArgs`, `kernel.initCommand`).

/**
 * The command line of a release, without a console: the root file system is the first drive, read-only; the guest reboots itself to end
 * (`reboot=k` makes Firecracker exit); PCI is off (Firecracker's devices are on virtio-mmio); `8250.nr_uarts=0` and `quiet` give the
 * guest no serial console, which it does not read and which costs 0.3 to 0.4 s of every boot (measured in the spike #970).
 */
export const RELEASE_BOOT_ARGS =
  "reboot=k panic=1 pci=off i8042.noaux i8042.nokbd cgroup_no_v1=all root=/dev/vda ro rootfstype=ext4 8250.nr_uarts=0 quiet loglevel=0";
/**
 * PID 1 and what it runs. `docker-init` is tini, from the root file system: it reaps, `vm-boot` (docker/vm/rootfs/vm-boot) prepares the guest
 * (mounts, the job disk, the cgroup controllers, the network) and then, by `vm.mode`, starts vm-init (`run`: a job's VM) or hands over to
 * `vm-build-init` (`seed`, `smoke`: the build-only boots).
 */
export const RELEASE_INIT_COMMAND =
  "/usr/bin/docker-init -- /usr/local/sbin/vm-boot";

export type BootMode = "run" | "seed" | "smoke";

export type BootSpec = {
  kernelPath: string;
  rootfsPath: string;
  /** The job disk: Docker's, containerd's and Sysbox's state. Writable. */
  dataDiskPath: string;
  /** The image archive of the build (mode `seed`). Read-only. */
  seedDiskPath?: string;
  mode: BootMode;
  vcpus: number;
  memMib: number;
  /** A serial console, for the build and the smoke boot, which read the guest's events from it. A job's VM has none. */
  console: boolean;
};

export function kernelCommandLine(spec: BootSpec): string {
  const [init, ...rest] = RELEASE_INIT_COMMAND.split(" -- ");
  const args = spec.console
    ? RELEASE_BOOT_ARGS.replace(" 8250.nr_uarts=0 quiet loglevel=0", "").concat(
        " console=ttyS0 8250.nr_uarts=1",
      )
    : RELEASE_BOOT_ARGS;
  return `${args} vm.mode=${spec.mode} init=${init} -- ${rest.join(" -- ")}`;
}

type Drive = {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
};

export type FirecrackerConfig = {
  "boot-source": { kernel_image_path: string; boot_args: string };
  drives: Drive[];
  "network-interfaces": never[];
  "machine-config": { vcpu_count: number; mem_size_mib: number; smt: boolean };
};

/** The VM has no network and no vsock here: the build and the smoke boot need neither. Drives: root (ro), data (rw), seed (ro). */
export function firecrackerConfig(spec: BootSpec): FirecrackerConfig {
  const drives: Drive[] = [
    {
      drive_id: "rootfs",
      path_on_host: spec.rootfsPath,
      is_root_device: true,
      is_read_only: true,
    },
    {
      drive_id: "data",
      path_on_host: spec.dataDiskPath,
      is_root_device: false,
      is_read_only: false,
    },
  ];
  if (spec.seedDiskPath !== undefined)
    drives.push({
      drive_id: "seed",
      path_on_host: spec.seedDiskPath,
      is_root_device: false,
      is_read_only: true,
    });
  return {
    "boot-source": {
      kernel_image_path: spec.kernelPath,
      boot_args: kernelCommandLine(spec),
    },
    drives,
    "network-interfaces": [],
    "machine-config": {
      vcpu_count: spec.vcpus,
      mem_size_mib: spec.memMib,
      smt: false,
    },
  };
}
