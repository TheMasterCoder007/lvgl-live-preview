import * as vscode from 'vscode';
import { PreviewManager } from './preview/previewManager';
import { CompilationManager } from './compiler/compilationManager';
import { StatusBarManager } from './ui/statusBarManager';
import { EmsdkInstaller } from './compiler/emsdkInstaller';

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

	outputChannel.appendLine('LVGL Live Preview extension activated');

	// Initialize managers
	statusBarManager = new StatusBarManager();
	context.subscriptions.push(statusBarManager);

	compilationManager = new CompilationManager(context, outputChannel);
	previewManager = new PreviewManager(context, compilationManager, outputChannel);

	// Check if this is the first run
	const hasShownWelcome = context.globalState.get<boolean>('hasShownWelcome', false);
	if (!hasShownWelcome) {
		await showWelcomeMessage();
		await context.globalState.update('hasShownWelcome', true);
	}

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('lvgl-preview.start', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active editor found');
				return;
			}

			if (editor.document.languageId !== 'c') {
				vscode.window.showErrorMessage('LVGL Preview only works with C files');
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
						'Emscripten SDK is required but not installed. Download now? (This is a one-time setup, ~200MB)',
						'Download',
						'Cancel'
					);

					if (result === 'Download') {
						await emsdkInstaller.installEmsdk();
					} else {
						statusBarManager?.setStatus('idle');
						return;
					}
				}

				await previewManager?.startPreview(editor.document.uri);
				statusBarManager?.setStatus('running');
			} catch (error: unknown) {
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

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			// Only handle changes to lvglPreview configuration
			if (!event.affectsConfiguration('lvglPreview')) {
				return;
			}

			outputChannel.appendLine('Configuration changed, checking if reload is needed...');

			// Check if preview is currently running
			if (!previewManager || !compilationManager || !previewManager.isRunning()) {
				outputChannel.appendLine('No active preview, skipping reload');
				return;
			}

			// Check which settings changed
			const needsRebuild =
				event.affectsConfiguration('lvglPreview.displayWidth') ||
				event.affectsConfiguration('lvglPreview.displayHeight') ||
				event.affectsConfiguration('lvglPreview.emccOptimization') ||
				event.affectsConfiguration('lvglPreview.lvglVersion');

			const needsWatcherRestart =
				event.affectsConfiguration('lvglPreview.autoReload') ||
				event.affectsConfiguration('lvglPreview.debounceDelay');

			if (needsRebuild) {
				outputChannel.appendLine('Settings affecting compilation changed, rebuilding preview...');
				void vscode.window.showInformationMessage(
					'LVGL Preview settings changed. Clearing cache and rebuilding...'
				);

				statusBarManager?.setStatus('compiling');
				await compilationManager.clearCache();
				await previewManager.rebuild();
				statusBarManager?.setStatus('running');
			} else if (needsWatcherRestart) {
				outputChannel.appendLine('File watcher settings changed, restarting preview...');
				void vscode.window.showInformationMessage('LVGL Preview settings changed. Restarting preview...');

				// Get the current file being previewed and restart
				const currentFile = previewManager.getCurrentFile();
				if (currentFile) {
					statusBarManager?.setStatus('initializing');
					await previewManager.stopPreview();
					await previewManager.startPreview(currentFile);
					statusBarManager?.setStatus('running');
				}
			}
		})
	);
}

async function showWelcomeMessage() {
	const result = await vscode.window.showInformationMessage(
		'Welcome to LVGL Live Preview! This extension provides real-time preview of LVGL C code.',
		'Quick Start',
		'Documentation'
	);

	if (result === 'Quick Start') {
		// Create a sample LVGL file
		const doc = await vscode.workspace.openTextDocument({
			language: 'c',
			content: `
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
`,
		});
		await vscode.window.showTextDocument(doc);
	} else if (result === 'Documentation') {
		vscode.env.openExternal(vscode.Uri.parse('https://docs.lvgl.io/'));
	}
}
