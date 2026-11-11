# Where the licence texts of the program tarball come from

Each file here is a byte-for-byte copy out of an archive, checked against `SHA256SUMS` by `runner/release/build_program.py` (a changed, a missing or an unlisted file stops the build) and shipped in the
tarball as `share/licenses/third-party/<path>`. Nothing was typed from memory.

## `python/`

The standalone CPython of `runner/release/pins.env` (python-build-standalone release 20260610, 3.13.14, `install_only_stripped`) is an archive of the interpreter only: it has no licence files of the
libraries it is built with. The same release publishes the full archive of the same build, which does:

- `cpython-3.13.14+20260610-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst`, sha256 `1c4e8ac4d6a039ca7bf0942819578f31ba3528be84d5c3c47f1bf8e638e8086a` (the publisher's `SHA256SUMS` of the release),
  directory `python/licenses/`, and `python/PYTHON.json`, which names, for every extension module, the licence texts that apply.

Copied: the texts that `PYTHON.json` names for the extension modules that stay in the program (`_bz2`, `_ctypes`, `_curses`, `_dbm`, `_decimal`, `_elementtree`, `pyexpat`, `_hashlib`, `_ssl`, `_lzma`, `_sqlite3`,
`_uuid`, `readline`, `zlib`) and the one of CPython itself. Not copied: libX11, libXau, libxcb, Tcl and Tix, which belong to `_tkinter`, and `build_program.py` takes `_tkinter` and Tcl/Tk out.
(`PYTHON.json` also names `LICENSE.zlib-ng.txt`, which this build's archive does not contain.)

## `openssl-4.0.3/`

The `cryptography` wheel of `runner/uv.lock` links OpenSSL statically and carries no OpenSSL licence text. Its own SBOM (`cryptography-50.0.2.dist-info/sboms/sbom.json` inside the wheel) names the version and the
source archive:

- `https://github.com/openssl/openssl/releases/download/openssl-4.0.3/openssl-4.0.3.tar.gz`, sha256 `325b5c806167c13b40b1ffeadfe0248197c00eccc4cf123ec1e28d2d2fd216d9` (the SBOM's checksum; the downloaded
  archive has it), file `openssl-4.0.3/LICENSE.txt`.

The licence files of `cryptography` itself (`LICENSE`, `LICENSE.APACHE`, `LICENSE.BSD`), `cffi` and `pycparser` are in the `.dist-info` directories of the wheels, which the tarball keeps.

To renew a text: take it from the archive named above (a new pin names a new archive; record it here), then regenerate `SHA256SUMS` (`cd runner/release/licenses && find python openssl-* -type f | LC_ALL=C sort | xargs sha256sum > SHA256SUMS`).
