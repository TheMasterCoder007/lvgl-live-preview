import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LvglProjectConfig, ResolvedProjectConfig } from '../types';

/**
 * @class ConfigLoader
 * @brief Loads and parses .lvgl-live-preview.json configuration files.
 *
 * Handles finding, validating, and resolving paths in project configuration files.
 */
export class ConfigLoader {
	private static readonly CONFIG_FILE_NAME = '.lvgl-live-preview.json';

	/**
	 * @brief Attempts to find and load the project configuration file.
	 *
	 * Searches for .lvgl-live-preview.json in the same directory as the file
	 * and in parent directories up to the workspace root.
	 *
	 * @param fileUri URI of the C file being previewed
	 * @param outputChannel Output channel for logging
	 * @returns ResolvedProjectConfig if found, null for single-file mode
	 */
	public static async loadConfig(
		fileUri: vscode.Uri,
		outputChannel: vscode.OutputChannel
	): Promise<ResolvedProjectConfig | null> {
		const filePath = fileUri.fsPath;
		const fileDir = path.dirname(filePath);

		// Try to find the config file starting from the file directory
		const configPath = this.findConfigFile(fileDir, fileUri);

		if (!configPath) {
			outputChannel.appendLine('No .lvgl-live-preview.json found, using single-file mode');
			return null;
		}

		outputChannel.appendLine(`Found config file: ${configPath}`);

		try {
			const configContent = fs.readFileSync(configPath, 'utf-8');
			const parsedConfig: unknown = JSON.parse(configContent);

			// Validate config
			this.validateConfig(parsedConfig, configPath);

			// Now we know it's valid, cast it
			const config = parsedConfig as LvglProjectConfig;

			// Resolve paths relative to the config file directory
			const configDir = path.dirname(configPath);
			const resolvedConfig = this.resolveConfig(config, configDir);

			outputChannel.appendLine(`Config loaded: main=${resolvedConfig.mainFile}`);
			outputChannel.appendLine(`  Dependencies: ${resolvedConfig.dependencies.length} files`);
			outputChannel.appendLine(`  Include paths: ${resolvedConfig.includePaths.length} directories`);
			outputChannel.appendLine(`  Defines: ${resolvedConfig.defines.join(', ')}`);

			return resolvedConfig;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Failed to load config: ${errorMessage}`);
			vscode.window.showWarningMessage(
				`Failed to load .lvgl-live-preview.json: ${errorMessage}. Using single-file mode.`
			);
			return null;
		}
	}

	/**
	 * @brief Searches for the config file in the directory tree.
	 *
	 * @param startDir Directory to start searching from
	 * @param fileUri URI of the file being previewed (for workspace root lookup)
	 * @returns Path to config file if found, null otherwise
	 */
	private static findConfigFile(startDir: string, fileUri: vscode.Uri): string | null {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
		const workspaceRoot = workspaceFolder?.uri.fsPath;

		let currentDir = startDir;
		let continueSearch = true;

		// Search up the directory tree
		while (continueSearch) {
			const configPath = path.join(currentDir, this.CONFIG_FILE_NAME);

			if (fs.existsSync(configPath)) {
				return configPath;
			}

			// Stop at the workspace root or filesystem root
			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir || (workspaceRoot && !currentDir.startsWith(workspaceRoot))) {
				continueSearch = false;
			} else {
				currentDir = parentDir;
			}
		}

		return null;
	}

	/**
	 * @brief Validates the configuration file structure.
	 *
	 * @param config Parsed configuration object (unknown type from JSON.parse)
	 * @param configPath Path to the config file (for error messages)
	 * @throws Error if configuration is invalid
	 */
	private static validateConfig(config: unknown, configPath: string): void {
		if (!config || typeof config !== 'object') {
			throw new Error(`Invalid configuration format in ${configPath}`);
		}

		const cfg = config as Record<string, unknown>;

		if (!cfg.mainFile || typeof cfg.mainFile !== 'string') {
			throw new Error(`Missing or invalid 'mainFile' in ${configPath}`);
		}

		if (cfg.dependencies !== undefined) {
			if (!Array.isArray(cfg.dependencies)) {
				throw new Error(`'dependencies' must be an array in ${configPath}`);
			}

			for (const dep of cfg.dependencies) {
				if (typeof dep !== 'string') {
					throw new Error(`All dependencies must be strings in ${configPath}`);
				}
			}
		}

		if (cfg.includePaths !== undefined) {
			if (!Array.isArray(cfg.includePaths)) {
				throw new Error(`'includePaths' must be an array in ${configPath}`);
			}

			for (const includePath of cfg.includePaths) {
				if (typeof includePath !== 'string') {
					throw new Error(`All includePaths must be strings in ${configPath}`);
				}
			}
		}

		if (cfg.defines !== undefined) {
			if (!Array.isArray(cfg.defines)) {
				throw new Error(`'defines' must be an array in ${configPath}`);
			}

			for (const define of cfg.defines) {
				if (typeof define !== 'string') {
					throw new Error(`All defines must be strings in ${configPath}`);
				}
			}
		}
	}

	/**
	 * @brief Resolves relative paths in the configuration to absolute paths.
	 *
	 * @param config Parsed configuration object
	 * @param configDir Directory containing the config file
	 * @returns ResolvedProjectConfig with absolute paths
	 * @throws Error if files don't exist
	 */
	private static resolveConfig(config: LvglProjectConfig, configDir: string): ResolvedProjectConfig {
		// Resolve the main file path
		const mainFile = path.isAbsolute(config.mainFile) ? config.mainFile : path.resolve(configDir, config.mainFile);

		if (!fs.existsSync(mainFile)) {
			throw new Error(`Main file not found: ${mainFile}`);
		}

		// Resolve dependency paths
		const dependencies: string[] = [];
		if (config.dependencies) {
			for (const dep of config.dependencies) {
				const depPath = path.isAbsolute(dep) ? dep : path.resolve(configDir, dep);

				if (!fs.existsSync(depPath)) {
					throw new Error(`Dependency file not found: ${depPath}`);
				}

				dependencies.push(depPath);
			}
		}

		// Resolve include paths
		const includePaths: string[] = [];
		if (config.includePaths) {
			for (const includePath of config.includePaths) {
				const resolvedPath = path.isAbsolute(includePath)
					? includePath
					: path.resolve(configDir, includePath);

				if (!fs.existsSync(resolvedPath)) {
					throw new Error(`Include path directory not found: ${resolvedPath}`);
				}

				if (!fs.statSync(resolvedPath).isDirectory()) {
					throw new Error(`Include path is not a directory: ${resolvedPath}`);
				}

				includePaths.push(resolvedPath);
			}
		}

		return {
			mainFile,
			dependencies,
			includePaths,
			defines: config.defines || [],
			configFileDir: configDir,
		};
	}
}
