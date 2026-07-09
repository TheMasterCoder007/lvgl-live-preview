import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CompilationManager } from '../compiler/compilationManager';
import { FileWatcher } from '../watcher/fileWatcher';
import { WebviewManager } from './webviewManager';
import { SettingsManager } from '../utils/settingsManager';
import { PreviewSettings } from '../types';

/**
 * @class PreviewManager
 * @brief Manages the LVGL preview lifecycle including compilation and hot reload.
 *
 * @details
 * This class orchestrates the preview functionality by:
 * - Managing the webview through WebviewManager
 * - Triggering compilations through CompilationManager
 * - Watching file changes through FileWatcher
 * - Coordinating hot reload by recreating the webview on changes
 *
 * @implements vscode.Disposable
 */
export class PreviewManager implements vscode.Disposable {
	private webviewManager: WebviewManager | undefined;
	private fileWatcher: FileWatcher | undefined;
	private compilationManager: CompilationManager;
	private readonly outputChannel: vscode.OutputChannel;
	private currentFile: vscode.Uri | undefined;

	/**
	 * @constructor
	 * @brief Creates a new PreviewManager instance.
	 *
	 * @param context - The VS Code extension context
	 * @param compilationManager - Manager for handling LVGL compilation
	 * @param outputChannel - Output channel for logging
	 */
	constructor(
		private context: vscode.ExtensionContext,
		compilationManager: CompilationManager,
		outputChannel: vscode.OutputChannel
	) {
		this.compilationManager = compilationManager;
		this.outputChannel = outputChannel;
	}

	/**
	 * @brief Starts the preview for a given C file.
	 *
	 * @details
	 * This method:
	 * 1. Creates or shows the webview
	 * 2. Compiles the user's C file with LVGL
	 * 3. Loads the resulting WASM module in the webview
	 * 4. Sets up file watching for automatic recompilation
	 *
	 * @param fileUri - URI of the C file to preview
	 */
	public async startPreview(fileUri: vscode.Uri): Promise<void> {
		this.outputChannel.appendLine(`[PreviewManager] Starting preview for: ${fileUri.fsPath}`);
		this.currentFile = fileUri;

		try {
			// Create a webview if it does not exist
			if (!this.webviewManager) {
				this.outputChannel.appendLine('[PreviewManager] Creating webview manager...');
				this.webviewManager = new WebviewManager(
					this.context,
					this.outputChannel,
					async () => {
						await this.rebuild();
					},
					async (settings) => {
						await this.saveSettings(settings);
					}
				);
			}

			// Show webview
			const fileName = path.basename(fileUri.fsPath);
			this.outputChannel.appendLine(`[PreviewManager] Showing webview for: ${fileName}`);
			await this.webviewManager.createOrShow(fileName);

			// Compile the file
			this.outputChannel.appendLine('[PreviewManager] Starting compilation...');
			await this.compileAndUpdate(fileUri);

			// Start watching files for changes (honors autoReload/debounceDelay settings)
			this.startFileWatcher();

			this.outputChannel.appendLine('[PreviewManager] Preview started successfully');
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.outputChannel.appendLine(`[PreviewManager] ERROR: ${errorMessage}`);
			if (error instanceof Error && error.stack) {
				this.outputChannel.appendLine(`[PreviewManager] Stack: ${error.stack}`);
			}
			throw error;
		}
	}

	/**
	 * @brief Compiles the user's file and updates the preview.
	 *
	 * For hot reload (isReload=true), this method recreates the webview before
	 * loading the new WASM module, ensuring a fresh JavaScript context.
	 *
	 * @param fileUri - URI of the C file to compile
	 * @param isReload - Whether this is a hot reload (true) or initial load (false)
	 */
	private async compileAndUpdate(fileUri: vscode.Uri, isReload: boolean = false): Promise<void> {
		try {
			this.outputChannel.appendLine(`[PreviewManager] Compiling: ${fileUri.fsPath}`);

			// If this is a reload (not the first load), recreate the webview
			if (isReload && this.webviewManager) {
				const fileName = path.basename(fileUri.fsPath);
				await this.webviewManager.recreate(fileName);
			}

			// Notify webview that compilation is starting
			this.webviewManager?.sendMessage({ type: 'compiling' });

			// Compile the file
			const result = await this.compilationManager.compileUserFile(fileUri);

			this.outputChannel.appendLine(
				`[PreviewManager] Compilation result: ${result.success ? 'SUCCESS' : 'FAILED'}`
			);

			if (result.success && result.wasmPath && result.jsPath) {
				this.outputChannel.appendLine(`[PreviewManager] WASM path: ${result.wasmPath}`);
				this.outputChannel.appendLine(`[PreviewManager] JS path: ${result.jsPath}`);

				// Verify files exist
				const wasmExists = fs.existsSync(result.wasmPath);
				const jsExists = fs.existsSync(result.jsPath);
				this.outputChannel.appendLine(`[PreviewManager] WASM exists: ${wasmExists}`);
				this.outputChannel.appendLine(`[PreviewManager] JS exists: ${jsExists}`);

				if (!wasmExists || !jsExists) {
					this.outputChannel.appendLine('[PreviewManager] ERROR: Output files do not exist!');
					this.webviewManager?.sendMessage({
						type: 'showError',
						message: 'Compilation output files not found',
					});
					return;
				}

				// Read both WASM and JS file contents directly
				const wasmContent = fs.readFileSync(result.wasmPath);
				const jsContent = fs.readFileSync(result.jsPath, 'utf-8');

				this.outputChannel.appendLine(`[PreviewManager] WASM content size: ${wasmContent.length} bytes`);
				this.outputChannel.appendLine(`[PreviewManager] JS content size: ${jsContent.length} bytes`);

				// Send content to the webview as base64-encoded WASM
				this.webviewManager?.sendMessage({
					type: 'loadWasm',
					wasmBase64: wasmContent.toString('base64'),
					jsContent: jsContent,
				});
			} else {
				// Show error in the webview
				const errorMessage =
					result.errors.length > 0
						? result.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n')
						: 'Compilation failed';

				this.outputChannel.appendLine(`[PreviewManager] Sending error to webview: ${errorMessage}`);

				this.webviewManager?.sendMessage({
					type: 'showError',
					message: errorMessage,
					errors: result.errors,
				});
			}
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.outputChannel.appendLine(`[PreviewManager] compileAndUpdate ERROR: ${errorMessage}`);
			if (error instanceof Error && error.stack) {
				this.outputChannel.appendLine(`[PreviewManager] Stack: ${error.stack}`);
			}

			// Show error in the webview
			this.webviewManager?.sendMessage({
				type: 'showError',
				message: `Compilation error: ${errorMessage}`,
			});
		}
	}

	/**
	 * @brief Rebuilds the current preview.
	 *
	 * Forces a recompilation of the currently previewed file.
	 */
	public async rebuild(): Promise<void> {
		if (this.currentFile) {
			await this.compileAndUpdate(this.currentFile, true);
		}
	}

	/**
	 * @brief Settings that are baked into the compiled output and require a rebuild.
	 */
	private static readonly REBUILD_KEYS: (keyof PreviewSettings)[] = [
		'displayWidth',
		'displayHeight',
		'emccOptimization',
		'lvglVersion',
		'lvglMemorySize',
		'wasmMemorySize',
	];

	/**
	 * @brief Settings that only affect how source files are watched.
	 */
	private static readonly WATCHER_KEYS: (keyof PreviewSettings)[] = ['autoReload', 'debounceDelay'];

	/**
	 * @brief Persists settings from the in-webview settings panel and applies them.
	 *
	 * This is the single point at which saved settings take effect. Because settings
	 * live in the extension's own storage (not VS Code configuration), nothing reacts
	 * to individual field edits - the preview only rebuilds/reloads here, when the
	 * user clicks Save, and only for the settings that actually changed.
	 *
	 * @param settings - The settings selected in the webview panel.
	 */
	public async saveSettings(settings: PreviewSettings): Promise<void> {
		const changed = await SettingsManager.saveSettings(this.context, settings);

		if (changed.length === 0) {
			this.outputChannel.appendLine('[PreviewManager] Settings saved (no changes)');
			this.refreshSettings();
			return;
		}

		this.outputChannel.appendLine(`[PreviewManager] Settings saved, changed: ${changed.join(', ')}`);

		const needsRebuild = changed.some((key) => PreviewManager.REBUILD_KEYS.includes(key));
		const needsWatcherRestart = changed.some((key) => PreviewManager.WATCHER_KEYS.includes(key));

		if (needsRebuild) {
			// Compile-affecting settings changed: discard cached artifacts and rebuild.
			// rebuild() recreates the webview, which re-requests settings on load.
			await this.compilationManager.clearCache();
			await this.rebuild();
		} else {
			// No rebuild: make sure the panel reflects the persisted values.
			this.refreshSettings();
		}

		if (needsWatcherRestart) {
			// Re-create the watcher so new autoReload/debounceDelay values take effect.
			this.startFileWatcher();
		}
	}

	/**
	 * @brief Re-sends the current settings to the webview settings panel.
	 *
	 * Keeps the panel in sync when settings change without recreating the webview
	 * (e.g., a save that only affects the file watcher).
	 */
	public refreshSettings(): void {
		this.webviewManager?.sendSettings();
	}

	/**
	 * @brief Creates (or re-creates) the file watcher based on current settings.
	 *
	 * Any existing watcher is disposed of first. When autoReload is disabled, no watcher
	 * is created. In project-config mode the main file and all dependencies are
	 * watched; otherwise the single previewed file is watched.
	 */
	private startFileWatcher(): void {
		if (!this.currentFile) {
			return;
		}

		// Dispose any existing watcher to avoid duplicates / stale debounce values.
		if (this.fileWatcher) {
			this.outputChannel.appendLine('[PreviewManager] Disposing existing file watcher');
			this.fileWatcher.dispose();
			this.fileWatcher = undefined;
		}

		const settings = SettingsManager.getSettings(this.context);
		if (!settings.autoReload) {
			this.outputChannel.appendLine('[PreviewManager] Auto reload disabled; file watcher not started');
			return;
		}

		const fileUri = this.currentFile;
		this.fileWatcher = new FileWatcher(async (uri) => {
			this.outputChannel.appendLine(`File changed: ${uri.fsPath}`);
			await this.compileAndUpdate(fileUri, true); // Always use original fileUri for compilation
		}, settings.debounceDelay);

		// Check if we have a project config with dependencies
		const projectConfig = this.compilationManager.getCurrentConfig();
		if (projectConfig) {
			// Watch main file and all dependencies
			const filesToWatch = [
				vscode.Uri.file(projectConfig.mainFile),
				...projectConfig.dependencies.map((dep) => vscode.Uri.file(dep)),
			];
			this.fileWatcher.watchFiles(filesToWatch);
			this.outputChannel.appendLine(
				`[PreviewManager] File watcher started for ${filesToWatch.length} files`
			);
		} else {
			// Single file mode
			this.fileWatcher.watchFile(fileUri);
			this.outputChannel.appendLine('[PreviewManager] File watcher started');
		}
	}

	/**
	 * @brief Checks if a preview is currently running.
	 *
	 * @returns true if a preview is active, false otherwise
	 */
	public isRunning(): boolean {
		return this.currentFile !== undefined && this.webviewManager !== undefined;
	}

	/**
	 * @brief Gets the currently previewed file URI.
	 *
	 * @returns The URI of the file being previewed, or undefined if no preview is active
	 */
	public getCurrentFile(): vscode.Uri | undefined {
		return this.currentFile;
	}

	/**
	 * @brief Stops the preview and cleans up resources.
	 *
	 * Disposes the file watcher, webview, and clears diagnostics.
	 */
	public async stopPreview(): Promise<void> {
		this.fileWatcher?.dispose();
		this.fileWatcher = undefined;
		this.webviewManager?.dispose();
		this.webviewManager = undefined;
		this.currentFile = undefined;
		this.compilationManager.clearDiagnostics();
	}

	/**
	 * @brief Disposes all resources used by the PreviewManager.
	 */
	public dispose(): void {
		void this.stopPreview();
	}
}
