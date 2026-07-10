## Install the toolchain

LVGL Live Preview installs and uses its **own bundled copy** of the Emscripten toolchain,
kept in the extension's storage. A system-wide `emcc` on your `PATH` is **not** used — so
even if you already have Emscripten installed, the extension still needs its own copy.

- One-time download and install (~1–2 GB)
- Requires **Python 3** on your `PATH`
- Pinned to a specific, tested version for reproducible builds

The installation shows progress and can be canceled. If it's already installed, this does
nothing (you'll be offered a reinstall).
