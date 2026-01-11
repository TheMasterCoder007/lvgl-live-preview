# Changelog

All notable changes to the LVGL Live Preview extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Python detection before Emscripten SDK installation
- Clear error messages when Python is not installed or not in PATH
- "Download Python" button in the error dialog for quick access to Python downloads

### Fixed
- Fixed silent installation failures during Emscripten installation
- Fixed false "installation successful" message when Emscripten SDK installation actually fails
- Emscripten SDK installation now properly validates Python availability before proceeding
- Enhanced error detection in emsdk command output to catch Python-related failures
- Added proper error detection for SSL certificate failures with instructions to fix Python certificates

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
