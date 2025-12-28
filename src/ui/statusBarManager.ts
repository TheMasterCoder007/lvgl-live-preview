import * as vscode from 'vscode';
import { PreviewStatus } from '../types';

/**
 * @class StatusBarManager
 * @brief Manages the VS Code status bar item for LVGL Preview extension
 *
 * This class handles the creation, updating, and lifecycle management of the status bar item
 * that displays the current state of the LVGL preview (idle, initializing, compiling, running, or error).
 * It provides visual feedback through icons, text, colors, and tooltips to indicate the preview status
 * and LVGL version information.
 *
 * The status bar item is positioned on the right side of the VS Code status bar and is clickable
 * to trigger the 'lvgl-preview.start' command.
 *
 * @implements {vscode.Disposable}
 */
export class StatusBarManager implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private currentStatus: PreviewStatus = 'idle';

	/**
	 * @constructor
	 * @brief Constructs a new StatusBarManager instance
	 *
	 * Creates and configures the status bar item with:
	 * - Right alignment in the VS Code status bar
	 * - Priority of 100
	 * - Command binding to 'lvgl-preview.start'
	 * - Initial status display and visibility
	 */
	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBarItem.command = 'lvgl-preview.start';
		this.updateStatusBar();
		this.statusBarItem.show();
	}

	/**
	 * @brief Updates the current preview status and refreshes the status bar display
	 *
	 * @param status The new preview status (idle, initializing, compiling, running, or error)
	 * @param message Optional custom message to display instead of the default status text
	 */
	public setStatus(status: PreviewStatus, message?: string) {
		this.currentStatus = status;
		this.updateStatusBar(message);
	}

	/**
	 * @brief Updates the status bar item's visual appearance based on current status
	 *
	 * This method handles:
	 * - Icon selection based on current status (with animations for loading states)
	 * - Text display with custom message override support
	 * - Tooltip configuration
	 * - Background color changes for error states
	 *
	 * @param customMessage Optional custom message to override the default status text
	 */
	private updateStatusBar(customMessage?: string) {
		const statusIcons: Record<PreviewStatus, string> = {
			idle: '$(circle-outline)',
			initializing: '$(loading~spin)',
			compiling: '$(loading~spin)',
			running: '$(circle-filled)',
			error: '$(error)',
		};

		const statusTexts: Record<PreviewStatus, string> = {
			idle: 'LVGL Preview',
			initializing: 'LVGL Preview: Initializing...',
			compiling: 'LVGL Preview: Compiling...',
			running: 'LVGL Preview: Running',
			error: 'LVGL Preview: Error',
		};

		const icon = statusIcons[this.currentStatus];
		const text = customMessage || statusTexts[this.currentStatus];

		this.statusBarItem.text = `${icon} ${text}`;

		// Update tooltip
		this.statusBarItem.tooltip = 'Click to start LVGL preview';

		if (this.currentStatus === 'error') {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	/**
	 * @brief Disposes of the status bar item and releases resources
	 *
	 * Called when the extension is deactivated or the StatusBarManager is no longer needed.
	 * Implements vscode.Disposable interface.
	 */
	dispose() {
		this.statusBarItem.dispose();
	}
}
