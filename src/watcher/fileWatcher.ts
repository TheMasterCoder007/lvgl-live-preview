import * as vscode from 'vscode';

/**
 * @class FileWatcher
 * @brief Watches one or more files for changes and triggers a callback with debouncing.
 *
 * This class wraps VS Code's FileSystemWatcher to provide debounced
 * file change notifications, preventing excessive recompilations when
 * the user makes rapid changes to their code.
 *
 * @implements {vscode.Disposable}
 */
export class FileWatcher implements vscode.Disposable {
	private watchers: vscode.FileSystemWatcher[] = [];
	private debounceTimer: NodeJS.Timeout | undefined;
	private readonly callback: (uri: vscode.Uri) => void;
	private readonly debounceDelay: number;

	/**
	 * @constructor
	 * @brief Creates a new FileWatcher instance.
	 *
	 * @param callback - Function to call when any watched file changes
	 * @param debounceDelay - Delay in milliseconds before triggering the callback (default: 300ms)
	 */
	constructor(callback: (uri: vscode.Uri) => void, debounceDelay: number = 300) {
		this.callback = callback;
		this.debounceDelay = debounceDelay;
	}

	/**
	 * @brief Starts watching a single file for changes.
	 *
	 * If watchers already exist, they will be disposed of before creating a new one.
	 *
	 * @param fileUri - URI of the file to watch
	 */
	public watchFile(fileUri: vscode.Uri): void {
		// Dispose existing watchers if any
		this.dispose();

		// Create a new watcher for the specific file
		// Use the file path directly as a glob pattern
		const watcher = vscode.workspace.createFileSystemWatcher(
			fileUri.fsPath,
			true, // ignoreCreateEvents
			false, // ignoreChangeEvents
			true // ignoreDeleteEvents
		);

		// Watch for changes
		watcher.onDidChange((uri) => {
			this.debounce(() => {
				this.callback(uri);
			});
		});

		this.watchers.push(watcher);
	}

	/**
	 * @brief Starts watching multiple files for changes.
	 *
	 * If watchers already exist, they will be disposed of before creating new ones.
	 *
	 * @param fileUris - Array of URIs of files to watch
	 */
	public watchFiles(fileUris: vscode.Uri[]): void {
		// Dispose existing watchers if any
		this.dispose();

		// Create a watcher for each file
		for (const fileUri of fileUris) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				fileUri.fsPath,
				true, // ignoreCreateEvents
				false, // ignoreChangeEvents
				true // ignoreDeleteEvents
			);

			// Watch for changes
			watcher.onDidChange((uri) => {
				this.debounce(() => {
					this.callback(uri);
				});
			});

			this.watchers.push(watcher);
		}
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
	 * @brief Disposes all file watchers and cleans up resources.
	 */
	public dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}

		for (const watcher of this.watchers) {
			watcher.dispose();
		}
		this.watchers = [];
	}
}
