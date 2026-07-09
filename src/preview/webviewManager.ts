import * as vscode from 'vscode';
import { ExtensionMessage, PreviewSettings, WebviewMessage } from '../types';
import { HtmlTemplate } from './htmlTemplate';
import { SettingsManager } from '../utils/settingsManager';

/**
 * @class WebviewManager
 * @brief Manages the webview panel for LVGL preview display.
 *
 * This class handles the lifecycle of the VS Code webview panel, including creation,
 * disposal, and recreation for hot reload functionality. It provides a message passing
 * between the extension and the webview.
 *
 * @implements vscode.Disposable
 */
export class WebviewManager implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private outputChannel: vscode.OutputChannel;
	private onReloadCallback?: () => void | Promise<void>;
	private onSaveSettingsCallback?: (settings: PreviewSettings) => void | Promise<void>;

	/**
	 * @constructor
	 * @brief Creates a new WebviewManager instance.
	 *
	 * @param context - The VS Code extension context
	 * @param outputChannel - Output channel for logging
	 * @param onReload - Optional callback invoked when reload button is clicked in webview
	 * @param onSaveSettings - Optional callback invoked when settings are saved in the webview panel
	 */
	constructor(
		private context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
		onReload?: () => void | Promise<void>,
		onSaveSettings?: (settings: PreviewSettings) => void | Promise<void>
	) {
		this.outputChannel = outputChannel;
		this.onReloadCallback = onReload;
		this.onSaveSettingsCallback = onSaveSettings;
	}

	/**
	 * @brief Creates a new webview panel or reveals an existing one.
	 *
	 * If a panel already exists, it will be revealed instead of creating a new one.
	 * The panel is configured with script execution enabled and the appropriate local
	 * resource roots for loading WASM and JavaScript files.
	 *
	 * @param title - The title to display in the webview panel
	 */
	public async createOrShow(title: string): Promise<void> {
		const column =
			vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn
				? vscode.window.activeTextEditor.viewColumn + 1
				: vscode.ViewColumn.Two;

		// If the panel already exists, show it
		if (this.panel) {
			this.panel.reveal(column);
			return;
		}

		this.createPanel(title, column, true);
	}

	/**
	 * @brief Recreates the webview panel for hot reload.
	 *
	 * This method disposes of the existing webview and creates a new one, providing
	 * a fresh JavaScript execution context. This is the key to enabling reliable
	 * hot reload - each reload gets a completely clean environment without any
	 * lingering state from previous WASM modules.
	 *
	 * @param title - The title to display in the recreated webview panel
	 */
	public async recreate(title: string): Promise<void> {
		this.outputChannel.appendLine('[WebviewManager] Recreating webview for reload...');

		// Store the column before disposing
		const column = this.panel?.viewColumn || vscode.ViewColumn.Two;

		// Dispose old panel
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}

		// Small delay to ensure cleanup
		await new Promise((resolve) => setTimeout(resolve, 100));

		this.createPanel(title, column, false);

		this.outputChannel.appendLine('[WebviewManager] Webview recreated');
	}

	/**
	 * @brief Creates a new webview panel with common configuration.
	 *
	 * This private helper method contains the shared logic for creating webview panels,
	 * used by both createOrShow() and recreate() methods.
	 *
	 * @param title - The title to display in the webview panel
	 * @param column - The view column to show the panel in
	 * @param retainContext - Whether to retain context when hidden
	 */
	private createPanel(title: string, column: vscode.ViewColumn, retainContext: boolean): void {
		this.panel = vscode.window.createWebviewPanel('lvglPreview', `LVGL Preview: ${title}`, column, {
			enableScripts: true,
			retainContextWhenHidden: retainContext,
			localResourceRoots: [this.context.globalStorageUri, this.context.extensionUri],
		});

		// Set HTML content
		this.panel.webview.html = HtmlTemplate.getHtml(this.panel.webview, this.context.extensionUri);

		// Handle messages from the webview
		this.panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => {
				this.handleWebviewMessage(message);
			},
			undefined,
			this.context.subscriptions
		);

		// Handle panel disposal
		this.panel.onDidDispose(
			() => {
				this.panel = undefined;
			},
			undefined,
			this.context.subscriptions
		);
	}

	/**
	 * @brief Handles messages received from the webview.
	 *
	 * @param message - The message received from the webview
	 */
	private handleWebviewMessage(message: WebviewMessage): void {
		switch (message.type) {
			case 'ready':
				this.outputChannel.appendLine('Webview ready');
				// Send the current settings so the in-webview settings panel is populated.
				this.sendSettings();
				break;
			case 'error':
				this.outputChannel.appendLine(`Webview error: ${message.message}`);
				void vscode.window.showErrorMessage(`Preview error: ${message.message}`);
				break;
			case 'reload':
				this.outputChannel.appendLine('Webview requesting reload');
				if (this.onReloadCallback) {
					void Promise.resolve(this.onReloadCallback());
				}
				break;
			case 'saveSettings':
				this.outputChannel.appendLine('Webview requesting settings save');
				if (this.onSaveSettingsCallback) {
					void Promise.resolve(this.onSaveSettingsCallback(message.settings));
				}
				break;
		}
	}

	/**
	 * @brief Sends the current settings and selectable options to the webview.
	 *
	 * Used to populate the in-webview settings panel, both on initial load and after
	 * settings change (e.g., edited via the native VS Code settings UI).
	 */
	public sendSettings(): void {
		this.sendMessage({
			type: 'updateSettings',
			settings: SettingsManager.getSettings(this.context),
			options: SettingsManager.OPTIONS,
		});
	}

	/**
	 * @brief Sends a message to the webview.
	 *
	 * @param message - The message to send to the webview
	 */
	public sendMessage(message: ExtensionMessage): void {
		if (this.panel) {
			void this.panel.webview.postMessage(message);
		}
	}

	/**
	 * @brief Disposes the webview panel and cleans up resources.
	 */
	public dispose(): void {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
	}
}
