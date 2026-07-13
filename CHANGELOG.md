# Changelog

All notable changes to the LVGL Live Preview extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-07-13

### Added
- Automatic project detection: a `.lvgl-live-preview.json` file is no longer required for multi-file projects. When none is present, the extension finds the source that defines `lvgl_live_preview_init()` (the file you start the preview from, or, if that file doesn't define it, the single source in the workspace that does) and resolves its dependencies by following the local `#include "…"` graph — each quoted header's directory becomes an include path and a sibling source of the same basename (`foo.h` → `foo.c`/`foo.cpp`) is compiled as a dependency. Angle-bracket includes (LVGL, the standard library, SDL) are ignored. Detected dependencies are cached and watched for hot reload just like an explicit config. A `.lvgl-live-preview.json` still takes precedence when present, for projects that need custom `defines`, include paths not reachable through the include graph, or dependencies whose source basename differs from their header.

### Fixed
- A dependency source that fails to compile is now reported as a build failure instead of being silently dropped. Previously a broken helper file (syntax error, `#error`, missing header, etc.) was swallowed into the output channel, and the preview either linked without it or failed later with a confusing "undefined symbol" error. The compiler diagnostics now appear in the Problems panel on the offending file and in the preview's error card, the same as an error in the main file.
- Fixed an index-misalignment bug that could cache a compiled object under the wrong source file (and thus reuse a stale object on later builds) when an earlier dependency in the list failed to compile.
- Fixed the preview getting stuck on the loading spinner after being covered by another window and brought back. The preview panel now stays alive while hidden (so covering it no longer tears it down), and if the webview does reload for any reason (window reload, moving the tab to another editor group, host restart) it now restores what it was showing instead of hanging on the loading screen.

### Updated
- Updated the settings panel to stay open when the user clicks outside the settings panel. This prevents unwanted closing of the settings panel.

## [2.0.1] - 2026-07-12

### Fixed
- Improved the visual quality of the scaled preview when "Scale preview to fit the window" is enabled. The preview canvas previously always used nearest-neighbor scaling, which looked grainy when the preview was downscaled or upscaled by a non-integer factor (and worse the more it was scaled). Scaling now selects the filter based on the effective on-screen (physical-pixel) scale: it keeps crisp nearest-neighbor for exact integer upscales and uses smooth interpolation everywhere else, so downscaled and fractionally-scaled previews are no longer grainy
- The preview now reapplies scaling when the display's device pixel ratio changes (for example, dragging the window between a Retina and non-Retina monitor, or changing OS display zoom), so the fit and interpolation filter stay correct

## [2.0.0] - 2026-07-10

### Added
- Added C++ support: the preview now accepts C++ entry points (`.cpp`/`.cc`/`.cxx`/`.c++`) in addition to C, so a C++ "glue" layer can initialize a C LVGL UI. Mixed C/C++ projects build with no extra configuration — Emscripten selects each file's language by extension and links the C++ standard library on demand. In a C++ entry point, declare `lvgl_live_preview_init` as `extern "C"`.
- Added an "LVGL: Open C++ Sample File" command with a ready-to-run example
- Added an in-preview settings panel: a gear button in the top-right corner of the preview window opens a panel for editing all settings without leaving the preview
- Added an "LVGL Runtime" output channel that shows the previewed app's runtime output (`printf` and `LV_LOG_*` messages) directly in VS Code, instead of only in the webview developer tools console. The channel reveals itself on the first log of each preview session
- Added a "Rotate" toolbar button that toggles the preview orientation by swapping the display width and height for the current session. The swap is temporary — it does not change your saved settings and resets to the saved orientation when a new preview session starts
- Added a "Stop" button to the preview window toolbar that stops the live preview and closes the preview window
- Added a "Reset Cache" button to the settings panel that clears the compiled LVGL cache and rebuilds the preview (equivalent to the "LVGL: Force Rebuild" command)
- Added a "Reset to Defaults" button to the settings panel that restores all settings to their defaults (after a confirmation prompt)
- Added a "Scale preview to fit the window" setting (enabled by default) that scales the preview to fit the available area while keeping its aspect ratio — scaling down in a small window and up in a large one. It updates live as the window is resized
- Added an "LVGL: Check Setup" command that diagnoses the environment (Python, Emscripten toolchain, free disk space, and network) and reports exactly what is missing
- Added an "LVGL: Reinstall Emscripten Toolchain" command that deletes and cleanly re-installs the toolchain (useful after a failed or partial install)
- Added an "LVGL: Install Emscripten Toolchain" command to install the bundled toolchain directly. "Check Setup" now offers an "Install Emscripten" action when it is missing, and the walkthrough has a dedicated installation step — clarifying that the extension uses its own bundled copy rather than a system-wide `emcc`
- Added a "Get Started with LVGL Live Preview" walkthrough (shown on the VS Code Welcome page and opened on the first run) that guides you through checking your setup, opening a sample, and starting your first preview
- Added an "LVGL: Open Get Started Walkthrough" command to reopen the walkthrough at any time
- Added an "LVGL: Open Sample File" command that opens a ready-to-run example

### Changed
- The LVGL status bar item now appears only when a C file is the active editor or a preview is running, instead of always being shown
- The Emscripten toolchain version (3.1.50) is now pinned explicitly in code rather than relying on the emsdk installer's `latest` alias, so the installed version stays fixed even if the bundled emsdk release is bumped later
- The toolchain installation is now cancellable and cleans up partial installations on cancellation or failure, so a retry always starts from a clean state
- The first build now shows progress while the SDL2 port downloads/compiles (a one-time step that previously looked like a hang), and the install prompt now states the real ~1–2 GB toolchain size and Python requirement
- **BREAKING:** Settings are now owned entirely by the preview and stored by the extension; they no longer appear in the VS Code Settings UI, and `lvglPreview.*` entries in your VS Code `settings.json` (including committed workspace settings) are no longer read after the first run. Your existing settings are not lost — any `lvglPreview.*` values are migrated automatically into the extension's own storage the first time the preview runs, so previous configurations carry over. Adjust settings afterward from the in-preview settings panel (the gear button in the preview window)
- The preview rebuilds/reloads only when settings are saved and only once per save regardless of how many fields were edited. Closing the popup without saving will keep the old settings.
- Removed the per-field reload that occurred when editing settings through the VS Code Settings UI

### Performance
- Settings changes now rebuild only what is actually affected instead of always rebuilding the whole LVGL library. Changing the display dimensions or WASM memory size now only relinks (the LVGL library is reused); changing the LVGL version, optimization level, or LVGL heap size rebuilds the library, but the result is cached, so switching values back is instant
- Saving settings no longer clears the entire build cache; the LVGL library and dependency caches self-invalidate based on the settings that actually affect their output (use "LVGL: Force Rebuild" for a full clean rebuild)

### Fixed
- Fixed the walkthrough's sample file failing to compile ("No such file or directory") because it opened as an unsaved, untitled document. The sample is now written to a real file on disk. Starting a preview on an untitled file now shows a clear "save first" message, and unsaved edits are saved before building
- Fixed `lvglMemorySize` and `wasmMemorySize` changes not triggering a rebuild of the running preview
- Fixed keyboard entry being blocked in the settings panel by scoping SDL's keyboard capture to the preview canvas

### Security
- Updated dependencies of the project to resolve security vulnerabilities as reported by npm audit

## [1.1.2] - 2026-02-01

### Fixed
- Fixed the issue where large LVGL apps would crash due to running out of allocated memory

### Added
- Added settings to configure LVGL and WASM memory allocation

### Updated
- Updated eslint dependencies and supporting configuration files to fix security vulnerabilities

## [1.1.1] - 2026-01-11

### Added
- Added Python detection before Emscripten SDK installation
- Added clear error messages when Python is not installed or not in PATH
- Added a "Download Python" button in the error dialog for quick access to Python downloads
- Added proper error detection for SSL certificate failures with instructions to fix Python certificates
- Added windows-long path support detection with instructions for enabling it when path-too-long errors occur (including WinError 3 detection)

### Fixed
- Fixed silent installation failures during Emscripten installation
- Fixed the false "installation successful" message when Emscripten SDK installation actually fails
- Fixed the issue where multiple watch windows would be created if Live Preview was started multiple times
- Fixed performance issues with the Live Preview (moved to using LVGL's SDL support)

### Removed
- Removed the custom SDL2 implementation in favor of LVGL's SDL support

## [1.1.0] - 2026-01-08

### Added
- Multi-file project support with `.lvgl-live-preview.json` configuration
- Dependency management system for compiling multiple C files together
- Smart caching for dependency object files with incremental compilation
- Custom preprocessor defines support via configuration file
- Multi-file watching: all source files are monitored for changes
- Automatic detection of file modifications with hash-based validation

### Changed
- Updated compilation workflow to support both single-file and multi-file modes
- Enhanced file watcher to monitor multiple files simultaneously
- Improved logging for dependency compilation status

### Technical Details
- New `ConfigLoader` utility for parsing `.lvgl-live-preview.json`
- New `DependencyCache` class for managing `.o` file caching
- Extended `EmccWrapper` to support custom defines and dependency objects
- Enhanced `CompilationManager` with dependency compilation pipeline
- Updated `PreviewManager` to watch all project source files

## [1.0.2] - 2026-01-04

### Added
- Added LVGL_LIVE_PREVIEW conditional compilation support

## [1.0.1] - 2026-01-01

### Added
- Added extension icon

### Fixed
- Fixed issues with Emscripten SDK installation on Unix systems
- Fixed compilation compatibility issues on Unix Systems

## [1.0.0] - 2025-12-31

### Added
- Initial release of LVGL Live Preview extension
- Real-time preview of LVGL C code in VS Code
- Automatic hot reload on file save
- Emscripten SDK automatic download and installation
- LVGL library version management (supports v8.x and v9.x)
- Configurable display dimensions and compiler optimization levels
- Inline error diagnostics for compilation errors
- File watcher with debouncing for efficient recompilation
- WebAssembly compilation with pre-compiled LVGL library caching
- Interactive canvas with mouse/touch input support
- Status indicators and loading spinners
- Keyboard shortcut (Ctrl+Shift+L / Cmd+Shift+L) for quick preview start
- Commands for start, stop, rebuild, and cache clearing

### Technical Highlights
- **Webview Recreation Architecture**: Solves WASM hot reload by recreating the webview panel on each change, providing a fresh JavaScript context
- **CSP-Compliant Loading**: Uses nonce-based Content Security Policy for secure script execution
- **Fast Incremental Compilation**: Pre-compiles LVGL library to object files, then links with user code (~1-3 second recompilation)
- **Automatic Resource Management**: VS Code handles cleanup of webview resources automatically

### Known Limitations
- Single file preview only (multi-file projects planned for future)
- Requires Emscripten SDK (~200MB download on first use)
- Initial compilation may take 30-60 seconds (subsequent reloads are much faster)
