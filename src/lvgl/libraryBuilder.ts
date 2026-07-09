import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { VersionManager } from './versionManager';
import { ConfigGenerator } from './configGenerator';
import { LvDriversConfigGenerator } from './lvDriversConfigGenerator';
import { EmccWrapper } from '../compiler/emccWrapper';
import { SettingsManager } from '../utils/settingsManager';

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
	private readonly context: vscode.ExtensionContext;

	/**
	 * @constructor
	 * @brief Creates a new LibraryBuilder instance.
	 *
	 * @param {vscode.ExtensionContext} context - The VS Code extension context.
	 * @param {vscode.OutputChannel} outputChannel - The output channel for logging.
	 */
	constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.context = context;
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
		const settings = SettingsManager.getSettings(this.context);
		const optimization = settings.emccOptimization;
		const displayWidth = settings.displayWidth;
		const displayHeight = settings.displayHeight;
		const lvglMemorySize = settings.lvglMemorySize;

		// Detect if lv_drivers are needed (for v8) and add to the cache key
		const majorVersion = parseInt(version.split('.')[0], 10);
		const needsLvDrivers = majorVersion < 9;
		const driversSuffix = needsLvDrivers ? '_with_lvdrivers' : '';

		// Cache-key strategy (bump the version to invalidate older caches when the
		// build changes):
		// v2: SDL drivers compiled during final linking (not pre-compiled)
		// v3: Added lvglMemorySize to the cache key
		// v4: Removed display dimensions from the cache key - they do not affect the
		//     compiled LVGL objects (the driver applies resolution at runtime),
		//     so changing the dimensions now reuses the cached library and only
		//     triggers a relink instead of a full rebuild.
		const buildVersion = 'v4';
		const cacheKey = `${version}_${optimization}_mem${lvglMemorySize}${driversSuffix}_${buildVersion}`;
		const objDir = path.join(this.cachePath, `obj_${cacheKey}`);
		const markerFile = path.join(objDir, '.build_complete');

		// Always ensure the LVGL sources are present and (re)write the configuration
		// headers for the CURRENT dimensions - even on a cache hit - so the final link
		// (main.c, and for v8 the SDL driver sources) sees the latest resolution.
		const { versionPath, lvDriversPath } = await this.prepareLvglConfig(
			version,
			cacheKey,
			displayWidth,
			displayHeight,
			lvglMemorySize,
			needsLvDrivers
		);

		// Reuse cached object files when available.
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

				// Compile LVGL source files. The lv_drivers SDL source files are NOT
				// pre-compiled here - they require SDL2 headers only available during the
				// final link (USE_SDL=2), so they are compiled in compilationManager.ts.
				const objectFiles = await this.emccWrapper.compileToObjects(
					sourceFiles,
					objDir,
					includePaths,
					optimization
				);

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
	 * @brief Ensures LVGL sources exist and installs configuration headers for the
	 *        current display settings.
	 *
	 * Runs on every build, including cache hits. Display dimensions are intentionally
	 * excluded from the object cache key because they do not affect the compiled LVGL
	 * objects, but the final link step compiles main.c (and, for v8, the SDL driver
	 * sources) against these headers and must therefore see the current resolution.
	 *
	 * @param version LVGL version being built.
	 * @param cacheKey Current cache key (used to name the generated config files).
	 * @param displayWidth Display width in pixels.
	 * @param displayHeight Display height in pixels.
	 * @param lvglMemorySize LVGL heap size in KB.
	 * @param needsLvDrivers Whether the (v8) lv_drivers config must be prepared.
	 * @returns The resolved LVGL source path and, for v8, the lv_drivers path.
	 */
	private async prepareLvglConfig(
		version: string,
		cacheKey: string,
		displayWidth: number,
		displayHeight: number,
		lvglMemorySize: number,
		needsLvDrivers: boolean
	): Promise<{ versionPath: string; lvDriversPath: string | null }> {
		const versionPath = await this.versionManager.ensureVersion(version);

		// Generate lv_conf.h and install it into the LVGL source tree.
		const configPath = path.join(this.cachePath, `lv_conf_${cacheKey}.h`);
		ConfigGenerator.generateLvConf(configPath, displayWidth, displayHeight, lvglMemorySize);
		fs.copyFileSync(configPath, path.join(versionPath, 'lv_conf.h'));

		let lvDriversPath: string | null = null;
		if (needsLvDrivers) {
			lvDriversPath = await this.versionManager.ensureLvDrivers();

			// Generate lv_drv_conf.h and copy it into the lv_drivers directory (which is
			// on the compiler include path).
			const drvConfigPath = path.join(this.cachePath, `lv_drv_conf_${cacheKey}.h`);
			LvDriversConfigGenerator.generateLvDrvConf(drvConfigPath, displayWidth, displayHeight);
			fs.copyFileSync(drvConfigPath, path.join(lvDriversPath, 'lv_drv_conf.h'));

			// lv_drivers expects to include "lvgl/lvgl.h" - copy LVGL in once.
			const lvglInDriversPath = path.join(lvDriversPath, 'lvgl');
			if (!fs.existsSync(lvglInDriversPath)) {
				this.outputChannel.appendLine('Copying LVGL to lv_drivers for include compatibility...');
				fs.cpSync(versionPath, lvglInDriversPath, { recursive: true });
			}
		}

		return { versionPath, lvDriversPath };
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
