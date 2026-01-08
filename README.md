# LVGL Live Preview

**Live preview for LVGL C code with automatic hot-reload in VS Code**

[![License: GPL](https://img.shields.io/badge/License-GPL-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## Overview

LVGL Live Preview is a Visual Studio Code extension that provides real-time preview of LVGL (Light and Versatile Graphics Library) C code. It compiles your LVGL code using Emscripten to WebAssembly and displays the result in a live webview panel with automatic reloading on file changes.

## Features

- 🚀 **Live Preview**: See your LVGL UI in real-time as you code
- 🔄 **Hot Reload**: Automatic recompilation and refresh on file save with full WASM module reloading
- 🎨 **Interactive**: Full mouse/touch input support
- ⚙️ **Configurable**: Customize display size, LVGL version, and compiler optimization
- 📦 **Zero Setup**: Emscripten SDK is downloaded and installed automatically
- 🎯 **Single or Multi-File**: Works with single C files or multi-file projects with dependencies
- 📁 **Dependency Management**: Configure dependencies via `.lvgl-live-preview.json` with incremental compilation
- 🔧 **Custom Defines**: Add global preprocessor defines to your project
- 💾 **Smart Caching**: Dependency object files are cached and only recompiled when changed
- 🔍 **Error Reporting**: Inline diagnostics for compilation errors
- ♻️ **Reliable Reloading**: Webview recreation ensures clean module reloading on every change

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "LVGL Live Preview"
4. Click Install

### From Source

```bash
git clone https://github.com/TheMasterCoder007/lvgl-live-preview.git
cd lvgl-live-preview
npm install
npm run compile
```

Then press F5 to run the extension in development mode.

## Quick Start

1. Create a new C file with LVGL code
2. Define a `lvgl_live_preview_init()` function wrapped in `#ifdef LVGL_LIVE_PREVIEW` (required entry point)
3. Press `Ctrl+Shift+L` or run "LVGL: Start Live Preview" from the command palette
4. Wait for Emscripten to download (first time only, ~200MB)
5. Your LVGL UI will appear in a webview panel!

### Example Code

```c
#include "lvgl.h"

#ifdef LVGL_LIVE_PREVIEW
void lvgl_live_preview_init(void) {
    // Create a simple button
    lv_obj_t *btn = lv_btn_create(lv_scr_act());
    lv_obj_set_size(btn, 120, 50);
    lv_obj_center(btn);

    lv_obj_t *label = lv_label_create(btn);
    lv_label_set_text(label, "Hello LVGL!");
    lv_obj_center(label);
}
#endif
```

## Requirements

- **Required Entry Point**: Your main C file must define a `void lvgl_live_preview_init(void)` function wrapped in `#ifdef LVGL_LIVE_PREVIEW`. This is where you initialize your LVGL UI. The `LVGL_LIVE_PREVIEW` define is automatically provided by the extension during compilation, ensuring the function is only visible when using the live preview feature.
- **LVGL API**: Use standard LVGL API calls. The extension supports LVGL v8.x and v9.x.

## Usage Modes

### Single File Mode
If no `.lvgl-live-preview.json` configuration file is found, the extension operates in single-file mode. Simply open a C file with LVGL code and start the preview.

### Multi-File Mode (Project Configuration)
For projects with multiple C files, create a `.lvgl-live-preview.json` file at your project root:

```json
{
  "mainFile": "myLvglApp.c",
  "dependencies": [
    "helpers.c",
    "utils.c",
    "drivers/display.c"
  ],
  "includePaths": [
    "./include",
    "../common/headers"
  ],
  "defines": [
    "MY_CUSTOM_DEFINE",
    "DEBUG_MODE=1"
  ]
}
```

**Configuration Options:**
- `mainFile` (required): Path to the main C file containing `lvgl_live_preview_init()`. Paths are relative to the config file location.
- `dependencies` (optional): Array of C files to compile with the main file. These are compiled to `.o` files and cached.
- `includePaths` (optional): Array of include directory paths for header files. Paths are relative to the config file location.
- `defines` (optional): Array of preprocessor defines to add during compilation.

**Features:**
- **Incremental Compilation**: Dependency files are cached as `.o` files and only recompiled when changed
- **File Watching**: All source files (main + dependencies) are watched for changes
- **Hot Reload**: Any change to any source file triggers recompilation with smart caching

## Configuration

Access settings via `File > Preferences > Settings` and search for "LVGL Preview":

| Setting | Default | Description |
|---------|---------|-------------|
| `lvglPreview.lvglVersion` | `9.4.0` | LVGL library version to use |
| `lvglPreview.displayWidth` | `480`   | Display width in pixels |
| `lvglPreview.displayHeight` | `320`   | Display height in pixels |
| `lvglPreview.emccOptimization` | `-O1`   | Emscripten optimization level (-O0, -O1, -O2, -O3, -Os, -Oz) |
| `lvglPreview.autoReload` | `true`  | Automatically reload preview on file changes |
| `lvglPreview.debounceDelay` | `100`   | Delay in ms before recompiling after file changes |

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `LVGL: Start Live Preview` | `Ctrl+Shift+L` | Start preview for the current C file |
| `LVGL: Stop Preview` | - | Stop the preview and file watcher |
| `LVGL: Force Rebuild` | - | Force full rebuild including LVGL library |
| `LVGL: Clear Cache` | - | Clear compiled cache |

## How It Works

1. **Emscripten Setup**: Downloads and installs Emscripten SDK on first use
2. **LVGL Download**: Downloads specified LVGL version from GitHub
3. **Library Compilation**: Compiles LVGL library to static library (cached per version/settings)
4. **User Code Compilation**: Compiles your C file with LVGL
5. **WASM Generation**: Links everything into WebAssembly + JS glue code
6. **Preview**: Displays in webview with SDL2 canvas rendering
7. **Hot Reload**: Watches file changes, recompiles, and fully reloads the WASM module through webview recreation

### Technical Details: Hot Reload Architecture

The extension uses **webview recreation** to ensure reliable WASM module reloading:

- Initial load creates a webview panel with the WASM module
- On file changes, the entire webview is disposed and recreated
- Each reload gets a completely fresh JavaScript execution context
- This prevents runtime state conflicts and memory leaks from Emscripten's persistent globals
- The recreation is fast (~100ms) and provides a clean slate for each reload

This approach solves the common problem of Emscripten modules failing to reload due to persistent global state by letting VS Code handle the cleanup automatically.

## Troubleshooting

### Emscripten Download Fails
- Check your internet connection
- Try clearing the cache: Run "LVGL: Clear Cache"
- Manually download from the output channel for details

### Compilation Errors
- Ensure you have defined `lvgl_live_preview_init()` function wrapped in `#ifdef LVGL_LIVE_PREVIEW`
- Check the Problems panel (Ctrl+Shift+M) for detailed errors
- View the LVGL Preview output channel for compiler messages

### Preview Not Updating
- Check that Auto Reload is enabled in settings
- Manually save the file (Ctrl+S)
- Try "LVGL: Force Rebuild" command

### Performance Issues
- Lower the optimization level to `-O0` for faster compilation
- Reduce display dimensions in settings
- Close other resource-intensive applications

## Roadmap

- [x] Multi-file project support
- [x] Dependency caching and incremental compilation
- [x] Custom preprocessor defines
- [ ] Custom `lv_conf.h` editor

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the GNU General Public License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [LVGL](https://lvgl.io/) - The awesome graphics library
- [Emscripten](https://emscripten.org/) - The WebAssembly compiler toolchain
- VS Code Extension API

## Support

- 📚 [LVGL Documentation](https://docs.lvgl.io/)
- 💬 [LVGL Forum](https://forum.lvgl.io/)
- 🐛 [Report Issues](https://github.com/TheMasterCoder007/lvgl-live-preview/issues)

---

Made with ❤️ for the LVGL community
