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
 * @returns {Promise<void>} Resolves when download completes successfully.
 * @throws {Error} If the download fails or receives a non-200 response.
 *
 * @example
 * await downloadFile(
 *   'https://example.com/file.zip',
 *   '/path/to/save/file.zip',
 *   (percent) => console.log(`Downloaded: ${percent}%`)
 * );
 */
export async function downloadFile(url: string, destPath: string, onProgress: ProgressCallback): Promise<void> {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(destPath);

		https
			.get(url, (response) => {
				// Handle redirects
				if (response.statusCode === 302 || response.statusCode === 301) {
					const redirectUrl = response.headers.location;
					if (redirectUrl) {
						file.close();
						fs.unlinkSync(destPath);
						downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject);
						return;
					}
				}

				if (response.statusCode !== 200) {
					file.close();
					if (fs.existsSync(destPath)) {
						fs.unlinkSync(destPath);
					}
					reject(new Error(`Failed to download: ${response.statusCode}`));
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
					resolve();
				});
			})
			.on('error', (err) => {
				file.close();
				if (fs.existsSync(destPath)) {
					fs.unlinkSync(destPath);
				}
				reject(err);
			});
	});
}
