import * as fs from 'fs';
import * as https from 'https';

/**
 * @callback ProgressCallback
 * @brief Progress callback type for download operations.
 *
 * @param {number} percent - Download progress percentage (0-100).
 */
export type ProgressCallback = (percent: number) => void;

/**
 * @brief Downloads a file from a URL with support for HTTP redirects and progress tracking.
 *
 * @description
 * This function handles:
 * - HTTP 301/302 redirects automatically
 * - Progress reporting via callback
 * - Cleanup of partial downloads on failure
 *
 * @param {string} url - The URL to download from.
 * @param {string} destPath - The local file path to save the download.
 * @param {ProgressCallback} onProgress - Callback invoked with download progress percentage.
 * @param {AbortSignal} [signal] - Optional signal to cancel the download in progress.
 * @returns {Promise<void>} Resolves when download completes successfully.
 * @throws {Error} If the download fails, receives a non-200 response, or is canceled.
 *
 * @example
 * await downloadFile(
 *   'https://example.com/file.zip',
 *   '/path/to/save/file.zip',
 *   (percent) => console.log(`Downloaded: ${percent}%`)
 * );
 */
export async function downloadFile(
	url: string,
	destPath: string,
	onProgress: ProgressCallback,
	signal?: AbortSignal
): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = (): void => {
			if (fs.existsSync(destPath)) {
				try {
					fs.unlinkSync(destPath);
				} catch {
					// Ignore cleanup failures
				}
			}
		};

		if (signal?.aborted) {
			reject(new Error('Download cancelled'));
			return;
		}

		// Settle the promise exactly once and detach the abort listener, so an abort of
		// the (possibly reused) signal after the download finishes can't run cleanup()
		// or reject() on an already-settled download.
		let settled = false;
		const finalize = (action: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener('abort', onAbort);
			action();
		};

		const onAbort = (): void => {
			finalize(() => {
				request.destroy();
				file.close();
				cleanup();
				reject(new Error('Download cancelled'));
			});
		};

		const file = fs.createWriteStream(destPath);

		const request = https
			.get(url, (response) => {
				// Handle redirects
				if (response.statusCode === 302 || response.statusCode === 301) {
					const redirectUrl = response.headers.location;
					if (redirectUrl) {
						file.close();
						cleanup();
						// Hand off to the recursive call, which manages its own abort listener.
						finalize(() => downloadFile(redirectUrl, destPath, onProgress, signal).then(resolve, reject));
						return;
					}
				}

				if (response.statusCode !== 200) {
					file.close();
					cleanup();
					finalize(() => reject(new Error(`Failed to download: ${response.statusCode}`)));
					return;
				}

				const totalSize = parseInt(response.headers['content-length'] || '0', 10);
				let downloadedSize = 0;

				response.on('data', (chunk) => {
					downloadedSize += chunk.length;
					if (totalSize > 0) {
						const percent = Math.floor((downloadedSize / totalSize) * 100);
						onProgress(percent);
					}
				});

				response.pipe(file);

				file.on('finish', () => {
					file.close();
					finalize(resolve);
				});
			})
			.on('error', (err) => {
				file.close();
				cleanup();
				finalize(() => reject(err));
			});

		// Cancel the in-flight download when the signal aborts.
		signal?.addEventListener('abort', onAbort);
	});
}
