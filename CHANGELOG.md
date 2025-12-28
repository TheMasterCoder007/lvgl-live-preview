# Changelog

All notable changes to the LVGL Live Preview extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-12-27

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
