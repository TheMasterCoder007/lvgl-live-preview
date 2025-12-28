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

		// Ensure lvgl directory exists
		if (!fs.existsSync(this.lvglPath)) {
			fs.mkdirSync(this.lvglPath, { recursive: true });
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
	 * @param {string} version - The LVGL version.
	 * @returns {string[]} Array of absolute paths to all C source files.
	 */
	public getSourceFiles(version: string): string[] {
		const versionPath = this.getVersionPath(version);
		const srcPath = path.join(versionPath, 'src');

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
}
