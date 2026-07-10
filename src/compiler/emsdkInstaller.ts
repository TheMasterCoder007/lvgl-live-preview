import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import AdmZip from 'adm-zip';
import { downloadFile } from '../utils/downloadHelper';

/**
 * @interface SetupDiagnostic
 * @brief Result of a single environment/setup check performed by the doctor command.
 */
export interface SetupDiagnostic {
	/** Human-readable name of the check. */
	name: string;
	/** Overall status of the check. */
	status: 'pass' | 'warn' | 'fail';
	/** Details / guidance for the check. */
	detail: string;
}

/**
 * @class EmsdkInstaller
 * @brief Manages the installation and configuration of the Emscripten SDK.
 *
 * @description
 * This class handles:
 * - Checking if Emscripten is already installed
 * - Downloading and installing a pinned Emscripten SDK version
 * - Providing paths to emcc and emsdk root
 * - Reporting environment diagnostics (the "Check Setup" doctor)
 */
export class EmsdkInstaller {
	/**
	 * emsdk repository release used for the installer scripts (and install directory name).
	 */
	private static readonly EMSDK_RELEASE = '3.1.50';

	/**
	 * Pinned the Emscripten toolchain version that is installed and activated.
	 *
	 * This is intentionally fixed (not `latest`) so every user gets the same, tested
	 * toolchain and builds are reproducible and shielded from upstream breaking changes.
	 * Bump this only after validating the LVGL v8/v9 SDL builds against the new version.
	 */
	private static readonly EMSCRIPTEN_VERSION = '3.1.50';

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
	 * @brief Runs a shell command, resolving with its output and killing it on cancellation.
	 *
	 * @param command - The command to run.
	 * @param options - Options passed to child_process.exec.
	 * @param token - Optional cancellation token; killing the process when canceled.
	 * @returns The command's stdout/stderr.
	 */
	private execCancellable(
		command: string,
		options: child_process.ExecOptions = {},
		token?: vscode.CancellationToken
	): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			let cancelSub: vscode.Disposable | undefined;
			const child = child_process.exec(command, options, (error, stdout, stderr) => {
				cancelSub?.dispose();
				if (error) {
					reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
				} else {
					resolve({ stdout: String(stdout), stderr: String(stderr) });
				}
			});
			cancelSub = token?.onCancellationRequested(() => {
				this.outputChannel.appendLine('Cancelling running process...');
				child.kill();
				reject(new vscode.CancellationError());
			});
		});
	}

	/**
	 * @brief Returns the installed Python version string, or null if Python is not on PATH.
	 *
	 * Emscripten requires Python 3 both to install the SDK and to run `emcc` (which is a
	 * Python program), so this is checked up front.
	 */
	private async getPythonVersion(): Promise<string | null> {
		for (const cmd of ['python3', 'python']) {
			try {
				const { stdout, stderr } = await this.execCancellable(`${cmd} --version`);
				const version = (stdout || stderr || '').trim();
				this.outputChannel.appendLine(`Found Python: ${version}`);
				return version || cmd;
			} catch {
				// Try the next command
			}
		}
		return null;
	}

	/**
	 * @brief Checks if Windows long path support is enabled (always true on non-Windows).
	 */
	private async checkLongPathSupport(): Promise<boolean> {
		if (process.platform !== 'win32') {
			return true;
		}

		try {
			const { stdout } = await this.execCancellable(
				'powershell -Command "(Get-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\').LongPathsEnabled"'
			);
			return stdout.trim() === '1';
		} catch {
			return false;
		}
	}

	/**
	 * @brief Gets the path to the emcc executable.
	 *
	 * @returns {string} The absolute path to emcc (or emcc.bat on Windows).
	 */
	public getEmccPath(): string {
		const emsdkRoot = this.getEmsdkRoot();
		if (process.platform === 'win32') {
			return path.join(emsdkRoot, 'upstream', 'emscripten', 'emcc.bat');
		}
		return path.join(emsdkRoot, 'upstream', 'emscripten', 'emcc');
	}

	/**
	 * @brief Gets the root path of the emsdk installation.
	 *
	 * @returns {string} The absolute path to the emsdk root directory.
	 */
	public getEmsdkRoot(): string {
		return path.join(this.emsdkPath, `emsdk-${EmsdkInstaller.EMSDK_RELEASE}`);
	}

	/**
	 * @brief Returns the installed emcc version string, or null if emcc isn't available/working.
	 */
	private async getEmccVersion(): Promise<string | null> {
		const emccPath = this.getEmccPath();
		if (!fs.existsSync(emccPath)) {
			return null;
		}

		try {
			const { stdout } = await this.execCancellable(`"${emccPath}" --version`);
			// The first line looks like: "emcc (Emscripten ...) 3.1.50 (<hash>)"
			return stdout.split('\n')[0].trim();
		} catch (error) {
			this.outputChannel.appendLine(`emcc version check failed: ${error}`);
			return null;
		}
	}

	/**
	 * @brief Checks if the Emscripten SDK is properly installed and functional.
	 *
	 * @returns {Promise<boolean>} True if Emscripten is installed and working, false otherwise.
	 */
	public async checkInstallation(): Promise<boolean> {
		if (!fs.existsSync(this.emsdkPath)) {
			return false;
		}

		const version = await this.getEmccVersion();
		if (version) {
			this.outputChannel.appendLine(`Emscripten version: ${version}`);
			return true;
		}
		return false;
	}

	/**
	 * @brief Downloads and installs the pinned Emscripten SDK.
	 *
	 * Any existing (possibly partial) install is removed first so the result is clean,
	 * and the operation is cancellable. On failure or cancellation the partial install is
	 * removed so `checkInstallation()` stays accurate and a retry starts fresh.
	 *
	 * @returns {Promise<void>} Resolves when installation is complete.
	 * @throws {Error} If installation fails, or {vscode.CancellationError} if cancelled.
	 */
	public async installEmsdk(): Promise<void> {
		// Emscripten needs Python both to install and to run emcc.
		const pythonVersion = await this.getPythonVersion();
		if (!pythonVersion) {
			const errorMessage =
				'Python 3 is required to install and run Emscripten. Please install Python and add it to your system PATH.';
			this.outputChannel.appendLine(`ERROR: ${errorMessage}`);
			void vscode.window.showErrorMessage(errorMessage, 'Download Python').then((selection) => {
				if (selection === 'Download Python') {
					void vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
				}
			});
			throw new Error(errorMessage);
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Installing Emscripten SDK',
				cancellable: true,
			},
			async (progress, token) => {
				const controller = new AbortController();
				const cancelSub = token.onCancellationRequested(() => controller.abort());

				try {
					// Start from a clean directory (removes any partial/previous install).
					this.removeInstall();
					fs.mkdirSync(this.emsdkPath, { recursive: true });

					this.throwIfCancelled(token);
					progress.report({ message: 'Downloading emsdk...' });
					this.outputChannel.appendLine('Downloading Emscripten SDK...');

					const downloadUrl = this.getDownloadUrl(EmsdkInstaller.EMSDK_RELEASE);
					const zipPath = path.join(this.emsdkPath, 'emsdk.zip');
					await downloadFile(
						downloadUrl,
						zipPath,
						(percent) => progress.report({ message: `Downloading emsdk... ${percent}%` }),
						controller.signal
					);

					this.throwIfCancelled(token);
					progress.report({ message: 'Extracting emsdk...' });
					this.outputChannel.appendLine('Extracting Emscripten SDK...');
					await this.extractZip(zipPath, this.emsdkPath);
					fs.unlinkSync(zipPath);

					// Set execute permissions on the emsdk script for Unix-like systems.
					if (process.platform !== 'win32') {
						fs.chmodSync(path.join(this.getEmsdkRoot(), 'emsdk'), 0o755);
					}

					this.throwIfCancelled(token);
					progress.report({
						message: `Installing Emscripten ${EmsdkInstaller.EMSCRIPTEN_VERSION} — this downloads ~1–2 GB and can take several minutes...`,
					});
					this.outputChannel.appendLine(`Installing Emscripten ${EmsdkInstaller.EMSCRIPTEN_VERSION}...`);
					await this.runEmsdkCommand(['install', EmsdkInstaller.EMSCRIPTEN_VERSION], token);

					this.throwIfCancelled(token);
					progress.report({ message: 'Activating Emscripten...' });
					this.outputChannel.appendLine('Activating Emscripten SDK...');
					await this.runEmsdkCommand(['activate', EmsdkInstaller.EMSCRIPTEN_VERSION], token);

					this.outputChannel.appendLine('Emscripten SDK installed successfully!');
					void vscode.window.showInformationMessage('Emscripten SDK installed successfully!');
				} catch (error) {
					// Remove the partial install so a retry starts clean and checkInstallation() is accurate.
					this.removeInstall();

					// Any failure after the user canceled (e.g., an aborted download rejecting
					// with a plain Error) is reported as a cancellation, not an error.
					if (token.isCancellationRequested || error instanceof vscode.CancellationError) {
						this.outputChannel.appendLine('Installation cancelled by user.');
						throw new vscode.CancellationError();
					}

					this.outputChannel.appendLine(`Installation failed: ${error}`);
					throw error instanceof Error ? error : new Error(`Failed to install Emscripten SDK: ${error}`);
				} finally {
					cancelSub.dispose();
				}
			}
		);
	}

	/**
	 * @brief Removes the current Emscripten SDK installation and reinstalls it from scratch.
	 *
	 * @returns {Promise<void>} Resolves when reinstallation is complete.
	 */
	public async reinstall(): Promise<void> {
		this.outputChannel.appendLine('Reinstalling Emscripten toolchain...');
		this.removeInstall();
		await this.installEmsdk();
	}

	/**
	 * @brief Runs environment checks for the "Check Setup" command.
	 *
	 * @returns {Promise<SetupDiagnostic[]>} A diagnostic entry for each check.
	 */
	public async getDiagnostics(): Promise<SetupDiagnostic[]> {
		const results: SetupDiagnostic[] = [];

		const python = await this.getPythonVersion();
		results.push(
			python
				? { name: 'Python', status: 'pass', detail: python }
				: {
						name: 'Python',
						status: 'fail',
						detail: 'Not found on PATH. Emscripten needs Python 3 to install and to run emcc.',
					}
		);

		const emcc = await this.getEmccVersion();
		results.push(
			emcc
				? { name: 'Emscripten toolchain', status: 'pass', detail: `${emcc}` }
				: {
						name: 'Emscripten toolchain',
						status: 'fail',
						detail: `Not installed. The extension uses its own bundled Emscripten (a system-wide emcc is not used). Run "LVGL: Install Emscripten Toolchain" or start a preview to install it (pinned ${EmsdkInstaller.EMSCRIPTEN_VERSION}).`,
					}
		);

		results.push(await this.checkDiskSpace());
		results.push(await this.checkNetwork());

		if (process.platform === 'win32') {
			const longPaths = await this.checkLongPathSupport();
			results.push(
				longPaths
					? { name: 'Windows long paths', status: 'pass', detail: 'Enabled' }
					: {
							name: 'Windows long paths',
							status: 'warn',
							detail: 'Not enabled — may cause extraction failures. Enable LongPathsEnabled and restart.',
						}
			);
		}

		return results;
	}

	/**
	 * @brief Checks free disk space on the volume where the toolchain is stored.
	 */
	private async checkDiskSpace(): Promise<SetupDiagnostic> {
		try {
			const storagePath = this.context.globalStorageUri.fsPath;
			fs.mkdirSync(storagePath, { recursive: true });
			const stats = await fs.promises.statfs(storagePath);
			const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
			const detail = `${freeGb.toFixed(1)} GB free where the toolchain is stored`;
			if (freeGb < 3) {
				return {
					name: 'Disk space',
					status: 'warn',
					detail: `${detail} — the toolchain needs ~1–2 GB; free space is low.`,
				};
			}
			return { name: 'Disk space', status: 'pass', detail };
		} catch (error) {
			return {
				name: 'Disk space',
				status: 'warn',
				detail: `Could not determine free disk space (${error instanceof Error ? error.message : String(error)}).`,
			};
		}
	}

	/**
	 * @brief Checks whether GitHub is reachable (needed to download the toolchain and LVGL).
	 */
	private async checkNetwork(): Promise<SetupDiagnostic> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const response = await fetch('https://github.com', { method: 'HEAD', signal: controller.signal });
			if (response.status >= 200 && response.status < 500) {
				return { name: 'Network (github.com)', status: 'pass', detail: `Reachable (HTTP ${response.status})` };
			}
			return {
				name: 'Network (github.com)',
				status: 'warn',
				detail: `Unexpected response (HTTP ${response.status})`,
			};
		} catch (error) {
			return {
				name: 'Network (github.com)',
				status: 'fail',
				detail: `Could not reach github.com — needed to download the toolchain and LVGL (${error instanceof Error ? error.message : String(error)}).`,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * @brief Removes the emsdk install directory if it exists (best effort).
	 */
	private removeInstall(): void {
		try {
			if (fs.existsSync(this.emsdkPath)) {
				this.outputChannel.appendLine('Removing existing emsdk directory...');
				fs.rmSync(this.emsdkPath, { recursive: true, force: true });
			}
		} catch (error) {
			this.outputChannel.appendLine(`Failed to remove emsdk directory: ${error}`);
		}
	}

	/**
	 * @brief Throws a CancellationError if the token has been canceled.
	 */
	private throwIfCancelled(token: vscode.CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
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
	 * @brief Runs an emsdk command, surfacing known error conditions with actionable messages.
	 *
	 * @param {string[]} args - Command arguments to pass to emsdk.
	 * @param {vscode.CancellationToken} [token] - Optional cancellation token.
	 * @returns {Promise<void>} Resolves when the command completes successfully.
	 * @throws {Error} If the command fails, or {vscode.CancellationError} if cancelled.
	 */
	private async runEmsdkCommand(args: string[], token?: vscode.CancellationToken): Promise<void> {
		const emsdkScript = process.platform === 'win32' ? 'emsdk.bat' : './emsdk';
		const emsdkRoot = this.getEmsdkRoot();
		const cmd = `cd "${emsdkRoot}" && ${emsdkScript} ${args.join(' ')}`;

		this.outputChannel.appendLine(`Running: ${cmd}`);

		let output: { stdout: string; stderr: string };
		try {
			output = await this.execCancellable(
				cmd,
				{
					shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
					maxBuffer: 50 * 1024 * 1024,
				},
				token
			);
			if (output.stdout) {
				this.outputChannel.appendLine(output.stdout);
			}
			if (output.stderr) {
				this.outputChannel.appendLine(`stderr: ${output.stderr}`);
			}
		} catch (error: unknown) {
			if (error instanceof vscode.CancellationError) {
				throw error;
			}

			const execError = error as { message: string; stdout?: string; stderr?: string };
			this.outputChannel.appendLine(`Command failed: ${execError.message}`);
			if (execError.stdout) {
				this.outputChannel.appendLine(`stdout: ${execError.stdout}`);
			}
			if (execError.stderr) {
				this.outputChannel.appendLine(`stderr: ${execError.stderr}`);
			}

			// Surface a known cause if we can recognize it; otherwise rethrow the raw error.
			await this.throwForKnownErrors(
				`${execError.message} ${execError.stdout || ''} ${execError.stderr || ''}`.toLowerCase()
			);
			throw error;
		}

		// emsdk can report failures on stdout/stderr while still exiting 0.
		await this.throwForKnownErrors(`${output.stdout} ${output.stderr}`.toLowerCase());
	}

	/**
	 * @brief Inspects combined command output and throws an actionable error for known failures.
	 *
	 * @param combinedOutput - Lower-cased combined stdout/stderr (and error message).
	 */
	private async throwForKnownErrors(combinedOutput: string): Promise<void> {
		if (
			combinedOutput.includes('python') &&
			(combinedOutput.includes('not found') ||
				combinedOutput.includes('command not found') ||
				combinedOutput.includes('is not recognized'))
		) {
			throw new Error('Python is required but not found. Please install Python and add it to your system PATH.');
		}

		if (combinedOutput.includes('ssl') && combinedOutput.includes('certificate_verify_failed')) {
			throw new Error(
				'SSL certificate verification failed. Please fix Python SSL certificates by running: python -m pip install --upgrade certifi'
			);
		}

		if (combinedOutput.includes('installation failed') || combinedOutput.includes('error: error:')) {
			throw new Error('Emscripten SDK installation failed. Check the output above for details.');
		}

		const longPathError =
			combinedOutput.includes('path too long') ||
			combinedOutput.includes('specified path is too long') ||
			combinedOutput.includes('path is too deep') ||
			(combinedOutput.includes('[winerror 3]') &&
				combinedOutput.includes('system cannot find the path specified') &&
				(combinedOutput.includes('unzip') || combinedOutput.includes('extract')));

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
			}
			throw new Error(
				'Installation failed due to long file paths even though Windows long path support is enabled. ' +
					'This may be a Node.js limitation. Please try restarting your computer if you recently enabled long path support.'
			);
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
