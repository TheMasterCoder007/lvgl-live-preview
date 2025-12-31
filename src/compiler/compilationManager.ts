import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EmccWrapper } from './emccWrapper';
import { LibraryBuilder } from '../lvgl/libraryBuilder';
import { VersionManager } from '../lvgl/versionManager';
import { MainTemplate } from '../lvgl/mainTemplate';
import { IntellisenseHelper } from '../utils/intellisenseHelper';
import { CompilationResult } from '../types';

/**
 * @class CompilationManager
 * @brief Manages the compilation workflow for LVGL user files.
 *
 * Orchestrates the complete build process including LVGL version management,
 * library building, user file compilation, and VS Code diagnostics integration.
 * Implements vscode.Disposable for proper resource cleanup.
 */
export class CompilationManager implements vscode.Disposable {
	private emccWrapper: EmccWrapper;
	private libraryBuilder: LibraryBuilder;
	private versionManager: VersionManager;
	private outputChannel: vscode.OutputChannel;
	private readonly buildPath: string;
	private diagnosticCollection: vscode.DiagnosticCollection;

	/**
	 * @constructor
	 * @brief Initializes the CompilationManager with extension context and output channel.
	 *
	 * Sets up the necessary components for compilation and diagnostics.
	 *
	 * @param context Extension context for accessing global storage and workspace.
	 * @param outputChannel Output channel for displaying compilation logs to the user.
	 */
	constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.emccWrapper = new EmccWrapper(context, outputChannel);
		this.libraryBuilder = new LibraryBuilder(context, outputChannel);
		this.versionManager = new VersionManager(context, outputChannel);
		this.buildPath = path.join(context.globalStorageUri.fsPath, 'build');
		this.diagnosticCollection = vscode.languages.createDiagnosticCollection('lvgl');

		if (!fs.existsSync(this.buildPath)) {
			fs.mkdirSync(this.buildPath, { recursive: true });
		}
	}

	/**
	 * @brief Compiles a user's LVGL C source file to WebAssembly.
	 *
	 * Performs the complete compilation workflow:
	 * 1. Retrieves configuration settings (LVGL version, optimization, display size)
	 * 2. Ensures the specified LVGL version is downloaded
	 * 3. Updates IntelliSense configuration for the workspace
	 * 4. Builds or retrieves cached LVGL object files
	 * 5. Generates the main entry point file
	 * 6. Compiles the user file with LVGL objects
	 * 7. Updates VS Code diagnostics with any errors/warnings
	 *
	 * @param fileUri URI of the C source file to compile.
	 * @returns Promise resolving to CompilationResult with success status and any errors/warnings.
	 */
	public async compileUserFile(fileUri: vscode.Uri): Promise<CompilationResult> {
		const config = vscode.workspace.getConfiguration('lvglPreview');
		const lvglVersion = config.get<string>('lvglVersion', '9.2.0');

		this.outputChannel.appendLine(`Starting compilation of ${fileUri.fsPath}`);

		try {
			// Ensure LVGL version is downloaded
			const lvglPath = await this.versionManager.ensureVersion(lvglVersion);
			this.outputChannel.appendLine(`LVGL path: ${lvglPath}`);

			// Update IntelliSense configuration
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
			await IntellisenseHelper.updateCppProperties(lvglPath, workspaceFolder);

			// Build or get cached LVGL object files
			this.outputChannel.appendLine('Checking for LVGL objects...');
			const objectFiles = await this.libraryBuilder.buildLibrary(lvglVersion);
			this.outputChannel.appendLine(`Using ${objectFiles.length} LVGL object files`);

			// Get LVGL include path
			const lvglIncludePath = this.versionManager.getIncludePath(lvglVersion);

			// Generate main.c
			const mainPath = path.join(this.buildPath, 'main.c');
			MainTemplate.generateMainFile(mainPath);

			// Create an output directory for this file
			const fileName = path.basename(fileUri.fsPath, '.c');
			const outputDir = path.join(this.buildPath, fileName);

			if (!fs.existsSync(outputDir)) {
				fs.mkdirSync(outputDir, { recursive: true });
			}

			// Compile a user file with objects
			const result = await this.emccWrapper.compileWithObjects(
				fileUri.fsPath,
				outputDir,
				objectFiles,
				lvglIncludePath,
				mainPath
			);

			// Update diagnostics
			this.updateDiagnostics(fileUri, result);

			if (result.success) {
				this.outputChannel.appendLine('Compilation successful!');
			} else {
				this.outputChannel.appendLine('Compilation failed');
				result.errors.forEach((err) => {
					this.outputChannel.appendLine(`  ${err.file}:${err.line}:${err.column}: ${err.message}`);
				});
			}

			return result;
		} catch (error) {
			this.outputChannel.appendLine(`Compilation error: ${error}`);
			return {
				success: false,
				errors: [
					{
						file: fileUri.fsPath,
						line: 1,
						column: 1,
						message: `Compilation failed: ${error}`,
						severity: 'error',
					},
				],
				warnings: [],
			};
		}
	}

	/**
	 * @brief Updates VS Code diagnostics collection with compilation results.
	 *
	 * Converts compilation errors and warnings into VS Code Diagnostic objects
	 * and associates them with the source file for display in the Problems panel.
	 *
	 * @param fileUri URI of the source file to associate diagnostics with.
	 * @param result CompilationResult containing errors and warnings to display.
	 */
	private updateDiagnostics(fileUri: vscode.Uri, result: CompilationResult): void {
		const diagnostics: vscode.Diagnostic[] = [];

		// Add errors
		for (const error of result.errors) {
			const range = new vscode.Range(error.line - 1, error.column - 1, error.line - 1, error.column + 10);

			const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);

			diagnostics.push(diagnostic);
		}

		// Add warnings
		for (const warning of result.warnings) {
			const range = new vscode.Range(warning.line - 1, warning.column - 1, warning.line - 1, warning.column + 10);

			const diagnostic = new vscode.Diagnostic(range, warning.message, vscode.DiagnosticSeverity.Warning);

			diagnostics.push(diagnostic);
		}

		this.diagnosticCollection.set(fileUri, diagnostics);
	}

	/**
	 * @brief Clears all diagnostics from the collection.
	 *
	 * Removes all previously reported errors and warnings from the Problems panel.
	 */
	public clearDiagnostics(): void {
		this.diagnosticCollection.clear();
	}

	/**
	 * @brief Clears all cached build artifacts.
	 *
	 * Removes cached LVGL library objects and clears the build directory.
	 * Useful when forcing a complete rebuild or troubleshooting compilation issues.
	 *
	 * @returns Promise that resolves when cache clearing is complete.
	 */
	public async clearCache(): Promise<void> {
		this.libraryBuilder.clearCache();
	}

	/**
	 * @brief Disposes of managed resources.
	 *
	 * Cleans up the diagnostic collection. Called when the extension is deactivated.
	 */
	public dispose(): void {
		this.diagnosticCollection.dispose();
	}
}
