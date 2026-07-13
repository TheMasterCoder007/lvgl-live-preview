import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EmccWrapper } from './emccWrapper';
import { LibraryBuilder } from '../lvgl/libraryBuilder';
import { VersionManager } from '../lvgl/versionManager';
import { MainTemplate } from '../lvgl/mainTemplate';
import { IntellisenseHelper } from '../utils/intellisenseHelper';
import { CompilationResult, CompilerError, ResolvedProjectConfig } from '../types';
import { DependencyCache, CompilationSettings } from '../cache/dependencyCache';
import { ConfigLoader } from '../utils/configLoader';
import { ProjectResolver } from '../utils/projectResolver';
import { SettingsManager } from '../utils/settingsManager';

/**
 * @class DependencyCompilationError
 * @brief Thrown when one or more dependency sources fail to compile.
 *
 * Carries the parsed diagnostics so the caller can report them as a normal
 * compilation failure (Problems panel + preview error card) instead of letting a
 * broken dependency vanish into the output channel.
 */
class DependencyCompilationError extends Error {
	public readonly errors: CompilerError[];

	constructor(errors: CompilerError[]) {
		super('One or more dependencies failed to compile');
		this.name = 'DependencyCompilationError';
		this.errors = errors;
	}
}

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
		const settings = SettingsManager.getSettings(this.context);
		const lvglVersion = settings.lvglVersion;
		const wasmMemorySize = settings.wasmMemorySize;
		const lvglMemorySize = settings.lvglMemorySize;

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
			// Load project configuration. An explicit .lvgl-live-preview.json takes
			// precedence; otherwise the layout is auto-detected (entry point + local
			// include graph), which always yields a config, so there is no separate
			// single-file mode to handle downstream.
			let projectConfig = await ConfigLoader.loadConfig(fileUri, this.outputChannel);
			if (projectConfig) {
				this.outputChannel.appendLine(
					'Found .lvgl-live-preview.json — using it and overriding automatic detection:'
				);
			} else {
				this.outputChannel.appendLine(
					'No .lvgl-live-preview.json found; auto-detecting project layout.'
				);
				projectConfig = ProjectResolver.resolve(fileUri, this.outputChannel);
			}
			this.currentProjectConfig = projectConfig;

			// Determine the actual main file to compile
			const mainSourceFile = projectConfig.mainFile;
			const dependencies = projectConfig.dependencies;
			const userIncludePaths = projectConfig.includePaths;
			const defines = projectConfig.defines;

			this.outputChannel.appendLine(`  Main file: ${mainSourceFile}`);
			this.outputChannel.appendLine(`  Dependencies: ${dependencies.length} files`);
			this.outputChannel.appendLine(`  Include paths: ${userIncludePaths.length} directories`);
			this.outputChannel.appendLine(`  Defines: ${defines.join(', ')}`);

			// Initialize the dependency cache with settings
			const projectId = this.getProjectId(projectConfig.configFileDir);
			const compilationSettings: CompilationSettings = {
				lvglVersion,
				optimization: settings.emccOptimization,
				lvglMemorySize,
				wasmMemorySize,
				includePaths: userIncludePaths,
				defines,
			};
			this.dependencyCache = new DependencyCache(
				this.context,
				projectId,
				this.outputChannel,
				compilationSettings
			);

			// Ensure LVGL version is downloaded
			const lvglPath = await this.versionManager.ensureVersion(lvglVersion);
			this.outputChannel.appendLine(`LVGL path: ${lvglPath}`);

			// Update IntelliSense configuration. Pass the bundled emcc as the compiler
			// and the Emscripten sysroot includes so C++ preview files resolve the C++
			// standard library (and SDL/emscripten headers) in the editor.
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
			await IntellisenseHelper.updateCppProperties(
				lvglPath,
				workspaceFolder,
				this.emccWrapper.getCompilerPath(),
				this.emccWrapper.getSystemIncludePaths()
			);

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

			// Compile dependencies if any. A dependency compile failure throws a
			// DependencyCompilationError, handled by the catch below so it is reported
			// like a main-file failure (Problems panel + preview error card) rather than
			// being swallowed into the log.
			let dependencyObjects: string[] = [];
			if (dependencies.length > 0 && this.dependencyCache) {
				dependencyObjects = await this.compileDependencies(
					dependencies,
					lvglIncludePath,
					settings.emccOptimization,
					userIncludePaths,
					defines
				);
			}

			// Generate main.c
			const mainPath = path.join(this.buildPath, 'main.c');
			MainTemplate.generateMainFile(mainPath);

			// Create an output directory for this file (extension-agnostic so that
			// both foo.c and foo.cpp map to a clean "foo" directory name).
			const fileName = path.parse(mainSourceFile).name;
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

			// Compile the user file with objects and dependencies. Mixed C/C++ needs no
			// special handling here: emcc picks each input's language by extension and
			// links libc++ on demand (see EmccWrapper.compileWithObjects).
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
			// A dependency that failed to compile carries its own parsed diagnostics;
			// surface those (on the offending files) instead of a generic message.
			if (error instanceof DependencyCompilationError) {
				this.outputChannel.appendLine('Dependency compilation failed:');
				error.errors.forEach((err) => {
					this.outputChannel.appendLine(`  ${err.file}:${err.line}:${err.column}: ${err.message}`);
				});

				const result: CompilationResult = {
					success: false,
					errors: error.errors,
					warnings: [],
				};
				this.updateDiagnostics(vscode.Uri.file(fileUri.fsPath), result);
				return result;
			}

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

			// Each result is paired with its own source file, so caching stays correct
			// even when an earlier dependency fails. Cache successes; collect failures.
			const failureErrors: CompilerError[] = [];
			for (const item of compiled) {
				if (item.objectFile && fs.existsSync(item.objectFile)) {
					this.dependencyCache.updateCache(item.sourceFile, item.objectFile);
					objectFiles.push(item.objectFile);
				} else {
					failureErrors.push(...item.errors);
				}
			}

			// A dependency that fails to compile is a real build failure — surface it
			// instead of linking without it (which would either drop functionality or
			// produce a confusing "undefined symbol" error at the final link).
			if (failureErrors.length > 0) {
				throw new DependencyCompilationError(failureErrors);
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
		// Group diagnostics by the file each one actually refers to. A dependency
		// error (e.g. in a helper .c) must land on that file, not on the main file.
		// Errors without a usable file path fall back to the compiled file's URI.
		const byFile = new Map<string, vscode.Diagnostic[]>();

		const add = (
			file: string,
			line: number,
			column: number,
			message: string,
			severity: vscode.DiagnosticSeverity
		): void => {
			const targetPath = file && file.length > 0 ? file : fileUri.fsPath;
			const zeroLine = Math.max(0, line - 1);
			const zeroCol = Math.max(0, column - 1);
			const range = new vscode.Range(zeroLine, zeroCol, zeroLine, zeroCol + 10);

			const list = byFile.get(targetPath) ?? [];
			list.push(new vscode.Diagnostic(range, message, severity));
			byFile.set(targetPath, list);
		};

		for (const error of result.errors) {
			add(error.file, error.line, error.column, error.message, vscode.DiagnosticSeverity.Error);
		}
		for (const warning of result.warnings) {
			add(warning.file, warning.line, warning.column, warning.message, vscode.DiagnosticSeverity.Warning);
		}

		// Replace all previous diagnostics so stale per-file entries don't linger.
		this.diagnosticCollection.clear();
		for (const [targetPath, diagnostics] of byFile) {
			this.diagnosticCollection.set(vscode.Uri.file(targetPath), diagnostics);
		}
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
