import * as vscode from 'vscode';
import { PreviewSettings, SettingsOptions } from '../types';

/**
 * @class SettingsManager
 * @brief Central place for reading and writing LVGL Live Preview settings.
 *
 * Settings are owned entirely by the preview and stored in the extension's own
 * global state - they are intentionally NOT VS Code configuration settings, so
 * they do not appear in the VS Code Settings UI and editing them never triggers
 * VS Code's per-key configuration-change events. All changes flow through the
 * in-preview settings panel and are applied only when the user clicks Save.
 */
export class SettingsManager {
	/** globalState key under which the settings object is persisted. */
	private static readonly STORAGE_KEY = 'lvglPreview.settings';

	/** Legacy VS Code configuration section, used only for one-time migration. */
	private static readonly LEGACY_SECTION = 'lvglPreview';

	/**
	 * Session-only orientation override. When true, the effective display width and
	 * height are swapped relative to the saved settings. This is deliberately kept
	 * in memory only - it is never persisted and resets to false when a new preview
	 * session starts.
	 */
	private static orientationSwapped = false;

	/**
	 * @brief Default values used when no stored settings exist.
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
	 * @brief Reads the current settings from the extension's global state.
	 *
	 * On first use (no stored settings yet) any pre-existing VS Code `lvglPreview.*`
	 * configuration is migrated in, so users upgrading from an earlier version keep
	 * their previously configured values.
	 *
	 * @param context The extension context (provides global state).
	 * @returns The effective PreviewSettings.
	 */
	public static getSettings(context: vscode.ExtensionContext): PreviewSettings {
		const stored = context.globalState.get<Partial<PreviewSettings>>(this.STORAGE_KEY);
		if (stored) {
			// Merge over defaults so any newly added setting has a sane value.
			return { ...this.DEFAULTS, ...stored };
		}

		const legacy = this.readLegacySettings();
		// One-time migration: persist legacy VS Code settings into globalState.
		void context.globalState.update(this.STORAGE_KEY, legacy);
		return legacy;
	}

	/**
	 * @brief Reads the saved settings with the session orientation override applied.
	 *
	 * When the orientation has been toggled for this session, the effective display
	 * width and height are swapped. Used by the build/compile path so a rotate takes
	 * effect without changing the user's saved dimensions. The settings panel keeps
	 * reading the un-swapped saved values via getSettings().
	 *
	 * @param context The extension context (provides global state).
	 * @returns The effective PreviewSettings for compilation.
	 */
	public static getEffectiveSettings(context: vscode.ExtensionContext): PreviewSettings {
		const settings = this.getSettings(context);
		if (this.orientationSwapped) {
			return {
				...settings,
				displayWidth: settings.displayHeight,
				displayHeight: settings.displayWidth,
			};
		}
		return settings;
	}

	/**
	 * @brief Whether the session orientation is currently swapped.
	 */
	public static isOrientationSwapped(): boolean {
		return this.orientationSwapped;
	}

	/**
	 * @brief Sets the session orientation override.
	 *
	 * @param swapped true to swap width/height, false for the saved orientation.
	 */
	public static setOrientationSwapped(swapped: boolean): void {
		this.orientationSwapped = swapped;
	}

	/**
	 * @brief Toggles the session orientation override.
	 *
	 * @returns The new swapped state.
	 */
	public static toggleOrientation(): boolean {
		this.orientationSwapped = !this.orientationSwapped;
		return this.orientationSwapped;
	}

	/**
	 * @brief Persists settings to the extension's global state.
	 *
	 * @param context The extension context (provides global state).
	 * @param newSettings The settings selected in the webview panel.
	 * @returns The list of keys whose value actually changed.
	 */
	public static async saveSettings(
		context: vscode.ExtensionContext,
		newSettings: PreviewSettings
	): Promise<(keyof PreviewSettings)[]> {
		const current = this.getSettings(context);
		const merged: PreviewSettings = { ...current, ...newSettings };

		const changed = (Object.keys(merged) as (keyof PreviewSettings)[]).filter(
			(key) => merged[key] !== current[key]
		);

		await context.globalState.update(this.STORAGE_KEY, merged);
		return changed;
	}

	/**
	 * @brief Reads settings from legacy VS Code configuration for migration.
	 *
	 * VS Code still returns values present in a user's/workspace settings.json even
	 * though the extension no longer declares them, so existing configurations are
	 * picked up here. Unset keys fall back to defaults.
	 *
	 * @returns PreviewSettings seeded from any legacy configuration.
	 */
	private static readLegacySettings(): PreviewSettings {
		const config = vscode.workspace.getConfiguration(this.LEGACY_SECTION);
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
}
