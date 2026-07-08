import * as vscode from 'vscode';
import { PreviewSettings, SettingsOptions } from '../types';

/**
 * @class SettingsManager
 * @brief Central place for reading and writing LVGL Live Preview settings.
 *
 * Settings are still persisted to VS Code's configuration (settings.json), so the
 * in-webview settings panel and the native VS Code settings UI stay in sync. Every
 * consumer in the extension keeps reading from `vscode.workspace.getConfiguration`,
 * so writing here is enough to update the whole extension.
 */
export class SettingsManager {
	private static readonly SECTION = 'lvglPreview';

	/**
	 * @brief Default values, kept in sync with the `contributes.configuration`
	 *        defaults declared in package.json.
	 */
	private static readonly DEFAULTS: PreviewSettings = {
		emccOptimization: '-O1',
		lvglVersion: '9.4.0',
		displayWidth: 480,
		displayHeight: 320,
		autoReload: true,
		debounceDelay: 100,
		lvglMemorySize: 256,
		wasmMemorySize: 128,
	};

	/**
	 * @brief Selectable option lists surfaced in the webview settings panel.
	 *
	 * These mirror the `enum` lists declared in package.json so the panel can build
	 * its dropdowns without duplicating the values inside the HTML template.
	 */
	public static readonly OPTIONS: SettingsOptions = {
		lvglVersions: [
			'8.0.0',
			'8.0.1',
			'8.0.2',
			'8.1.0',
			'8.2.0',
			'8.3.0',
			'8.3.1',
			'8.3.2',
			'8.3.3',
			'8.3.4',
			'8.3.5',
			'8.3.6',
			'8.3.7',
			'8.3.8',
			'8.3.9',
			'8.3.10',
			'8.3.11',
			'8.4.0',
			'9.0.0',
			'9.1.0',
			'9.2.0',
			'9.2.1',
			'9.2.2',
			'9.3.0',
			'9.4.0',
		],
		optimizations: ['-O0', '-O1', '-O2', '-O3', '-Os', '-Oz'],
		lvglMemorySizes: [64, 128, 256, 512, 1024, 2048],
		wasmMemorySizes: [64, 128, 256, 512, 1024],
	};

	/**
	 * @brief Reads the current settings, resolved from VS Code configuration.
	 *
	 * @returns The effective PreviewSettings (user/workspace values or defaults).
	 */
	public static getSettings(): PreviewSettings {
		const config = vscode.workspace.getConfiguration(this.SECTION);
		return {
			emccOptimization: config.get<string>('emccOptimization', this.DEFAULTS.emccOptimization),
			lvglVersion: config.get<string>('lvglVersion', this.DEFAULTS.lvglVersion),
			displayWidth: config.get<number>('displayWidth', this.DEFAULTS.displayWidth),
			displayHeight: config.get<number>('displayHeight', this.DEFAULTS.displayHeight),
			autoReload: config.get<boolean>('autoReload', this.DEFAULTS.autoReload),
			debounceDelay: config.get<number>('debounceDelay', this.DEFAULTS.debounceDelay),
			lvglMemorySize: config.get<number>('lvglMemorySize', this.DEFAULTS.lvglMemorySize),
			wasmMemorySize: config.get<number>('wasmMemorySize', this.DEFAULTS.wasmMemorySize),
		};
	}

	/**
	 * @brief Persists settings to VS Code configuration, writing only changed keys.
	 *
	 * Writing only the keys that actually changed keeps settings.json tidy and avoids
	 * spurious configuration-change events (which would otherwise trigger needless
	 * rebuilds).
	 *
	 * @param newSettings The settings selected in the webview panel.
	 * @returns true if any value was written (i.e. something changed), false otherwise.
	 */
	public static async saveSettings(newSettings: PreviewSettings): Promise<boolean> {
		const config = vscode.workspace.getConfiguration(this.SECTION);
		const current = this.getSettings();

		// Persist to the workspace when one is open, otherwise to the user (global)
		// settings - this matches where VS Code reads them back from.
		const target = vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;

		let changed = false;
		const keys = Object.keys(newSettings) as (keyof PreviewSettings)[];

		for (const key of keys) {
			if (newSettings[key] !== current[key]) {
				await config.update(key, newSettings[key], target);
				changed = true;
			}
		}

		return changed;
	}
}
