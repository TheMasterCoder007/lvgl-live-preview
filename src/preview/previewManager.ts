import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CompilationManager } from '../compiler/compilationManager';
import { FileWatcher } from '../watcher/fileWatcher';
import { WebviewManager } from './webviewManager';

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
				this.webviewManager = new WebviewManager(this.context, this.outputChannel);
			}

			// Show webview
			const fileName = path.basename(fileUri.fsPath);
			this.outputChannel.appendLine(`[PreviewManager] Showing webview for: ${fileName}`);
			await this.webviewManager.createOrShow(fileName);

			// Compile the file
			this.outputChannel.appendLine('[PreviewManager] Starting compilation...');
			await this.compileAndUpdate(fileUri);

			// Start watching the file for changes
			const config = vscode.workspace.getConfiguration('lvglPreview');
			const autoReload = config.get<boolean>('autoReload', true);
			const debounceDelay = config.get<number>('debounceDelay', 300);

			if (autoReload) {
				this.fileWatcher = new FileWatcher(async (uri) => {
					this.outputChannel.appendLine(`File changed: ${uri.fsPath}`);
					await this.compileAndUpdate(uri, true); // Pass true for reload
				}, debounceDelay);

				this.fileWatcher.watchFile(fileUri);
				this.outputChannel.appendLine('[PreviewManager] File watcher started');
			}

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
