import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * @brief Represents a single C/C++ configuration for IntelliSense.
 */
interface CppConfiguration {
	name: string;
	includePath: string[];
	defines?: string[];
	cStandard?: string;
	cppStandard?: string;
	intelliSenseMode?: string;
	compilerPath?: string;
}

/**
 * @brief Represents the c_cpp_properties.json file structure.
 */
interface CppProperties {
	version: number;
	configurations: CppConfiguration[];
}

/**
 * @class IntellisenseHelper
 * @brief Helper class for managing C/C++ IntelliSense configuration in VS Code.
 *
 * This class provides utilities to update the c_cpp_properties.json file with LVGL
 * include paths, enabling proper IntelliSense support for LVGL API in the workspace.
 * It handles creation, reading, and updating of C/C++ configuration settings across
 * different platforms (Windows, macOS, Linux).
 */
export class IntellisenseHelper {
	/**
	 * @brief Updates the c_cpp_properties.json file with LVGL include paths.
	 *
	 * This method creates or updates the C/C++ properties configuration file to include
	 * LVGL header paths, enabling IntelliSense support for LVGL API in the workspace.
	 * It handles:
	 * - Creating .vscode directory if needed
	 * - Reading existing configuration or creating a new one
	 * - Adding LVGL include paths without duplicates
	 * - Preserving existing configurations
	 *
	 * @param lvglIncludePath The root path to the LVGL library headers
	 * @param workspaceFolder The VS Code workspace folder where configuration will be created
	 * @returns Promise that resolves when the configuration is updated
	 *
	 * @note If no workspace folder is provided, the method returns early without making changes
	 */
	public static async updateCppProperties(
		lvglIncludePath: string,
		workspaceFolder?: vscode.WorkspaceFolder
	): Promise<void> {
		if (!workspaceFolder) {
			// No workspace folder, can't create c_cpp_properties.json
			return;
		}

		const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
		const cppPropertiesPath = path.join(vscodeDir, 'c_cpp_properties.json');

		// Create a .vscode directory if it doesn't exist
		if (!fs.existsSync(vscodeDir)) {
			fs.mkdirSync(vscodeDir, { recursive: true });
		}

		let config: CppProperties;

		// Read existing config or create new one
		if (fs.existsSync(cppPropertiesPath)) {
			try {
				const content = fs.readFileSync(cppPropertiesPath, 'utf-8');
				config = JSON.parse(content) as CppProperties;
			} catch {
				// If parsing fails, create a new config
				config = this.createDefaultConfig();
			}
		} else {
			config = this.createDefaultConfig();
		}

		// Ensure configurations array exists
		if (!config.configurations || !Array.isArray(config.configurations)) {
			config.configurations = [this.createDefaultConfiguration()];
		}

		// Update each configuration with LVGL include paths
		for (const configuration of config.configurations) {
			if (!configuration.includePath) {
				configuration.includePath = [];
			}

			const lvglPaths = [lvglIncludePath, path.join(lvglIncludePath, 'src')];

			// Add LVGL paths if not already present
			for (const lvglPath of lvglPaths) {
				// Normalize path separators for comparison
				const normalizedPath = lvglPath.replace(/\\/g, '/');
				const exists = configuration.includePath.some((p: string) => p.replace(/\\/g, '/') === normalizedPath);

				if (!exists) {
					configuration.includePath.push(lvglPath);
				}
			}

			// Ensure standard paths are included
			if (!configuration.includePath.includes('${workspaceFolder}/**')) {
				configuration.includePath.unshift('${workspaceFolder}/**');
			}
		}

		// Write updated config
		fs.writeFileSync(cppPropertiesPath, JSON.stringify(config, null, 4), 'utf-8');
	}

	/**
	 * @brief Creates a default C/C++ properties configuration.
	 *
	 * Generates a basic CppProperties object with version 4 and a single
	 * platform-appropriate configuration.
	 *
	 * @returns A default CppProperties object with minimal configuration
	 */
	private static createDefaultConfig(): CppProperties {
		return {
			version: 4,
			configurations: [this.createDefaultConfiguration()],
		};
	}

	/**
	 * @brief Creates a platform-specific default C/C++ configuration.
	 *
	 * Generates a configuration tailored to the current platform (Windows, macOS, or Linux)
	 * with the appropriate IntelliSense mode, compiler settings, and standard defines.
	 * The compiler path is intentionally omitted to allow VS Code to auto-detect.
	 *
	 * @returns A CppConfiguration object with platform-specific settings
	 *
	 * @note Compiler path is not specified to avoid errors with non-existent paths;
	 *	   VS Code will automatically detect available compilers
	 */
	private static createDefaultConfiguration(): CppConfiguration {
		const platform = process.platform;
		let configName = 'Win32';
		let intelliSenseMode = 'windows-msvc-x64';

		if (platform === 'darwin') {
			configName = 'Mac';
			intelliSenseMode = 'macos-clang-x64';
		} else if (platform === 'linux') {
			configName = 'Linux';
			intelliSenseMode = 'linux-gcc-x64';
		}

		// Don't specify compilerPath - let VS Code auto-detect
		// This avoids errors with non-existent paths
		return {
			name: configName,
			includePath: ['${workspaceFolder}/**'],
			defines: ['_DEBUG', 'UNICODE', '_UNICODE'],
			cStandard: 'c11',
			cppStandard: 'c++17',
			intelliSenseMode: intelliSenseMode,
		};
	}

	/**
	 * @brief Displays instructions for IntelliSense setup and offers to reload the window.
	 *
	 * Shows an information message to the user indicating that LVGL include paths have been
	 * configured and provides an option to reload the VS Code window to ensure IntelliSense
	 * picks up the changes immediately.
	 *
	 * @param lvglVersion The LVGL version that was configured for IntelliSense
	 * @returns Promise that resolves when the user dismisses the message or after reload
	 */
	public static async showIntelliSenseInstructions(lvglVersion: string): Promise<void> {
		const message =
			`LVGL ${lvglVersion} include paths have been added to your workspace settings. ` +
			`If IntelliSense still shows errors, try reloading the window.`;

		const action = await vscode.window.showInformationMessage(message, 'Reload Window', 'Dismiss');

		if (action === 'Reload Window') {
			vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	}
}
