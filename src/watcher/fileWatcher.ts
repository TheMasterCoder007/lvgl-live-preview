import * as vscode from 'vscode';

/**
 * @class FileWatcher
 * @brief Watches a file for changes and triggers a callback with debouncing.
 *
 * This class wraps VS Code's FileSystemWatcher to provide debounced
 * file change notifications, preventing excessive recompilations when
 * the user makes rapid changes to their code.
 *
 * @implements {vscode.Disposable}
 */
export class FileWatcher implements vscode.Disposable {
	private watcher: vscode.FileSystemWatcher | undefined;
	private debounceTimer: NodeJS.Timeout | undefined;
	private readonly callback: (uri: vscode.Uri) => void;
	private readonly debounceDelay: number;

	/**
	 * @constructor
	 * @brief Creates a new FileWatcher instance.
	 *
	 * @param callback - Function to call when the file changes
	 * @param debounceDelay - Delay in milliseconds before triggering the callback (default: 300ms)
	 */
	constructor(callback: (uri: vscode.Uri) => void, debounceDelay: number = 300) {
		this.callback = callback;
		this.debounceDelay = debounceDelay;
	}

	/**
	 * @brief Starts watching a file for changes.
	 *
	 * If a watcher already exists, it will be disposed of before creating a new one.
	 *
	 * @param fileUri - URI of the file to watch
	 */
	public watchFile(fileUri: vscode.Uri): void {
		// Dispose existing watcher if any
		this.dispose();

		// Create a new watcher for the specific file
		// Use the file path directly as a glob pattern
		this.watcher = vscode.workspace.createFileSystemWatcher(
			fileUri.fsPath,
			true, // ignoreCreateEvents
			false, // ignoreChangeEvents
			true // ignoreDeleteEvents
		);

		// Watch for changes
		this.watcher.onDidChange((uri) => {
			this.debounce(() => {
				this.callback(uri);
			});
		});
	}

	/**
	 * @brief Debounce function calls to prevent excessive executions.
	 *
	 * @param func - The function to debounce
	 */
	private debounce(func: () => void): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			func();
			this.debounceTimer = undefined;
		}, this.debounceDelay);
	}

	/**
	 * @brief Disposes the file watcher and cleans up resources.
	 */
	public dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}

		if (this.watcher) {
			this.watcher.dispose();
			this.watcher = undefined;
		}
	}
}
