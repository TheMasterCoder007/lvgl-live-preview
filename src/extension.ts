import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PreviewManager } from './preview/previewManager';
import { CompilationManager } from './compiler/compilationManager';
import { StatusBarManager } from './ui/statusBarManager';
import { EmsdkInstaller } from './compiler/emsdkInstaller';
import { SUPPORTED_LANGUAGE_IDS, isHeaderFile } from './utils/languageUtils';

let previewManager: PreviewManager | undefined;
let compilationManager: CompilationManager | undefined;
let statusBarManager: StatusBarManager | undefined;
let outputChannel: vscode.OutputChannel;

/**
 * @brief Activates the LVGL Live Preview extension
 *
 * This function is called when the extension is activated. It initializes all managers,
 * registers commands, sets up the output channel, and handles the first-run welcome message.
 * The extension provides live preview functionality for LVGL C code by compiling it to
 * WebAssembly using Emscripten and displaying the result in a webview panel.
 *
 * @param context The extension context provided by VS Code, used for managing subscriptions
 *                and storing global state
 *
 * @details Initialization sequence:
 *          1. Creates an output channel for logging
 *          2. Initializes StatusBarManager for UI status updates
 *          3. Initializes CompilationManager for handling LVGL code compilation
 *          4. Initializes PreviewManager for webview panel management
 *          5. Shows a welcome message on the first run
 *          6. Registers extension commands (start, stop, rebuild, clearCache)
 *
 * @note Registered commands:
 *       - lvgl-preview.start: Starts live preview for the active C file
 *       - lvgl-preview.stop: Stops the preview and file watcher
 *       - lvgl-preview.rebuild: Forces full rebuild of preview
 *       - lvgl-preview.clearCache: Clears compilation cache
 */
export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('LVGL Preview');
	context.subscriptions.push(outputChannel);

	// Separate channel for the previewed app's own runtime output (printf / LV_LOG_*),
	// kept apart from the extension/build logs above.
	const logChannel = vscode.window.createOutputChannel('LVGL Runtime');
	context.subscriptions.push(logChannel);

	outputChannel.appendLine('LVGL Live Preview extension activated');

	// Initialize managers
	statusBarManager = new StatusBarManager();
	context.subscriptions.push(statusBarManager);

	compilationManager = new CompilationManager(context, outputChannel);
	previewManager = new PreviewManager(context, compilationManager, outputChannel, logChannel);

	// Show the status bar item only when it's relevant (a C file is active or a preview is
	// running), so it doesn't clutter windows unrelated to LVGL now that the extension can
	// activate on startup.
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => updateStatusBarVisibility())
	);
	updateStatusBarVisibility();

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.start', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active editor found');
				return;
			}

			// The preview compiles the file by its path, so it must exist on disk.
			// Check this before the file-type check so an unsaved buffer gets the
			// correct "save first" message rather than a type error.
			if (editor.document.isUntitled) {
				vscode.window.showErrorMessage('Please save this file to disk before starting the LVGL preview.');
				return;
			}

			// Must be a C/C++ source file. Reject headers explicitly: VS Code reports a
			// `c`/`cpp` languageId for .h/.hpp too, but compiling a header directly
			// produces confusing errors.
			if (!SUPPORTED_LANGUAGE_IDS.includes(editor.document.languageId) || isHeaderFile(editor.document.uri.fsPath)) {
				vscode.window.showErrorMessage('LVGL Preview must be started from a C or C++ source file, not a header.');
				return;
			}

			// Compilation reads the file from disk, so flush any unsaved edits first.
			if (editor.document.isDirty) {
				const saved = await editor.document.save();
				if (!saved) {
					void vscode.window.showInformationMessage('LVGL Preview start cancelled (file not saved).');
					return;
				}
			}

			// Check if preview is already running
			if (previewManager?.isRunning()) {
				vscode.window.showInformationMessage('LVGL Preview is already running. Stop it first to preview a different file.');
				return;
			}

			try {
				// Show output channel
				outputChannel.show(true);

				statusBarManager?.setStatus('initializing');
				outputChannel.appendLine('='.repeat(60));
				outputChannel.appendLine(`Starting preview for ${editor.document.fileName}`);
				outputChannel.appendLine(`File URI: ${editor.document.uri.toString()}`);
				outputChannel.appendLine('='.repeat(60));

				// Check if Emscripten is installed
				const emsdkInstaller = new EmsdkInstaller(context, outputChannel);
				const isInstalled = await emsdkInstaller.checkInstallation();

				if (!isInstalled) {
					const result = await vscode.window.showInformationMessage(
						'The Emscripten toolchain is required but not installed. This one-time setup downloads and ' +
							'installs it (~1–2 GB on disk) and requires Python 3 on your PATH. The first preview also ' +
							'downloads the SDL2 port. Install now?',
						'Install',
						'Cancel'
					);

					if (result === 'Install') {
						await emsdkInstaller.installEmsdk();
					} else {
						statusBarManager?.setStatus('idle');
						return;
					}
				}

				await previewManager?.startPreview(editor.document.uri);
				statusBarManager?.setStatus('running');
				updateStatusBarVisibility();
			} catch (error: unknown) {
				// Cancellation (e.g. cancelling the toolchain install) is not an error.
				if (error instanceof vscode.CancellationError) {
					outputChannel.appendLine('Preview startup cancelled.');
					statusBarManager?.setStatus('idle');
					void vscode.window.showInformationMessage('LVGL Preview setup cancelled.');
					return;
				}

				statusBarManager?.setStatus('error');
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : '';

				outputChannel.appendLine('='.repeat(60));
				outputChannel.appendLine('ERROR OCCURRED:');
				outputChannel.appendLine(`Message: ${errorMessage}`);
				if (errorStack) {
					outputChannel.appendLine(`Stack trace:`);
					outputChannel.appendLine(errorStack);
				}
				outputChannel.appendLine('='.repeat(60));

				vscode.window.showErrorMessage(`Failed to start preview: ${errorMessage}`);
				outputChannel.show(true);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.stop', async () => {
			outputChannel.appendLine('Stopping preview');
			await previewManager?.stopPreview();
			statusBarManager?.setStatus('idle');
			updateStatusBarVisibility();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.rebuild', async () => {
			outputChannel.appendLine('Rebuilding preview');
			statusBarManager?.setStatus('compiling');
			await compilationManager?.clearCache();
			await previewManager?.rebuild();
			statusBarManager?.setStatus('running');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.clearCache', async () => {
			outputChannel.appendLine('Clearing cache');
			await compilationManager?.clearCache();
			vscode.window.showInformationMessage('LVGL Preview cache cleared');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.checkSetup', async () => {
			await runSetupCheck(context);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.createSample', async () => {
			await openSampleFile();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.createSampleCpp', async () => {
			await openSampleFileCpp();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.openWalkthrough', async () => {
			try {
				await openGetStartedWalkthrough();
			} catch (error) {
				outputChannel.appendLine(`Failed to open Get Started walkthrough: ${error}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.installToolchain', async () => {
			const emsdkInstaller = new EmsdkInstaller(context, outputChannel);
			try {
				outputChannel.show(true);

				// The extension uses its own bundled Emscripten, not a system-wide emcc.
				if (await emsdkInstaller.checkInstallation()) {
					const choice = await vscode.window.showInformationMessage(
						'The Emscripten toolchain is already installed.',
						'Reinstall'
					);
					if (choice === 'Reinstall') {
						await emsdkInstaller.reinstall();
					}
					return;
				}

				await emsdkInstaller.installEmsdk();
			} catch (error: unknown) {
				if (error instanceof vscode.CancellationError) {
					void vscode.window.showInformationMessage('Emscripten installation cancelled.');
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Failed to install Emscripten toolchain: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.reinstallToolchain', async () => {
			const choice = await vscode.window.showWarningMessage(
				'Reinstall the Emscripten toolchain? This deletes the current install (~1–2 GB) and downloads it again.',
				{ modal: true },
				'Reinstall'
			);
			if (choice !== 'Reinstall') {
				return;
			}

			const emsdkInstaller = new EmsdkInstaller(context, outputChannel);
			try {
				outputChannel.show(true);
				await emsdkInstaller.reinstall();
			} catch (error: unknown) {
				if (error instanceof vscode.CancellationError) {
					void vscode.window.showInformationMessage('Emscripten reinstall cancelled.');
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Failed to reinstall Emscripten toolchain: ${message}`);
			}
		})
	);
	// On the first run (first startup after installation, thanks to onStartupFinished), open the
	// Get Started walkthrough. Runs after the commands are registered so its buttons work
	// immediately, and the "shown" flag is only set once it actually opens, so a failed
	// attempt is retried on the next startup instead of being lost.
	await showWalkthroughOnFirstRun(context);
}

// Opens the Get Started walkthrough on first run (see showWalkthroughOnFirstRun below).
/**
 * @brief Updates status bar visibility based on context.
 *
 * The item is shown only when a supported C/C++ file is the active editor or a preview is running.
 */
function updateStatusBarVisibility(): void {
	const languageId = vscode.window.activeTextEditor?.document.languageId;
	const isSupportedFile = languageId !== undefined && SUPPORTED_LANGUAGE_IDS.includes(languageId);
	const running = previewManager?.isRunning() ?? false;
	statusBarManager?.setVisible(isSupportedFile || running);
}

/**
 * @brief Opens the Get Started walkthrough.
 */
async function openGetStartedWalkthrough(): Promise<void> {
	await vscode.commands.executeCommand(
		'workbench.action.openWalkthrough',
		'themastercoder007.lvgl-live-preview#lvglGetStarted',
		false
	);
}

async function showWalkthroughOnFirstRun(context: vscode.ExtensionContext): Promise<void> {
	// Dedicated key (not the legacy 'hasShownWelcome') so the improved walkthrough shows
	// once for anyone who ran an earlier build where the flag was set without it opening.
	if (context.globalState.get<boolean>('hasOpenedGetStartedWalkthrough', false)) {
		return;
	}

	try {
		await openGetStartedWalkthrough();
		await context.globalState.update('hasOpenedGetStartedWalkthrough', true);
	} catch (error) {
		outputChannel.appendLine(`Failed to open Get Started walkthrough: ${error}`);
	}
}

/**
 * @brief Runs the setup diagnostics ("doctor") and reports the results.
 *
 * Writes a detailed report to the output channel and shows a summary notification.
 *
 * @param context - The extension context.
 */
async function runSetupCheck(context: vscode.ExtensionContext): Promise<void> {
	outputChannel.show(true);
	outputChannel.appendLine('='.repeat(60));
	outputChannel.appendLine('LVGL Preview — Setup Check');
	outputChannel.appendLine('='.repeat(60));

	const emsdkInstaller = new EmsdkInstaller(context, outputChannel);
	const diagnostics = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'LVGL: checking setup...', cancellable: false },
		() => emsdkInstaller.getDiagnostics()
	);

	const icon = { pass: '✓', warn: '⚠', fail: '✗' };
	for (const d of diagnostics) {
		outputChannel.appendLine(`${icon[d.status]} ${d.name}: ${d.detail}`);
	}
	outputChannel.appendLine('='.repeat(60));

	const failures = diagnostics.filter((d) => d.status === 'fail');
	const warnings = diagnostics.filter((d) => d.status === 'warn');

	if (failures.length === 0 && warnings.length === 0) {
		void vscode.window.showInformationMessage('LVGL Preview setup looks good — all checks passed.');
	} else {
		const parts = [
			...failures.map((d) => `✗ ${d.name}`),
			...warnings.map((d) => `⚠ ${d.name}`),
		];
		// Offer a direct install when the (bundled) toolchain is what's missing.
		const toolchainMissing = failures.some((d) => d.name === 'Emscripten toolchain');
		const actions = toolchainMissing ? ['Install Emscripten', 'Show Output'] : ['Show Output'];

		const action = await vscode.window.showWarningMessage(
			`LVGL Preview setup issues: ${parts.join(', ')}. See the LVGL Preview output for details.`,
			...actions
		);
		if (action === 'Install Emscripten') {
			await vscode.commands.executeCommand('lvgl-preview.installToolchain');
		} else if (action === 'Show Output') {
			outputChannel.show(true);
		}
	}
}

/**
 * @brief Opens a ready-to-run sample LVGL file with the required entry point.
 *
 * The sample is written to a real file on disk (in a temp folder) rather than an
 * untitled buffer, because the preview compiles the file by its path — untitled/unsaved
 * documents have no path and cannot be compiled.
 *
 * Used by the "Open Sample File" walkthrough step and command.
 */
async function openSampleFile(): Promise<void> {
	const sampleDir = path.join(os.tmpdir(), 'lvgl-live-preview');
	const samplePath = path.join(sampleDir, 'hello_lvgl.c');
	const content = `#include "lvgl.h"

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
`;

	fs.mkdirSync(sampleDir, { recursive: true });
	// Always write the canonical sample (overwrites any previous copy).
	fs.writeFileSync(samplePath, content, 'utf-8');

	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
	await vscode.window.showTextDocument(doc);
}

/**
 * @brief Opens a ready-to-run C++ sample that previews an LVGL UI.
 *
 * Demonstrates the intended layout for C++ projects: the LVGL UI is still built
 * with the C API, but the entry point lives in a C++ file. The required
 * `lvgl_live_preview_init()` entry point is declared `extern "C"` so its name is
 * not C++-mangled and the generated harness can link against it.
 */
async function openSampleFileCpp(): Promise<void> {
	const sampleDir = path.join(os.tmpdir(), 'lvgl-live-preview');
	const samplePath = path.join(sampleDir, 'hello_lvgl.cpp');
	const content = `#include "lvgl.h"

// A small C++ "glue" layer. Your LVGL UI is still written against the C API
// (see App::buildUi); only the entry point and surrounding code are C++.
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
// The preview calls this entry point by its C name, so it MUST be declared
// extern "C" — otherwise C++ name mangling hides it and linking fails.
extern "C" void lvgl_live_preview_init(void) {
    static App app;
    app.buildUi();
}
#endif
`;

	fs.mkdirSync(sampleDir, { recursive: true });
	// Always write the canonical sample (overwrites any previous copy).
	fs.writeFileSync(samplePath, content, 'utf-8');

	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
	await vscode.window.showTextDocument(doc);
}
