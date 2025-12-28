import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * @class HtmlTemplate
 * @brief Utility class for generating HTML templates for webview panels.
 *
 * This class provides methods to load and prepare HTML content for VS Code webview panels,
 * including Content Security Policy (CSP) nonce generation and placeholder replacement.
 */
export class HtmlTemplate {
	/**
	 * @brief Loads and prepares HTML content for a webview.
	 *
	 * This method reads the preview HTML template file, generates security nonce,
	 * and replaces placeholders with actual values for CSP and other configurations.
	 *
	 * @param webview - The VS Code webview instance that will display the HTML
	 * @param extensionUri - The URI of the extension's root directory
	 * @returns The prepared HTML string with all placeholders replaced
	 */
	public static getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const nonce = this.getNonce();

		// Build path using VS Code's URI API
		const htmlUri = vscode.Uri.joinPath(extensionUri, 'out', 'preview', 'preview.html');

		// Read the file using the URI's filesystem path
		let html = fs.readFileSync(htmlUri.fsPath, 'utf8');

		// Replace placeholders with actual values
		html = html.replace(/\{\{nonce}}/g, nonce);
		html = html.replace(/\{\{cspSource}}/g, webview.cspSource);

		return html;
	}

	/**
	 * @brief Generates cryptographically random nonce for Content Security Policy.
	 *
	 * Creates a 32-character random string using alphanumeric characters.
	 * This nonce is used to enhance security by allowing only specific inline scripts
	 * and styles in the webview.
	 *
	 * @returns A random 32-character alphanumeric string
	 */
	private static getNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}
}
