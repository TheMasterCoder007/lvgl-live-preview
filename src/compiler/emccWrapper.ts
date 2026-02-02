import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as util from 'util';
import { CompilationResult, CompilerError } from '../types';
import { EmsdkInstaller } from './emsdkInstaller';

const execFile = util.promisify(child_process.execFile);

/**
 * @class EmccWrapper
 * @brief Wrapper class for Emscripten compiler (emcc) operations.
 *
 * Provides methods to compile C/C++ source files to WebAssembly using
 * the Emscripten toolchain. Supports both full compilation and incremental
 * compilation using pre-compiled object files for faster rebuild times.
 */
export class EmccWrapper {
	private emsdkInstaller: EmsdkInstaller;
	private outputChannel: vscode.OutputChannel;

	/**
	 * @constructor
	 * @brief Creates a new EmccWrapper instance.
	 *
	 * @param context VS Code extension context for accessing extension storage paths.
	 * @param outputChannel Output channel for displaying compilation logs to the user.
	 */
	constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.emsdkInstaller = new EmsdkInstaller(context, outputChannel);
	}

	/**
	 * @brief Parses compiler output to extract structured error and warning information.
	 *
	 * Parses GCC/Clang style error messages in the format:
	 * `file:line:column: error|warning: message`
	 *
	 * @param output Raw compiler output string (typically from stderr).
	 * @returns Array of CompilerError objects containing parsed error/warning details.
	 */
	private parseCompilerOutput(output: string): CompilerError[] {
		const errors: CompilerError[] = [];
		const lines = output.split('\n');

		for (const line of lines) {
			// Parse GCC/Clang style error messages
			// Format: file:line:column: error: message
			const match = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/);

			if (match) {
				const [, file, lineStr, colStr, severity, message] = match;
				errors.push({
					file,
					line: parseInt(lineStr, 10),
					column: parseInt(colStr, 10),
					severity: severity as 'error' | 'warning',
					message: message.trim(),
				});
			}
		}

		return errors;
	}

	/**
	 * @brief Compiles source files to object files for incremental builds.
	 *
	 * Compiles source files in parallel batches to improve build performance.
	 * Object files can be reused in later builds to avoid recompiling
	 * unchanged sources.
	 *
	 * @param sourceFiles Array of source file paths to compile.
	 * @param outputDir Directory where object files will be written.
	 * @param includePaths Array of include directory paths.
	 * @param optimization Optimization level flag (default: '-O2').
	 * @param defines Array of preprocessor defines to add (optional).
	 * @returns Promise resolving to an array of successfully compiled object file paths.
	 */
	public async compileToObjects(
		sourceFiles: string[],
		outputDir: string,
		includePaths: string[],
		optimization: string = '-O2',
		defines: string[] = []
	): Promise<string[]> {
		const emccPath = this.emsdkInstaller.getEmccPath();
		const objectFiles: string[] = [];

		// Compile files in parallel batches for speed
		const batchSize = 10;
		for (let i = 0; i < sourceFiles.length; i += batchSize) {
			const batch = sourceFiles.slice(i, Math.min(i + batchSize, sourceFiles.length));

			const promises = batch.map(async (sourceFile) => {
				const baseName = path.basename(sourceFile, '.c');
				const objFile = path.join(outputDir, `${baseName}.o`);

				// Build args array for execFile
				const args = [
					optimization,
					'-DLVGL_LIVE_PREVIEW',
					...defines.map((d) => `-D${d}`),
					'-c',
					sourceFile,
					'-o',
					objFile,
					...includePaths.map((p) => `-I${p}`),
				];

				try {
					await execFile(emccPath, args, {
						maxBuffer: 10 * 1024 * 1024,
						shell: process.platform === 'win32', // Use shell on Windows for .bat files
					});
					return objFile;
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					this.outputChannel.appendLine(`Failed to compile ${baseName}: ${message}`);
					return null;
				}
			});

			const results = await Promise.all(promises);
			const successfulObjects = results.filter((obj) => obj !== null) as string[];
			objectFiles.push(...successfulObjects);

			if ((i + batchSize) % 50 === 0 || i + batchSize >= sourceFiles.length) {
				this.outputChannel.appendLine(
					`  Compiled ${Math.min(i + batchSize, sourceFiles.length)}/${sourceFiles.length} files...`
				);
			}
		}

		return objectFiles;
	}

	/**
	 * @brief Performs fast incremental compilation using pre-compiled object files.
	 *
	 * Links user source files with pre-compiled LVGL object files for significantly
	 * faster rebuild times. Uses -O0 for linking since object files are already
	 * optimized and disables runtime checks for additional speed.
	 *
	 * @param sourceFile Path to the user source file to compile.
	 * @param outputDir Directory where compiled output files will be written.
	 * @param objectFiles Array of pre-compiled object file paths to link.
	 * @param lvglIncludePath Path to LVGL include directory.
	 * @param mainFile Path to the main entry point file.
	 * @param dependencyObjects Array of dependency object file paths (optional).
	 * @param userIncludePaths Array of user-specified include paths (optional).
	 * @param defines Array of preprocessor defines (optional).
	 * @param additionalSourceFiles Array of additional source files to compile alongside main and user files (optional).
	 * @param wasmMemoryMB Memory size in MB for the generated WebAssembly module (default: 128).
	 * @returns Promise resolving to CompilationResult with success status, output paths, and any errors/warnings.
	 */
	public async compileWithObjects(
		sourceFile: string,
		outputDir: string,
		objectFiles: string[],
		lvglIncludePath: string,
		mainFile: string,
		dependencyObjects: string[] = [],
		userIncludePaths: string[] = [],
		defines: string[] = [],
		additionalSourceFiles: string[] = [],
		wasmMemoryMB: number = 128
	): Promise<CompilationResult> {
		const emccPath = this.emsdkInstaller.getEmccPath();
		const outputName = path.join(outputDir, 'output');
		const jsPath = `${outputName}.js`;
		const wasmPath = `${outputName}.wasm`;

		// Use response file for object files to avoid command line length
		const responseFilePath = path.join(outputDir, 'objects.txt');
		const allObjects = [...objectFiles, ...dependencyObjects];
		const normalizedObjects = allObjects.map((o) => `"${o.replace(/\\/g, '/')}"`);
		fs.writeFileSync(responseFilePath, normalizedObjects.join('\n'), 'utf-8');

		const fileCount = 2 + (dependencyObjects.length > 0 ? dependencyObjects.length : 0) + additionalSourceFiles.length;
		this.outputChannel.appendLine(
			`Fast compilation: ${fileCount} user files + ${objectFiles.length} LVGL objects`
		);

		// Stack size configuration
		const STACK_SIZE_MB = 5;

		// Use -O0 for linking to maximize speed (objects are already optimized)
		// Use --no-entry-point and other flags to speed up linking
		const args = [
			'-O0', // Fast linking, objects already optimized
			'-DLVGL_LIVE_PREVIEW',
			...defines.map((d) => `-D${d}`),
			'-s',
			'WASM=1',
			'-s',
			'USE_SDL=2',
			'-s',
			'ALLOW_MEMORY_GROWTH=1',
			'-s',
			'EXPORTED_FUNCTIONS=["_main"]',
			'-s',
			'EXPORTED_RUNTIME_METHODS=["ccall","cwrap"]',
			'-s',
			`INITIAL_MEMORY=${wasmMemoryMB * 1024 * 1024}`,
			'-s',
			`STACK_SIZE=${STACK_SIZE_MB * 1024 * 1024}`,
			'-s',
			'ASSERTIONS=0', // Disable assertions for speed
			'-s',
			'SAFE_HEAP=0', // Disable safe heap for speed
			`-I${lvglIncludePath}`,
			`-I${path.join(lvglIncludePath, 'src')}`,
			...userIncludePaths.map((p) => `-I${p}`),
			mainFile,
			sourceFile,
			...additionalSourceFiles,
			`@${responseFilePath}`,
			'-o',
			jsPath,
		];

		try {
			const startTime = Date.now();

			const { stderr, stdout } = await execFile(emccPath, args, {
				cwd: outputDir,
				maxBuffer: 10 * 1024 * 1024,
				timeout: 120000, // 2-minute timeout for a first-time SDL2 build
				shell: process.platform === 'win32', // Use shell on Windows for .bat files
			});

			const duration = Date.now() - startTime;
			this.outputChannel.appendLine(`✓ Compilation completed in ${duration}ms`);

			// Log stdout if it contains useful info (like port downloads)
			if (stdout && (stdout.includes('port:') || stdout.includes('cache:'))) {
				this.outputChannel.appendLine(stdout);
			}

			if (stderr && stderr.includes('error')) {
				this.outputChannel.appendLine(stderr);
			}

			const errors = this.parseCompilerOutput(stderr || '');
			const warnings = errors.filter((e) => e.severity === 'warning');
			const actualErrors = errors.filter((e) => e.severity === 'error');

			return {
				success: actualErrors.length === 0,
				wasmPath,
				jsPath,
				errors: actualErrors,
				warnings,
			};
		} catch (error: unknown) {
			const err = error as { stderr?: string; stdout?: string; message?: string };
			this.outputChannel.appendLine(`✗ Compilation failed: ${err.message ?? 'Unknown error'}`);

			// Log full output for debugging
			if (err.stdout) {
				this.outputChannel.appendLine('stdout:');
				this.outputChannel.appendLine(err.stdout);
			}
			if (err.stderr) {
				this.outputChannel.appendLine('stderr:');
				this.outputChannel.appendLine(err.stderr);
			}

			const errorOutput = err.stderr || err.stdout || err.message || '';
			const errors = this.parseCompilerOutput(errorOutput);

			return {
				success: false,
				errors,
				warnings: [],
			};
		}
	}
}
