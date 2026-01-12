import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as util from 'util';
import AdmZip = require('adm-zip');
import { downloadFile } from '../utils/downloadHelper';

const exec = util.promisify(child_process.exec);

/**
 * @class EmsdkInstaller
 * @brief Manages the installation and configuration of the Emscripten SDK.
 *
 * @description
 * This class handles:
 * - Checking if Emscripten is already installed
 * - Downloading and installing the Emscripten SDK
 * - Providing paths to emcc and emsdk root
 */
export class EmsdkInstaller {
	private readonly emsdkPath: string;
	private outputChannel: vscode.OutputChannel;

	/**
	 * @constructor
	 * @brief Creates a new EmsdkInstaller instance.
	 *
	 * @param {vscode.ExtensionContext} context - The VS Code extension context.
	 * @param {vscode.OutputChannel} outputChannel - The output channel for logging.
	 */
	constructor(
		private context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel
	) {
		this.outputChannel = outputChannel;
		this.emsdkPath = path.join(context.globalStorageUri.fsPath, 'emsdk');
	}

	/**
	 * @brief Checks if Python is installed and available in the system PATH.
	 *
	 * @description
	 * Emscripten SDK requires Python to install and activate.
	 * This method checks for Python availability by attempting to run `python --version`.
	 * It tries both 'python' and 'python3' commands.
	 *
	 * @returns {Promise<boolean>} True if Python is installed, false otherwise.
	 */
	private async checkPythonInstallation(): Promise<boolean> {
		const pythonCommands = ['python', 'python3'];

		for (const cmd of pythonCommands) {
			try {
				const { stdout } = await exec(`${cmd} --version`);
				this.outputChannel.appendLine(`Found Python: ${stdout.trim()}`);
				return true;
			} catch (error) {
				// Try the next command
			}
		}

		return false;
	}

	/**
	 * @brief Checks if Windows long path support is enabled.
	 *
	 * @description
	 * Queries the Windows registry to determine if LongPathsEnabled is set to 1.
	 * This is only relevant on Windows platforms.
	 *
	 * @returns {Promise<boolean>} True if long path support is enabled, false otherwise.
	 */
	private async checkLongPathSupport(): Promise<boolean> {
		// Only check on Windows
		if (process.platform !== 'win32') {
			return true; // Non-Windows systems don't have this limitation
		}

		try {
			const { stdout } = await exec(
				'powershell -Command "(Get-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\').LongPathsEnabled"'
			);
			return stdout.trim() === '1';
		} catch (error) {
			// If we can't check, assume it's not enabled
			return false;
		}
	}

	/**
	 * @brief Checks if the Emscripten SDK is properly installed and functional.
	 *
	 * @description
	 * Verifies the installation by:
	 * 1. Checking if the emsdk directory exists
	 * 2. Checking if the emcc executable exists
	 * 3. Running `emcc --version` to verify functionality
	 *
	 * @returns {Promise<boolean>} True if Emscripten is installed and working, false otherwise.
	 */
	public async checkInstallation(): Promise<boolean> {
		try {
			// Check if emsdk directory exists
			if (!fs.existsSync(this.emsdkPath)) {
				return false;
			}

			// Check if emcc exists and is executable
			const emccPath = this.getEmccPath();
			if (!fs.existsSync(emccPath)) {
				return false;
			}

			// Try to run emcc --version
			const { stdout } = await exec(`"${emccPath}" --version`);
			this.outputChannel.appendLine(`Emscripten version: ${stdout.trim()}`);
			return true;
		} catch (error) {
			this.outputChannel.appendLine(`Emscripten check failed: ${error}`);
			return false;
		}
	}

	/**
	 * @brief Downloads and installs the Emscripten SDK.
	 *
	 * @description
	 * Performs a complete installation including:
	 * 1. Downloading the emsdk archive from GitHub
	 * 2. Extracting the archive
	 * 3. Running `emsdk install latest`
	 * 4. Running `emsdk activate latest`
	 *
	 * @returns {Promise<void>} Resolves when installation is complete.
	 * @throws {Error} If any step of the installation fails.
	 */
	public async installEmsdk(): Promise<void> {
		// Check Python before starting installation
		const hasPython = await this.checkPythonInstallation();
		if (!hasPython) {
			const errorMessage =
				'Python is required to install Emscripten SDK. Please install Python and add it to your system PATH.';
			this.outputChannel.appendLine(`ERROR: ${errorMessage}`);
			vscode.window.showErrorMessage(errorMessage, 'Download Python').then((selection) => {
				if (selection === 'Download Python') {
					vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
				}
			});
			throw new Error(errorMessage);
		}

		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Installing Emscripten SDK',
				cancellable: false,
			},
			async (progress) => {
				try {
					// Create emsdk directory
					if (!fs.existsSync(this.emsdkPath)) {
						fs.mkdirSync(this.emsdkPath, { recursive: true });
					}

					progress.report({ message: 'Downloading emsdk...' });
					this.outputChannel.appendLine('Downloading Emscripten SDK...');

					const emsdkVersion = '3.1.50'; // Use a stable version
					const downloadUrl = this.getDownloadUrl(emsdkVersion);

					const zipPath = path.join(this.emsdkPath, 'emsdk.zip');
					await downloadFile(downloadUrl, zipPath, (percent) => {
						progress.report({
							message: `Downloading... ${percent}%`,
							increment: 1,
						});
					});

					progress.report({ message: 'Extracting emsdk...' });
					this.outputChannel.appendLine('Extracting Emscripten SDK...');
					await this.extractZip(zipPath, this.emsdkPath);

					// Clean up zip file
					fs.unlinkSync(zipPath);

					// Set execute permissions on emsdk script for Unix-like systems
					if (process.platform !== 'win32') {
						const emsdkScript = path.join(this.getEmsdkRoot(), 'emsdk');
						this.outputChannel.appendLine(`Setting execute permissions on ${emsdkScript}`);
						fs.chmodSync(emsdkScript, 0o755);
					}

					progress.report({ message: 'Installing SDK...' });
					this.outputChannel.appendLine('Installing Emscripten SDK...');
					await this.runEmsdkCommand('install', 'latest');

					progress.report({ message: 'Activating SDK...' });
					this.outputChannel.appendLine('Activating Emscripten SDK...');
					await this.runEmsdkCommand('activate', 'latest');

					this.outputChannel.appendLine('Emscripten SDK installed successfully!');
					vscode.window.showInformationMessage('Emscripten SDK installed successfully!');
				} catch (error) {
					this.outputChannel.appendLine(`Installation failed: ${error}`);
					throw new Error(`Failed to install Emscripten SDK: ${error}`);
				}
			}
		);
	}

	/**
	 * @brief Constructs the download URL for a specific emsdk version.
	 *
	 * @param {string} version - The emsdk version to download.
	 * @returns {string} The GitHub release URL for the specified version.
	 */
	private getDownloadUrl(version: string): string {
		const baseUrl = 'https://github.com/emscripten-core/emsdk/archive/refs/tags';
		return `${baseUrl}/${version}.zip`;
	}

	/**
	 * @brief Gets the path to the emcc executable.
	 *
	 * @returns {string} The absolute path to emcc (or emcc.bat on Windows).
	 */
	public getEmccPath(): string {
		const platform = process.platform;
		const emsdkRoot = path.join(this.emsdkPath, 'emsdk-3.1.50');

		if (platform === 'win32') {
			return path.join(emsdkRoot, 'upstream', 'emscripten', 'emcc.bat');
		} else {
			return path.join(emsdkRoot, 'upstream', 'emscripten', 'emcc');
		}
	}

	/**
	 * @brief Gets the root path of the emsdk installation.
	 *
	 * @returns {string} The absolute path to the emsdk root directory.
	 */
	public getEmsdkRoot(): string {
		return path.join(this.emsdkPath, 'emsdk-3.1.50');
	}

	/**
	 * @brief Runs an emsdk command with the specified arguments.
	 *
	 * @param {...string} args - Command arguments to pass to emsdk.
	 * @returns {Promise<void>} Resolves when the command completes successfully.
	 * @throws {Error} If the command fails.
	 */
	private async runEmsdkCommand(...args: string[]): Promise<void> {
		const emsdkScript = process.platform === 'win32' ? 'emsdk.bat' : './emsdk';
		const emsdkRoot = this.getEmsdkRoot();
		const cmd = `cd "${emsdkRoot}" && ${emsdkScript} ${args.join(' ')}`;

		this.outputChannel.appendLine(`Running: ${cmd}`);

		let hasPythonError = false;
		let hasSllCertError = false;
		let emccInstallationFailed = false;
		let longPathError = false;
		try {
			const { stdout, stderr } = await exec(cmd, {
				shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
			});

			if (stdout) {
				this.outputChannel.appendLine(stdout);
			}
			if (stderr) {
				this.outputChannel.appendLine(`stderr: ${stderr}`);
			}

			// Check for Python-related errors in the combined output
			const combinedOutput = `${stdout || ''} ${stderr || ''}`.toLowerCase();
			if (
				combinedOutput.includes('python') &&
				(combinedOutput.includes('not found') ||
					combinedOutput.includes('command not found') ||
					combinedOutput.includes('is not recognized'))
			) {
				hasPythonError = true;
			}

			// Check for SSL certificate errors
			if (combinedOutput.includes('ssl') && combinedOutput.includes('certificate_verify_failed')) {
				hasSllCertError = true;
			}

			// Check for long path errors (including WinError 3 during extraction)
			if (
				combinedOutput.includes('path too long') ||
				combinedOutput.includes('specified path is too long') ||
				combinedOutput.includes('path is too deep') ||
				(combinedOutput.includes('[winerror 3]') &&
					combinedOutput.includes('system cannot find the path specified') &&
					(combinedOutput.includes('unzip') || combinedOutput.includes('extract')))
			) {
				longPathError = true;
			}

			// Check for installation failures
			if (combinedOutput.includes('installation failed') || combinedOutput.includes('error: error:')) {
				emccInstallationFailed = true;
			}
		} catch (error: unknown) {
			const execError = error as { message: string; stdout?: string; stderr?: string };
			this.outputChannel.appendLine(`Command failed: ${execError.message}`);
			if (execError.stdout) {
				this.outputChannel.appendLine(`stdout: ${execError.stdout}`);
			}
			if (execError.stderr) {
				this.outputChannel.appendLine(`stderr: ${execError.stderr}`);
			}

			// Check for Python-related errors in error output
			const fullOutput = `${execError.message} ${execError.stdout || ''} ${execError.stderr || ''}`.toLowerCase();
			if (
				fullOutput.includes('python') &&
				(fullOutput.includes('not found') ||
					fullOutput.includes('command not found') ||
					fullOutput.includes('is not recognized'))
			) {
				hasPythonError = true;
			} else {
				throw error;
			}
		}

		// Throw Python error
		if (hasPythonError) {
			throw new Error('Python is required but not found. Please install Python and add it to your system PATH.');
		}

		// Throw Python SSL Certificate error
		if (hasSllCertError) {
			throw new Error(
				'SSL certificate verification failed. Please fix Python SSL certificates by running: python -m pip install --upgrade certifi'
			);
		}

		// Throw emcc installation error
		if (emccInstallationFailed) {
			throw new Error('Emscripten SDK installation failed. Check the output above for details.');
		}

		// Throw-long path error
		if (longPathError) {
			const longPathEnabled = await this.checkLongPathSupport();

			if (!longPathEnabled) {
				throw new Error(
					'Installation failed due to long file paths. Please enable Windows long path support:\n\n' +
						'1. Run PowerShell as Administrator\n' +
						'2. Execute: New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force\n' +
						'3. Restart your computer\n' +
						'4. Try the installation again\n\n' +
						'Alternatively, enable it via Group Policy:\n' +
						'Computer Configuration > Administrative Templates > System > Filesystem > Enable Win32 long paths'
				);
			} else {
				throw new Error(
					'Installation failed due to long file paths even though Windows long path support is enabled. ' +
						'This may be a Node.js limitation. Please try restarting your computer if you recently enabled long path support.'
				);
			}
		}
	}

	/**
	 * @brief Extracts a ZIP archive to the specified destination.
	 *
	 * @param {string} zipPath - Path to the ZIP file.
	 * @param {string} destPath - Destination directory for extraction.
	 * @returns {Promise<void>} Resolves when extraction is complete.
	 */
	private async extractZip(zipPath: string, destPath: string): Promise<void> {
		const zip = new AdmZip(zipPath);
		zip.extractAllTo(destPath, true);
	}
}
