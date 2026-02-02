import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { VersionManager } from './versionManager';
import { ConfigGenerator } from './configGenerator';
import { LvDriversConfigGenerator } from './lvDriversConfigGenerator';
import { EmccWrapper } from '../compiler/emccWrapper';

/**
 * @class LibraryBuilder
 * @brief Manages the building and caching of LVGL library object files.
 *
 * @description
 * This class handles:
 * - Compiling LVGL source files to object files using Emscripten
 * - Caching compiled object files for reuse
 * - Managing cache invalidation based on version, optimization, and display settings
 *
 */
export class LibraryBuilder {
	private versionManager: VersionManager;
	private emccWrapper: EmccWrapper;
	private outputChannel: vscode.OutputChannel;
	private readonly cachePath: string;

	/**
	 * @constructor
	 * @brief Creates a new LibraryBuilder instance.
	 *
	 * @param {vscode.ExtensionContext} context - The VS Code extension context.
	 * @param {vscode.OutputChannel} outputChannel - The output channel for logging.
	 */
	constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.versionManager = new VersionManager(context, outputChannel);
		this.emccWrapper = new EmccWrapper(context, outputChannel);
		this.cachePath = path.join(context.globalStorageUri.fsPath, 'cache');

		if (!fs.existsSync(this.cachePath)) {
			fs.mkdirSync(this.cachePath, { recursive: true });
		}
	}

	/**
	 * @brief Builds LVGL library object files for the specified version.
	 *
	 * @description
	 * This method performs the following steps:
	 * 1. Checks if cached object files exist for the current configuration
	 * 2. If not cached, downloads the LVGL version if necessary
	 * 3. Generates the lv_conf.h configuration file
	 * 4. Compiles all LVGL source files to object files
	 * 5. Caches the results for future builds
	 *
	 * The cache key is based on version, optimization level, and display dimensions.
	 *
	 * @param {string} version - The LVGL version to build (e.g., "8.3.0").
	 * @returns {Promise<string[]>} Array of paths to the compiled object files.
	 * @throws {Error} If compilation fails or no object files are produced.
	 */
	public async buildLibrary(version: string): Promise<string[]> {
		const config = vscode.workspace.getConfiguration('lvglPreview');
		const optimization = config.get<string>('emccOptimization', '-O2');
		const displayWidth = config.get<number>('displayWidth', 480);
		const displayHeight = config.get<number>('displayHeight', 320);
		const lvglMemorySize = config.get<number>('lvglMemorySize', 256);

		// Detect if lv_drivers are needed (for v8) and add to the cache key
		const majorVersion = parseInt(version.split('.')[0], 10);
		const needsLvDrivers = majorVersion < 9;
		const driversSuffix = needsLvDrivers ? '_with_lvdrivers' : '';

		// Add a build strategy version to the cache key to invalidate old caches when compilation changes
		// v2: SDL drivers compiled during final linking (not pre-compiled)
		// v3: Added lvglMemorySize to the cache key
		const buildVersion = 'v3';
		const cacheKey = `${version}_${optimization}_${displayWidth}x${displayHeight}_mem${lvglMemorySize}${driversSuffix}_${buildVersion}`;
		const objDir = path.join(this.cachePath, `obj_${cacheKey}`);
		const markerFile = path.join(objDir, '.build_complete');

		// Check if object files are already built
		if (fs.existsSync(markerFile)) {
			this.outputChannel.appendLine(`Using cached LVGL objects: ${objDir}`);
			const objectFiles = this.getObjectFiles(objDir);
			this.outputChannel.appendLine(`Found ${objectFiles.length} cached object files`);
			return objectFiles;
		}

		this.outputChannel.appendLine(`Building LVGL object files for version ${version}...`);

		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Building LVGL ${version}`,
				cancellable: false,
			},
			async (progress) => {
				// Ensure LVGL version is downloaded
				progress.report({ message: 'Downloading LVGL...' });
				const versionPath = await this.versionManager.ensureVersion(version);

				// Detect LVGL major version to determine if we need lv_drivers
				const majorVersion = parseInt(version.split('.')[0], 10);
				const needsLvDrivers = majorVersion < 9;

				// Generate lv_conf.h
				progress.report({ message: 'Generating configuration...' });
				const configPath = path.join(this.cachePath, `lv_conf_${cacheKey}.h`);
				ConfigGenerator.generateLvConf(configPath, displayWidth, displayHeight, lvglMemorySize);

				// Copy lv_conf.h to LVGL directory
				const lvglConfigPath = path.join(versionPath, 'lv_conf.h');
				fs.copyFileSync(configPath, lvglConfigPath);

				// For LVGL v8, download and configure lv_drivers
				let lvDriversPath: string | null = null;
				let lvDriversSourceFiles: string[] = [];
				if (needsLvDrivers) {
					progress.report({ message: 'Downloading lv_drivers...' });
					lvDriversPath = await this.versionManager.ensureLvDrivers();

					// Generate lv_drv_conf.h
					const drvConfigPath = path.join(this.cachePath, `lv_drv_conf_${cacheKey}.h`);
					LvDriversConfigGenerator.generateLvDrvConf(drvConfigPath, displayWidth, displayHeight);

					// Copy lv_drv_conf.h directly to lv_drivers/master directory
					// The compiler include path is set to lv_drivers/master, so the file needs to be there
					const lvDriversConfigPath = path.join(lvDriversPath, 'lv_drv_conf.h');
					fs.copyFileSync(drvConfigPath, lvDriversConfigPath);
					this.outputChannel.appendLine(`Copied lv_drv_conf.h to: ${lvDriversConfigPath}`);

					// Copy LVGL to lv_drivers/lvgl for include compatibility
					// lv_drivers expects: #include "lvgl/lvgl.h"
					const lvglInDriversPath = path.join(lvDriversPath, 'lvgl');
					if (!fs.existsSync(lvglInDriversPath)) {
						this.outputChannel.appendLine(`Copying LVGL to lv_drivers for include compatibility...`);
						fs.cpSync(versionPath, lvglInDriversPath, { recursive: true });
						this.outputChannel.appendLine(`Copied LVGL to: ${lvglInDriversPath}`);
					}

					// Get SDL driver source files
					lvDriversSourceFiles = this.versionManager.getLvDriversSdlSourceFiles();
					this.outputChannel.appendLine(`Found ${lvDriversSourceFiles.length} lv_drivers SDL source files`);
				}

				// Create an object directory
				if (!fs.existsSync(objDir)) {
					fs.mkdirSync(objDir, { recursive: true });
				}

				// Get all LVGL source files
				progress.report({ message: 'Collecting source files...' });
				const sourceFiles = this.versionManager.getSourceFiles(version);
				this.outputChannel.appendLine(`Found ${sourceFiles.length} LVGL source files`);

				// Compile to object files
				progress.report({ message: 'Compiling LVGL...' });

				const includePaths = [versionPath, path.join(versionPath, 'src')];
				if (lvDriversPath) {
					includePaths.push(lvDriversPath);
				}

				// Compile LVGL source files
				const objectFiles = await this.emccWrapper.compileToObjects(
					sourceFiles,
					objDir,
					includePaths,
					optimization
				);

				// Note: lv_drivers SDL source files are NOT pre-compiled here
				// They require SDL2 headers which are only available during final linking
				// when -s USE_SDL=2 triggers Emscripten's SDL2 port download
				// The SDL driver source files will be compiled in compilationManager.ts during final linking
				if (lvDriversSourceFiles.length > 0) {
					this.outputChannel.appendLine(
						`Found ${lvDriversSourceFiles.length} lv_drivers SDL source files (will compile during final linking)`
					);
				}

				if (objectFiles.length === 0) {
					throw new Error('Failed to compile LVGL object files');
				}

				// Write a marker file to indicate a successful build
				fs.writeFileSync(markerFile, new Date().toISOString());

				this.outputChannel.appendLine(`Build completed successfully: ${objectFiles.length} total object files`);
				return objectFiles;
			}
		);
	}

	/**
	 * @brief Retrieves all object files from a directory.
	 *
	 * @param {string} dir - The directory to search for object files.
	 * @returns {string[]} Array of absolute paths to object files (*.o).
	 */
	private getObjectFiles(dir: string): string[] {
		const files: string[] = [];
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith('.o')) {
				files.push(fullPath);
			}
		}

		return files;
	}

	/**
	 * @brief Clears all cached library files and object directories.
	 *
	 * @description
	 * Removes all files in the cache directory, including
	 * - Compiled object files
	 * - Static library archives
	 * - Configuration files
	 * - Build marker files
	 *
	 * This forces a full rebuild on the next build request.
	 */
	public clearCache(): void {
		if (fs.existsSync(this.cachePath)) {
			const files = fs.readdirSync(this.cachePath);
			for (const file of files) {
				const filePath = path.join(this.cachePath, file);
				try {
					fs.rmSync(filePath, { recursive: true });
				} catch (error) {
					this.outputChannel.appendLine(`Failed to delete ${filePath}: ${error}`);
				}
			}
			this.outputChannel.appendLine('Cache cleared');
		}
	}
}
