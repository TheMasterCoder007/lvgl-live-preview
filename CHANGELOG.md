# Changelog

All notable changes to the LVGL Live Preview extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
