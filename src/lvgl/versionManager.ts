import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import AdmZip = require('adm-zip');
import { downloadFile } from '../utils/downloadHelper';

/**
 * @class VersionManager
 * @brief Manages LVGL library versions for the extension.
 *
 * @description
 * This class handles:
 * - Downloading specific LVGL versions from GitHub releases
 * - Caching downloaded versions in the extension's global storage
 * - Providing access to source files and include paths for compilation
 */
export class VersionManager {
	private readonly lvglPath: string;
	private readonly lvDriversPath: string;
	private outputChannel: vscode.OutputChannel;

	/**
	 * @constructor
	 * @brief Creates a new VersionManager instance.
	 *
	 * @param {vscode.ExtensionContext} _context - The VS Code extension context (unused but kept for API consistency).
	 * @param {vscode.OutputChannel} outputChannel - The output channel for logging.
	 */
	constructor(_context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.lvglPath = path.join(_context.globalStorageUri.fsPath, 'lvgl');
		this.lvDriversPath = path.join(_context.globalStorageUri.fsPath, 'lv_drivers');

		// Ensure directories exist
		if (!fs.existsSync(this.lvglPath)) {
			fs.mkdirSync(this.lvglPath, { recursive: true });
		}
		if (!fs.existsSync(this.lvDriversPath)) {
			fs.mkdirSync(this.lvDriversPath, { recursive: true });
		}
	}

	/**
	 * @brief Ensures a specific LVGL version is available locally.
	 *
	 * Checks if the requested version is already downloaded; if not, downloads it
	 * from the official LVGL GitHub repository.
	 *
	 * @param {string} version - The LVGL version to ensure (e.g., "8.3.0").
	 * @returns {Promise<string>} The local filesystem path to the version directory.
	 *
	 * @example
	 * const versionPath = await versionManager.ensureVersion('8.3.0');
	 */
	public async ensureVersion(version: string): Promise<string> {
		const versionPath = path.join(this.lvglPath, version);

		if (fs.existsSync(versionPath)) {
			this.outputChannel.appendLine(`LVGL ${version} already downloaded`);
			return versionPath;
		}

		this.outputChannel.appendLine(`Downloading LVGL ${version}...`);
		await this.downloadVersion(version);

		return versionPath;
	}

	/**
	 * @brief Downloads a specific LVGL version from GitHub.
	 *
	 * @param {string} version - The LVGL version to download.
	 * @returns {Promise<void>} Resolves when the download and extraction are complete.
	 */
	private async downloadVersion(version: string): Promise<void> {
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Downloading LVGL ${version}`,
				cancellable: false,
			},
			async (progress) => {
				const versionPath = path.join(this.lvglPath, version);
				const zipPath = path.join(this.lvglPath, `${version}.zip`);

				// Download from GitHub releases
				const downloadUrl = `https://github.com/lvgl/lvgl/archive/refs/tags/v${version}.zip`;

				progress.report({ message: 'Downloading...' });

				await downloadFile(downloadUrl, zipPath, (percent) => {
					progress.report({
						message: `Downloading... ${percent}%`,
						increment: 1,
					});
				});

				progress.report({ message: 'Extracting...' });
				this.outputChannel.appendLine('Extracting LVGL...');

				const zip = new AdmZip(zipPath);
				zip.extractAllTo(this.lvglPath, true);

				// Rename extracted folder to version name
				const extractedFolder = path.join(this.lvglPath, `lvgl-${version}`);
				if (fs.existsSync(extractedFolder)) {
					fs.renameSync(extractedFolder, versionPath);
				}

				// Clean up zip file
				fs.unlinkSync(zipPath);

				this.outputChannel.appendLine(`LVGL ${version} downloaded successfully`);
			}
		);
	}

	/**
	 * @brief Gets the local filesystem path for a specific LVGL version.
	 *
	 * @param {string} version - The LVGL version.
	 * @returns {string} The absolute path to the version directory.
	 */
	public getVersionPath(version: string): string {
		return path.join(this.lvglPath, version);
	}

	/**
	 * @brief Gets all C source files for a specific LVGL version.
	 *
	 * Recursively walks the version's src directory to find all .c files
	 * needed for compilation.
	 *
	 * Excludes certain files that are compiled separately:
	 * - LVGL v9+: Excludes SDL driver files (src/drivers/sdl/*.c) - compiled during final linking
	 * - LVGL v8: Excludes lv_hal_tick.c - custom implementation provided in main template
	 *
	 * @param {string} version - The LVGL version.
	 * @returns {string[]} Array of absolute paths to all C source files.
	 */
	public getSourceFiles(version: string): string[] {
		const versionPath = this.getVersionPath(version);
		const srcPath = path.join(versionPath, 'src');

		// Detect LVGL version to determine which files to exclude
		const majorVersion = parseInt(version.split('.')[0], 10);
		const isV9OrLater = majorVersion >= 9;

		const sourceFiles: string[] = [];

		/**
		 * @brief Recursively walks a directory to find all .c files.
		 *
		 * @param {string} dir - Directory to walk.
		 */
		const walkDir = (dir: string) => {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					walkDir(filePath);
				} else if (file.endsWith('.c')) {
					// For LVGL v9+, exclude SDL driver files
					// These files need SDL2 headers which are only available during final linking
					if (isV9OrLater && (filePath.includes(path.join('drivers', 'sdl')) || filePath.includes('drivers/sdl'))) {
						this.outputChannel.appendLine(`Excluding SDL driver from pre-compilation: ${path.basename(filePath)}`);
						continue;
					}

					// For LVGL v8, exclude lv_hal_tick.c
					// The main template provides custom lv_tick_get() and lv_tick_elaps() implementations
					if (!isV9OrLater && (filePath.includes(path.join('hal', 'lv_hal_tick.c')) || filePath.includes('hal/lv_hal_tick.c'))) {
						this.outputChannel.appendLine(`Excluding lv_hal_tick.c from pre-compilation (custom implementation in main template)`);
						continue;
					}

					sourceFiles.push(filePath);
				}
			}
		};

		if (fs.existsSync(srcPath)) {
			walkDir(srcPath);
		}

		return sourceFiles;
	}

	/**
	 * @brief Gets the include path for a specific LVGL version.
	 *
	 * @param {string} version - The LVGL version.
	 * @returns {string} The absolute path to use as an include directory for compilation.
	 */
	public getIncludePath(version: string): string {
		return this.getVersionPath(version);
	}

	/**
	 * @brief Ensures lv_drivers repository is available locally for LVGL v8.
	 *
	 * @description
	 * LVGL v8 requires the separate lv_drivers repository for SDL support.
	 * LVGL v9 has built-in drivers, so this is not needed for v9+.
	 *
	 * Downloads lv_drivers from GitHub if not already cached. Uses the master branch
	 * which is compatible with LVGL v8.x versions.
	 *
	 * @returns {Promise<string>} The local filesystem path to the lv_drivers directory.
	 */
	public async ensureLvDrivers(): Promise<string> {
		const driversPath = path.join(this.lvDriversPath, 'master');

		if (fs.existsSync(driversPath)) {
			this.outputChannel.appendLine('lv_drivers already downloaded');
			return driversPath;
		}

		this.outputChannel.appendLine('Downloading lv_drivers...');
		await this.downloadLvDrivers();

		return driversPath;
	}

	/**
	 * @brief Downloads lv_drivers repository from GitHub.
	 *
	 * @returns {Promise<void>} Resolves when the download and extraction are complete.
	 */
	private async downloadLvDrivers(): Promise<void> {
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Downloading lv_drivers',
				cancellable: false,
			},
			async (progress) => {
				const driversPath = path.join(this.lvDriversPath, 'master');
				const zipPath = path.join(this.lvDriversPath, 'master.zip');

				// Download from GitHub master branch
				const downloadUrl = 'https://github.com/lvgl/lv_drivers/archive/refs/heads/master.zip';

				progress.report({ message: 'Downloading...' });

				await downloadFile(downloadUrl, zipPath, (percent) => {
					progress.report({
						message: `Downloading... ${percent}%`,
						increment: 1,
					});
				});

				progress.report({ message: 'Extracting...' });
				this.outputChannel.appendLine('Extracting lv_drivers...');

				const zip = new AdmZip(zipPath);
				zip.extractAllTo(this.lvDriversPath, true);

				// Rename extracted folder to 'master'
				const extractedFolder = path.join(this.lvDriversPath, 'lv_drivers-master');
				if (fs.existsSync(extractedFolder)) {
					fs.renameSync(extractedFolder, driversPath);
				}

				// Clean up zip file
				fs.unlinkSync(zipPath);

				this.outputChannel.appendLine('lv_drivers downloaded successfully');
			}
		);
	}

	/**
	 * @brief Gets SDL driver source files from lv_drivers (for LVGL v8).
	 *
	 * @description
	 * Returns the paths to SDL driver source files needed for LVGL v8 compilation.
	 * Includes sdl.c (traditional SDL driver with init/flush functions) and
	 * sdl_common.c (common functionality for mouse/keyboard input)
	 *
	 * @returns {string[]} Array of absolute paths to SDL driver source files.
	 */
	public getLvDriversSdlSourceFiles(): string[] {
		const driversPath = path.join(this.lvDriversPath, 'master');
		const sdlPath = path.join(driversPath, 'sdl');

		return [
			path.join(sdlPath, 'sdl.c'),
			path.join(sdlPath, 'sdl_common.c'),
		];
	}

	/**
	 * @brief Gets built-in SDL driver source files from LVGL v9+.
	 *
	 * @description
	 * Returns the paths to SDL driver source files that are built into LVGL v9+.
	 * These files require SDL2 headers and must be compiled during the final
	 * linking phase when Emscripten's SDL2 port is available.
	 *
	 * @param {string} version - The LVGL version.
	 * @returns {string[]} Array of absolute paths to SDL driver source files.
	 */
	public getLvglSdlDriverSourceFiles(version: string): string[] {
		const versionPath = this.getVersionPath(version);
		const sdlPath = path.join(versionPath, 'src', 'drivers', 'sdl');

		return [
			path.join(sdlPath, 'lv_sdl_window.c'),
			path.join(sdlPath, 'lv_sdl_mouse.c'),
			path.join(sdlPath, 'lv_sdl_mousewheel.c'),
			path.join(sdlPath, 'lv_sdl_keyboard.c'),
		];
	}

	/**
	 * @brief Gets the lv_drivers include path.
	 *
	 * @returns {string} The absolute path to use as an include directory for lv_drivers.
	 */
	public getLvDriversIncludePath(): string {
		return path.join(this.lvDriversPath, 'master');
	}
}
