import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EmccWrapper } from './emccWrapper';
import { LibraryBuilder } from '../lvgl/libraryBuilder';
import { VersionManager } from '../lvgl/versionManager';
import { MainTemplate } from '../lvgl/mainTemplate';
import { IntellisenseHelper } from '../utils/intellisenseHelper';
import { CompilationResult, ResolvedProjectConfig } from '../types';
import { DependencyCache } from '../cache/dependencyCache';
import { ConfigLoader } from '../utils/configLoader';

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
	private readonly outputChannel: vscode.OutputChannel;
	private readonly buildPath: string;
	private diagnosticCollection: vscode.DiagnosticCollection;
	private readonly context: vscode.ExtensionContext;
	private dependencyCache: DependencyCache | undefined;
	private currentProjectConfig: ResolvedProjectConfig | null = null;

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
		this.context = context;
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
	 * 1. Loads project configuration if available
	 * 2. Retrieves configuration settings (LVGL version, optimization, display size)
	 * 3. Ensures the specified LVGL version is downloaded
	 * 4. Updates IntelliSense configuration for the workspace
	 * 5. Builds or retrieves cached LVGL object files
	 * 6. Compiles dependencies with caching
	 * 7. Generates the main entry point file
	 * 8. Compiles the user file with LVGL objects and dependencies
	 * 9. Updates VS Code diagnostics with any errors/warnings
	 *
	 * @param fileUri URI of the C source file to compile.
	 * @returns Promise resolving to CompilationResult with success status and any errors/warnings.
	 */
	public async compileUserFile(fileUri: vscode.Uri): Promise<CompilationResult> {
		const config = vscode.workspace.getConfiguration('lvglPreview');
		const lvglVersion = config.get<string>('lvglVersion', '9.2.0');
		const wasmMemorySize = config.get<number>('wasmMemorySize', 128);
		const lvglMemorySize = config.get<number>('lvglMemorySize', 256);

		// Validate memory settings
		const lvglMemoryMB = lvglMemorySize / 1024;
		const minWasmMemory = Math.ceil(lvglMemoryMB + 32); // LVGL heap + 32MB overhead for stack, display buffers, runtime

		if (wasmMemorySize < minWasmMemory) {
			const errorMsg = `Memory configuration error: WASM memory (${wasmMemorySize} MB) is too small for LVGL memory (${lvglMemorySize} KB). ` +
				`Minimum WASM memory required: ${minWasmMemory} MB. ` +
				`Please increase WASM memory size or decrease LVGL memory size in settings.`;
			this.outputChannel.appendLine(`ERROR: ${errorMsg}`);
			vscode.window.showErrorMessage(errorMsg);
			return {
				success: false,
				jsPath: '',
				wasmPath: '',
				errors: [
					{
						file: '',
						line: 0,
						column: 0,
						message: errorMsg,
						severity: 'error',
					},
				],
				warnings: [],
			};
		}

		this.outputChannel.appendLine(`Starting compilation of ${fileUri.fsPath}`);

		try {
			// Load project configuration
			const projectConfig = await ConfigLoader.loadConfig(fileUri, this.outputChannel);
			this.currentProjectConfig = projectConfig;

			// Determine the actual main file to compile
			let mainSourceFile: string;
			let dependencies: string[] = [];
			let userIncludePaths: string[] = [];
			let defines: string[] = [];

			if (projectConfig) {
				mainSourceFile = projectConfig.mainFile;
				dependencies = projectConfig.dependencies;
				userIncludePaths = projectConfig.includePaths;
				defines = projectConfig.defines;

				this.outputChannel.appendLine(`Using project config mode:`);
				this.outputChannel.appendLine(`  Main file: ${mainSourceFile}`);
				this.outputChannel.appendLine(`  Dependencies: ${dependencies.length} files`);
				this.outputChannel.appendLine(`  Include paths: ${userIncludePaths.length} directories`);
				this.outputChannel.appendLine(`  Defines: ${defines.join(', ')}`);

				// Initialize dependency cache
				const projectId = this.getProjectId(projectConfig.configFileDir);
				this.dependencyCache = new DependencyCache(this.context, projectId, this.outputChannel);
			} else {
				// Single file mode
				mainSourceFile = fileUri.fsPath;
				this.outputChannel.appendLine('Using single-file mode');
			}

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

			// For LVGL v8, ensure lv_drivers is available and add its include path
			const majorVersion = parseInt(lvglVersion.split('.')[0], 10);
			if (majorVersion < 9) {
				const lvDriversIncludePath = this.versionManager.getLvDriversIncludePath();
				userIncludePaths.push(lvDriversIncludePath);
				this.outputChannel.appendLine(`Added lv_drivers include path: ${lvDriversIncludePath}`);
			}

			// Compile dependencies if any
			let dependencyObjects: string[] = [];
			if (dependencies.length > 0 && this.dependencyCache) {
				dependencyObjects = await this.compileDependencies(
					dependencies,
					lvglIncludePath,
					config.get<string>('emccOptimization', '-O1'),
					userIncludePaths,
					defines
				);
			}

			// Generate main.c
			const mainPath = path.join(this.buildPath, 'main.c');
			MainTemplate.generateMainFile(mainPath);

			// Create an output directory for this file
			const fileName = path.basename(mainSourceFile, '.c');
			const outputDir = path.join(this.buildPath, fileName);

			if (!fs.existsSync(outputDir)) {
				fs.mkdirSync(outputDir, { recursive: true });
			}

			// Add SDL driver source files to be compiled during final linking
			// These files require SDL2 headers which are only available when USE_SDL=2 triggers the port
			let additionalSourceFiles: string[] = [];
			if (majorVersion >= 9) {
				// LVGL v9+: Use built-in SDL drivers
				additionalSourceFiles = this.versionManager.getLvglSdlDriverSourceFiles(lvglVersion);
				this.outputChannel.appendLine(`Adding ${additionalSourceFiles.length} LVGL v9 SDL driver source files for compilation`);
			} else {
				// LVGL v8: Use lv_drivers SDL drivers
				additionalSourceFiles = this.versionManager.getLvDriversSdlSourceFiles();
				this.outputChannel.appendLine(`Adding ${additionalSourceFiles.length} lv_drivers SDL source files for compilation`);

				// Add LV_CONF_INCLUDE_SIMPLE define for lv_drivers compatibility
				if (!defines.includes('LV_CONF_INCLUDE_SIMPLE')) {
					defines.push('LV_CONF_INCLUDE_SIMPLE');
				}
			}

			// Compile the user file with objects and dependencies
			const result = await this.emccWrapper.compileWithObjects(
				mainSourceFile,
				outputDir,
				objectFiles,
				lvglIncludePath,
				mainPath,
				dependencyObjects,
				userIncludePaths,
				defines,
				additionalSourceFiles,
				wasmMemorySize
			);

			// Update diagnostics
			this.updateDiagnostics(vscode.Uri.file(mainSourceFile), result);

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
	 * @brief Compiles dependency files with caching support.
	 *
	 * @param dependencies Array of dependency file paths
	 * @param lvglIncludePath Path to LVGL include directory
	 * @param optimization Optimization level
	 * @param userIncludePaths Array of user-specified include paths
	 * @param defines Array of preprocessor defines
	 * @returns Array of compiled object file paths
	 */
	private async compileDependencies(
		dependencies: string[],
		lvglIncludePath: string,
		optimization: string,
		userIncludePaths: string[],
		defines: string[]
	): Promise<string[]> {
		if (!this.dependencyCache) {
			throw new Error('Dependency cache not initialized');
		}

		this.outputChannel.appendLine(`Compiling ${dependencies.length} dependencies...`);

		const cacheDir = this.dependencyCache.getCacheDir();
		const validCache = this.dependencyCache.getValidCachedObjects(dependencies);
		const objectFiles: string[] = [];

		// Separate cached and uncached dependencies
		const filesToCompile: string[] = [];
		for (const dep of dependencies) {
			const cachedObj = validCache.get(dep);
			if (cachedObj) {
				this.outputChannel.appendLine(`  ✓ Using cached: ${path.basename(dep)}`);
				objectFiles.push(cachedObj);
			} else {
				filesToCompile.push(dep);
			}
		}

		// Compile uncached dependencies
		if (filesToCompile.length > 0) {
			this.outputChannel.appendLine(`  Compiling ${filesToCompile.length} changed dependencies...`);

			const includePaths = [lvglIncludePath, path.join(lvglIncludePath, 'src'), ...userIncludePaths];
			const compiled = await this.emccWrapper.compileToObjects(
				filesToCompile,
				cacheDir,
				includePaths,
				optimization,
				defines
			);

			// Update cache for newly compiled files
			for (let i = 0; i < filesToCompile.length; i++) {
				const sourcePath = filesToCompile[i];
				const objPath = compiled[i];
				if (objPath && fs.existsSync(objPath)) {
					this.dependencyCache.updateCache(sourcePath, objPath);
					objectFiles.push(objPath);
				}
			}
		}

		this.outputChannel.appendLine(`Dependencies compiled: ${objectFiles.length}/${dependencies.length}`);
		return objectFiles;
	}

	/**
	 * @brief Generates a unique project ID from the config directory path.
	 *
	 * @param configDir Path to the directory containing the config file
	 * @returns Hash-based project ID
	 */
	private getProjectId(configDir: string): string {
		return crypto.createHash('sha256').update(configDir).digest('hex').substring(0, 8);
	}

	/**
	 * @brief Gets the current project configuration.
	 *
	 * @returns Current resolved project config or null
	 */
	public getCurrentConfig(): ResolvedProjectConfig | null {
		return this.currentProjectConfig;
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
	 * Removes cached LVGL library objects, dependency object files, and clears the build directory.
	 * Useful when forcing a complete rebuild or troubleshooting compilation issues.
	 *
	 * @returns Promise that resolves when cache clearing is complete.
	 */
	public async clearCache(): Promise<void> {
		this.libraryBuilder.clearCache();

		// Also clear the dependency cache if it exists
		if (this.dependencyCache) {
			this.dependencyCache.clear();
		}
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
