# SPDX-License-Identifier: LicenseRef-Proprietary

"""vm-init (#977, epic #969, ADR 0005): the program in a Firecracker VM's root file system that does
what the Vercel Sandbox API does hosted: it takes the start (the job's credential) over vsock,
prepares
the VM, runs the Control container and reports how it ended. See `runner/vm-init/README.md`.

Standard library only; modules import each other relatively, so the package runs from here and,
copied
as `vm_init`, from a zipapp in the root file system."""
