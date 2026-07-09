import * as vscode from 'vscode';
import { ExtensionMessage, PreviewSettings, WebviewMessage } from '../types';
import { HtmlTemplate } from './htmlTemplate';
import { SettingsManager } from '../utils/settingsManager';

/**
 * @interface WebviewHandlers
 * @brief Callbacks the WebviewManager invokes in response to webview toolbar/panel actions.
 *
 * All handlers are optional so callers only wire up what they need.
 */
export interface WebviewHandlers {
	/** Invoked when the reload button is clicked. */
	onReload?: () => void | Promise<void>;
	/** Invoked when settings are saved in the settings panel. */
	onSaveSettings?: (settings: PreviewSettings) => void | Promise<void>;
	/** Invoked when the orientation button is clicked. */
	onToggleOrientation?: () => void | Promise<void>;
	/** Invoked when the stop button is clicked. */
	onStop?: () => void | Promise<void>;
	/** Invoked when the reset cache button is clicked. */
	onClearCache?: () => void | Promise<void>;
}

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
	private logChannel: vscode.OutputChannel;
	private readonly handlers: WebviewHandlers;
	private hasRevealedLogChannel = false;

	/**
	 * @constructor
	 * @brief Creates a new WebviewManager instance.
	 *
	 * @param context - The VS Code extension context
	 * @param outputChannel - Output channel for extension/build logging
	 * @param logChannel - Output channel for the previewed app's runtime output (printf / LV_LOG_*)
	 * @param handlers - Callbacks invoked in response to webview toolbar/panel actions
	 */
	constructor(
		private context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
		logChannel: vscode.OutputChannel,
		handlers: WebviewHandlers = {}
	) {
		this.outputChannel = outputChannel;
		this.logChannel = logChannel;
		this.handlers = handlers;
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
		// createOrShow marks the start of a preview session. Reset the reveal guard so
		// the runtime log channel is revealed again on the first log of this session.
		// (recreate() - hot reload - deliberately does NOT reset it, so the Output
		// panel doesn't pop to the front on every file save.)
		this.hasRevealedLogChannel = false;

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
				void Promise.resolve(this.handlers.onReload?.());
				break;
			case 'saveSettings':
				this.outputChannel.appendLine('Webview requesting settings save');
				void Promise.resolve(this.handlers.onSaveSettings?.(message.settings));
				break;
			case 'log':
				this.appendRuntimeLog(message.level, message.message);
				break;
			case 'toggleOrientation':
				this.outputChannel.appendLine('Webview requesting orientation toggle');
				void Promise.resolve(this.handlers.onToggleOrientation?.());
				break;
			case 'stop':
				this.outputChannel.appendLine('Webview requesting stop');
				void Promise.resolve(this.handlers.onStop?.());
				break;
			case 'clearCache':
				this.outputChannel.appendLine('Webview requesting cache reset');
				void Promise.resolve(this.handlers.onClearCache?.());
				break;
		}
	}

	/**
	 * @brief Appends a line of the previewed app's runtime output to the log channel.
	 *
	 * The first log after a preview session starts reveals the channel (without
	 * stealing focus) so the output is discoverable. Later logs - including those
	 * after a hot reload within the same session - just append, so the Output panel
	 * is not repeatedly forced to the foreground while editing.
	 *
	 * @param level - 'error' for stderr output, 'log' otherwise
	 * @param message - The log text emitted by the app (printf / LV_LOG_*)
	 */
	private appendRuntimeLog(level: 'log' | 'error', message: string): void {
		// Emscripten emits one call per line; trailing newlines would double-space.
		const text = message.replace(/\r?\n$/, '');
		this.logChannel.appendLine(level === 'error' ? `[error] ${text}` : text);

		if (!this.hasRevealedLogChannel) {
			this.hasRevealedLogChannel = true;
			this.logChannel.show(true);
		}
	}

	/**
	 * @brief Sends the current settings and selectable options to the webview.
	 *
		 * Used to populate the in-webview settings panel, both on initial load and after
		 * settings are saved (e.g., to refresh the panel after a save that doesn't rebuild).
	 */
	public sendSettings(): void {
		this.sendMessage({
			type: 'updateSettings',
			settings: SettingsManager.getSettings(this.context),
			options: SettingsManager.OPTIONS,
			orientationSwapped: SettingsManager.isOrientationSwapped(),
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
