# LVGL Live Preview

**Live preview for LVGL C/C++ code with automatic hot-reload in VS Code**

[![License: GPL](https://img.shields.io/badge/License-GPL-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## Overview

LVGL Live Preview is a Visual Studio Code extension that provides real-time preview of LVGL (Light and Versatile Graphics Library) UIs. It compiles your LVGL code using Emscripten to WebAssembly and displays the result in a live webview panel with automatic reloading on file changes.

The LVGL UI itself is written against LVGL's C API, but your entry point ("glue") file may be **C or C++** — a common layout for firmware where a C++ application layer initializes a C UI. See [C++ Projects](#c-projects) below.

## Features

- 🚀 **Live Preview**: See your LVGL UI in real-time as you code
- 🔄 **Hot Reload**: Automatic recompilation and refresh on file save with full WASM module reloading
- 🎨 **Interactive**: Full mouse/touch input support
- 🛠️ **In-Preview Settings**: Adjust display size, LVGL version, optimization, and more from a panel in the preview window — edits apply when you click **Save** (Reset Cache / Reset to Defaults apply immediately)
- 🔀 **Orientation Toggle**: A **Rotate** button swaps display width/height (portrait ⇄ landscape) for the current session, without changing your saved settings
- 🔍 **Fit to Window**: The preview scales to fit the window (up or down) while preserving aspect ratio; can be toggled off in settings
- 📦 **Zero Setup**: Emscripten SDK is downloaded and installed automatically
- ➕ **C and C++**: Preview a single file or a multi-file project — a C entry point, or a C++ entry point that drives a C LVGL UI
- 📁 **Dependency Management**: Configure dependencies via `.lvgl-live-preview.json` with incremental compilation and smart caching
- 🔧 **Custom Defines**: Add global preprocessor defines to your project
- 🔍 **Error Reporting**: Inline diagnostics for compilation errors
- 📝 **Runtime Logs in VS Code**: Your app's `printf` and `LV_LOG_*` output is routed to a dedicated "LVGL Runtime" output channel

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

> **New here?** Open the **Get Started with LVGL Live Preview** walkthrough from the VS Code Welcome page (or run **Welcome: Open Walkthrough**) for a guided setup. It also opens automatically the first time the extension activates.

1. Create a new C (or C++) file with LVGL code
2. Define a `lvgl_live_preview_init()` function wrapped in `#ifdef LVGL_LIVE_PREVIEW` that calls your own UI initialization (required entry point; in a C++ file declare it `extern "C"`)
3. Press `Ctrl+Shift+L` or run "LVGL: Start Live Preview" from the command palette
4. Wait for the Emscripten toolchain to install (first time only; downloads and installs ~1–2 GB and requires Python 3 on your PATH). The very first preview also downloads the SDL2 port.
5. Your LVGL UI will appear in a webview panel!

### Example Code

```c
#include "lvgl.h"

// initializes your UI (entry point of your application)
static void ui_init(void) {
    // Create a simple button
    lv_obj_t *btn = lv_btn_create(lv_scr_act());
    lv_obj_set_size(btn, 120, 50);
    lv_obj_center(btn);

    lv_obj_t *label = lv_label_create(btn);
    lv_label_set_text(label, "Hello LVGL!");
    lv_obj_center(label);
}

#ifdef LVGL_LIVE_PREVIEW
// gives the live preview tool a way to initialize your UI
void lvgl_live_preview_init(void) {
    ui_init();
}
#endif
```

### C++ Projects

The extension also previews **C++** entry points. This suits the common firmware layout where the LVGL UI is written in C (because that is how LVGL is designed) but the glue layer that initializes it lives in a `.cpp` file.

Two things to know:

1. **The entry point must be `extern "C"`.** The generated harness calls `lvgl_live_preview_init` by its C name, so declaring it `extern "C"` prevents C++ name mangling from hiding it at link time.
2. **Mixed C and C++ builds just work.** Emscripten selects each file's language by extension (`.c` → C, `.cpp`/`.cc`/`.cxx`/`.c++` → C++) and links the C++ standard library on demand, so your C++ entry point and C UI compile together with no extra configuration.

Run **LVGL: Open C++ Sample File** from the Command Palette for a ready-to-run example, or use this layout:

```cpp
#include "lvgl.h"

// C++ application/glue layer. The UI is still built with LVGL's C API.
class App {
public:
    void buildUi() {
        lv_obj_t *btn = lv_btn_create(lv_scr_act());
        lv_obj_set_size(btn, 140, 50);
        lv_obj_center(btn);

        lv_obj_t *label = lv_label_create(btn);
        lv_label_set_text(label, "Hello from C++!");
        lv_obj_center(label);
    }
};

#ifdef LVGL_LIVE_PREVIEW
// MUST be extern "C" so the name isn't mangled and the harness can link it.
extern "C" void lvgl_live_preview_init(void) {
    static App app;
    app.buildUi();
}
#endif
```

For a mixed project (C++ entry point and C UI files), point `mainFile` at the `.cpp` file and list your `.c` UI files under `dependencies` in `.lvgl-live-preview.json`:

```json
{
  "mainFile": "app.cpp",
  "dependencies": ["ui/screen_main.c", "ui/widgets.c"]
}
```

## Requirements

- **Python 3**: Must be installed and on your system PATH. It is required both to install the Emscripten SDK and to run `emcc` (which is a Python program), so it is needed for every build, not just setup. [Download Python](https://www.python.org/downloads/)
- **Disk space**: The Emscripten toolchain installs to the extension's storage and needs ~1–2 GB free. It is pinned to a specific, tested version for reproducible builds.
- **Setup diagnostics**: Run **LVGL: Check Setup** from the Command Palette to verify Python, Emscripten, disk space, and network connectivity.
- **Required Entry Point**: Your main file must define a `void lvgl_live_preview_init(void)` function wrapped in `#ifdef LVGL_LIVE_PREVIEW`. Call your application's own UI initialization from it (see the example above) so the same code drives both the preview and your firmware. The `LVGL_LIVE_PREVIEW` define is automatically provided by the extension during compilation, ensuring the function is only visible when using the live preview feature. In a **C++** entry-point file, declare it `extern "C"` (see [C++ Projects](#c-projects)).
- **LVGL API**: Use standard LVGL API calls. The extension supports LVGL v8.x and v9.x.

## Usage Modes

### Single File Mode
If no `.lvgl-live-preview.json` configuration file is found, the extension operates in single-file mode. Simply open a C or C++ file with LVGL code and start the preview.

### Multi-File Mode (Project Configuration)
For projects with multiple source files, create a `.lvgl-live-preview.json` file at your project root:

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
- `mainFile` (required): Path to the main source file (`.c` or `.cpp`) containing `lvgl_live_preview_init()`. Paths are relative to the config file location.
- `dependencies` (optional): Array of source files (`.c` and/or `.cpp`) to compile with the main file. These are compiled to `.o` files and cached.
- `includePaths` (optional): Array of include directory paths for header files. Paths are relative to the config file location.
- `defines` (optional): Array of preprocessor defines to add during compilation.

**Features:**
- **Incremental Compilation**: Dependency files are cached as `.o` files and only recompiled when changed
- **File Watching**: All source files (main + dependencies) are watched for changes
- **Hot Reload**: Any change to any source file triggers recompilation with smart caching

## Configuration

All settings are managed from the **preview window** — they are stored by the extension itself and do **not** appear in the VS Code Settings UI. Click the gear button in the top-right corner of the preview to open the settings panel. Edit any value and click **Save** to apply.

- Changes are **only** applied when you click Save. Closing the panel (via Cancel, the ✕, `Esc`, or clicking outside it) discards your edits and leaves the current settings untouched.
- The preview rebuilds and reloads **only** when saved — and only once per Save, no matter how many fields you edited.
- Settings persist across sessions. If you used an earlier version that stored these under `lvglPreview.*` in VS Code settings, your values are migrated automatically the first time you open the panel.

| Setting | Default | Description |
|---------|---------|-------------|
| LVGL Version | `9.4.0` | LVGL library version to use |
| Display Width | `480`   | Display width in pixels |
| Display Height | `320`   | Display height in pixels |
| Scale preview to fit the window | `true` | Scale the preview to fit the window while preserving aspect ratio (scales up or down) |
| Emscripten Optimization | `-O1`   | Emscripten optimization level (-O0, -O1, -O2, -O3, -Os, -Oz) |
| Auto Reload | `true`  | Automatically reload preview on file changes |
| Debounce Delay | `100`   | Delay in ms before recompiling after file changes |
| LVGL Memory Size | `256`   | LVGL internal heap memory size in KB (64, 128, 256, 512, 1024, 2048) |
| WASM Memory Size | `128`   | WebAssembly total memory size in MB (64, 128, 256, 512, 1024) |

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `LVGL: Start Live Preview` | `Ctrl+Shift+L` | Start preview for the current C/C++ file |
| `LVGL: Stop Preview` | - | Stop the preview and file watcher |
| `LVGL: Force Rebuild` | - | Force full rebuild including LVGL library |
| `LVGL: Clear Cache` | - | Clear compiled cache |
| `LVGL: Open Sample File` | - | Open a ready-to-run C sample |
| `LVGL: Open C++ Sample File` | - | Open a ready-to-run C++ sample (C++ glue driving a C UI) |
| `LVGL: Check Setup` | - | Diagnose the environment (Python, Emscripten, disk space, network) |
| `LVGL: Install Emscripten Toolchain` | - | Install the bundled Emscripten toolchain |
| `LVGL: Reinstall Emscripten Toolchain` | - | Delete and reinstall the Emscripten toolchain |
| `LVGL: Open Get Started Walkthrough` | - | Reopen the Get Started walkthrough |

## Logging

Anything your code prints — via `printf`, `LV_LOG_USER`, or the other `LV_LOG_*` macros — is routed to the **LVGL Runtime** output channel in VS Code (View → Output, then select "LVGL Runtime" from the dropdown). The channel opens automatically the first time your app logs something in a preview session.

```c
LV_LOG_USER("Button clicked, value = %d", value);
printf("Hello from LVGL\n");
```

Logging uses LVGL's built-in `printf` log target, so no extra setup is required. Note that the default log level is `LV_LOG_LEVEL_WARN`, so `LV_LOG_INFO`/`LV_LOG_TRACE` messages are suppressed while `LV_LOG_USER`, `LV_LOG_WARN`, and `LV_LOG_ERROR` are shown.

## How It Works

1. **Emscripten Setup**: Downloads and installs Emscripten SDK on first use
2. **LVGL Download**: Downloads a specified LVGL version from GitHub
3. **Library Compilation**: Compiles LVGL library to a static library (cached per version/settings)
4. **User Code Compilation**: Compiles your C/C++ code with LVGL (extension selects each file's language)
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

### Python Not Found Error
If you see "Python is required to install Emscripten SDK":
- Install Python from [python.org/downloads](https://www.python.org/downloads/)
- Ensure Python is added to your system PATH during installation
- Restart VS Code after installing Python
- Verify installation by running `python --version` or `python3 --version` in a terminal

### Emscripten Download Fails
- Check your internet connection
- Try clearing the cache: Run "LVGL: Clear Cache"
- Check the LVGL Preview output channel for details

### Compilation Errors
- Ensure you have defined `lvgl_live_preview_init()` function wrapped in `#ifdef LVGL_LIVE_PREVIEW`
- In a C++ entry point, declare it `extern "C"` — otherwise the linker reports `lvgl_live_preview_init` as undefined
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
- [x] C++ entry point support
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
