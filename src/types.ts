export interface CompilationResult {
	success: boolean;
	wasmPath?: string;
	jsPath?: string;
	errors: CompilerError[];
	warnings: CompilerWarning[];
}

export interface CompilerError {
	file: string;
	line: number;
	column: number;
	message: string;
	severity: 'error' | 'warning';
}

export interface CompilerWarning {
	file: string;
	line: number;
	column: number;
	message: string;
}

export interface PreviewSettings {
	emccOptimization: string;
	lvglVersion: string;
	displayWidth: number;
	displayHeight: number;
	autoReload: boolean;
	debounceDelay: number;
}

export type ExtensionMessage =
	| { type: 'loadWasm'; wasmBase64: string; jsContent: string }
	| { type: 'showError'; message: string; errors?: CompilerError[] }
	| { type: 'updateSettings'; settings: PreviewSettings }
	| { type: 'compiling' }
	| { type: 'ready' };

export type WebviewMessage = { type: 'ready' } | { type: 'error'; message: string } | { type: 'reload' };

export type PreviewStatus = 'idle' | 'initializing' | 'compiling' | 'running' | 'error';

/**
 * Configuration file schema for .lvgl-live-preview.json
 */
export interface LvglProjectConfig {
	/**
	 * Path to the main C file containing the lvgl_live_preview_init() function
	 */
	mainFile: string;

	/**
	 * Array of dependency C files to compile with the main file
	 */
	dependencies?: string[];

	/**
	 * Global C preprocessor defines to add during compilation
	 */
	defines?: string[];
}

/**
 * Internal representation of project configuration with resolved paths
 */
export interface ResolvedProjectConfig {
	mainFile: string;
	dependencies: string[];
	defines: string[];
	configFileDir: string;
}
