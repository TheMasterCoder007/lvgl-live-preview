import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ResolvedProjectConfig } from '../types';
import { CPP_EXTENSIONS, HEADER_EXTENSIONS } from './languageUtils';

/**
 * @class ProjectResolver
 * @brief Zero-config project discovery for the LVGL preview.
 *
 * When no `.lvgl-live-preview.json` is present, this resolver reproduces what
 * that file used to declare by hand:
 *
 *  - The **main file** is the C/C++ source that *defines* the
 *    `lvgl_live_preview_init()` entry point. If the active editor file defines
 *    it, that file is used directly; otherwise the workspace is scanned for the
 *    single source that does.
 *  - **Dependencies** and **include paths** are derived by walking the local
 *    `#include "…"` graph from the main file: each quoted header is resolved,
 *    its directory becomes an include path, and a sibling source of the same
 *    basename (`foo.h` → `foo.c`/`foo.cpp`) becomes a compiled dependency.
 *
 * `defines` cannot be inferred and are always empty here — a project that needs
 * them (or a non-standard layout) can still add a `.lvgl-live-preview.json`,
 * which takes precedence over this resolver.
 */
export class ProjectResolver {
	/** Directory names skipped when scanning the workspace for the entry point. */
	private static readonly SCAN_EXCLUDE_DIRS = new Set([
		'node_modules',
		'.git',
		'.hg',
		'.svn',
		'out',
		'build',
		'dist',
		'.vscode',
		'.idea',
		'.cache',
	]);

	/** Source extensions considered compilable translation units (C and C++). */
	private static readonly SOURCE_EXTENSIONS = ['.c', ...CPP_EXTENSIONS];

	/**
	 * Matches a *definition* of the preview entry point — the opening brace
	 * distinguishes it from the forward `extern` declaration (which ends in `;`)
	 * that the generated harness emits. Covers both the C form
	 * `void lvgl_live_preview_init(void) {` and the C++ form
	 * `extern "C" void lvgl_live_preview_init(void) {`, with or without `void`.
	 */
	private static readonly ENTRY_DEFINITION_RE =
		/(?:extern\s+"C"\s+)?void\s+lvgl_live_preview_init\s*\(\s*(?:void)?\s*\)\s*\{/;

	/** Upper bound on files touched during a scan/graph walk, as a runaway guard. */
	private static readonly MAX_FILES = 2000;

	/**
	 * @brief Builds a project configuration by auto-detecting the entry point and
	 *        its dependency graph.
	 *
	 * Always returns a config: if no entry point can be found anywhere, it falls
	 * back to the active file as the main file (matching the previous single-file
	 * behavior — the linker's missing-entry-point diagnostic then guides the user).
	 *
	 * @param fileUri URI of the file the preview was started from.
	 * @param outputChannel Output channel for logging.
	 * @returns A ResolvedProjectConfig with absolute paths.
	 */
	public static resolve(
		fileUri: vscode.Uri,
		outputChannel: vscode.OutputChannel
	): ResolvedProjectConfig {
		const activePath = fileUri.fsPath;

		let mainFile = this.findMainFile(activePath, fileUri, outputChannel);
		if (!mainFile) {
			outputChannel.appendLine(
				`Auto-detect: no file defining lvgl_live_preview_init() found; ` +
					`falling back to the active file (${path.basename(activePath)}).`
			);
			mainFile = activePath;
		} else if (mainFile !== activePath) {
			outputChannel.appendLine(
				`Auto-detect: entry point defined in ${mainFile} (not the active file).`
			);
		} else {
			outputChannel.appendLine(`Auto-detect: entry point defined in the active file.`);
		}

		const { dependencies, includePaths } = this.resolveIncludeGraph(mainFile, outputChannel);

		outputChannel.appendLine(
			`Auto-detect: ${dependencies.length} dependency file(s), ` +
				`${includePaths.length} include path(s).`
		);

		return {
			mainFile,
			dependencies,
			includePaths,
			defines: [],
			// Anchor caching/project identity on the main file's directory.
			configFileDir: path.dirname(mainFile),
		};
	}

	/**
	 * @brief Finds the source file that defines the preview entry point.
	 *
	 * Fast path: if the active file defines it, use that without scanning. Otherwise
	 * walk the workspace (or the active file's directory tree when there is no
	 * workspace) looking for the single source that defines it.
	 *
	 * @returns Absolute path to the entry file, or null if none is found.
	 */
	private static findMainFile(
		activePath: string,
		fileUri: vscode.Uri,
		outputChannel: vscode.OutputChannel
	): string | null {
		if (this.fileDefinesEntry(activePath)) {
			return activePath;
		}

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
		const scanRoot = workspaceFolder?.uri.fsPath ?? path.dirname(activePath);

		const matches: string[] = [];
		this.walkSources(scanRoot, (sourcePath) => {
			if (this.fileDefinesEntry(sourcePath)) {
				matches.push(sourcePath);
			}
		});

		if (matches.length === 0) {
			return null;
		}

		if (matches.length === 1) {
			return matches[0];
		}

		// Multiple entry points: prefer the one nearest the active file, and log
		// the rest so an unexpected pick is diagnosable.
		matches.sort((a, b) => this.pathDistance(activePath, a) - this.pathDistance(activePath, b));
		outputChannel.appendLine(
			`Auto-detect: multiple files define lvgl_live_preview_init(); ` +
				`using the nearest one: ${matches[0]}`
		);
		for (const other of matches.slice(1)) {
			outputChannel.appendLine(`  (also found: ${other})`);
		}
		return matches[0];
	}

	/**
	 * @brief Returns true if the file contains a definition of the entry point.
	 */
	private static fileDefinesEntry(filePath: string): boolean {
		if (this.isHeader(filePath) || !this.isSource(filePath)) {
			return false;
		}
		const content = this.readFileSafe(filePath);
		return content !== null && this.ENTRY_DEFINITION_RE.test(content);
	}

	/**
	 * @brief Walks a directory tree invoking `visit` for each C/C++ source file.
	 *
	 * Skips build/VCS directories and stops after MAX_FILES to bound cost.
	 */
	private static walkSources(root: string, visit: (sourcePath: string) => void): void {
		let visited = 0;
		const stack: string[] = [root];

		while (stack.length > 0 && visited < this.MAX_FILES) {
			const dir = stack.pop() as string;

			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (!this.SCAN_EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
						stack.push(path.join(dir, entry.name));
					}
				} else if (entry.isFile() && this.isSource(entry.name) && !this.isHeader(entry.name)) {
					visited++;
					visit(path.join(dir, entry.name));
					if (visited >= this.MAX_FILES) {
						break;
					}
				}
			}
		}
	}

	/**
	 * @brief Derives dependencies and include paths from the `#include` graph.
	 *
	 * Breadth-first over the local (quoted) include graph starting at the main
	 * file. Each resolved header contributes its directory as an include path and,
	 * when a sibling source of the same basename exists, that source as a
	 * dependency. System includes (`#include <…>`) are ignored — those are LVGL,
	 * the C/C++ standard library, or SDL, all provided by the toolchain.
	 */
	private static resolveIncludeGraph(
		mainFile: string,
		outputChannel: vscode.OutputChannel
	): { dependencies: string[]; includePaths: string[] } {
		const mainDir = path.dirname(mainFile);
		const visited = new Set<string>([mainFile]);
		const dependencies = new Set<string>();
		const includeDirs = new Set<string>();

		const queue: string[] = [mainFile];
		let processed = 0;

		while (queue.length > 0 && processed < this.MAX_FILES) {
			const file = queue.shift() as string;
			processed++;

			const content = this.readFileSafe(file);
			if (content === null) {
				continue;
			}

			const includingDir = path.dirname(file);
			for (const include of this.parseQuotedIncludes(content)) {
				const headerPath = this.resolveHeader(include, includingDir, includeDirs, mainDir);
				if (!headerPath) {
					continue;
				}

				includeDirs.add(path.dirname(headerPath));

				if (!visited.has(headerPath)) {
					visited.add(headerPath);
					queue.push(headerPath);
				}

				const siblingSource = this.findSiblingSource(headerPath);
				if (siblingSource && siblingSource !== mainFile && !visited.has(siblingSource)) {
					visited.add(siblingSource);
					dependencies.add(siblingSource);
					queue.push(siblingSource);
				}
			}
		}

		if (processed >= this.MAX_FILES) {
			outputChannel.appendLine(
				`Auto-detect: include graph hit the ${this.MAX_FILES}-file limit; ` +
					`some dependencies may be missing. Add a .lvgl-live-preview.json to override.`
			);
		}

		return {
			dependencies: [...dependencies],
			includePaths: [...includeDirs],
		};
	}

	/**
	 * @brief Resolves a quoted include to an existing header file.
	 *
	 * Tries the including file's directory first, then previously discovered
	 * include directories, then the main file's directory.
	 *
	 * @returns Absolute path to the header, or null if it cannot be resolved.
	 */
	private static resolveHeader(
		include: string,
		includingDir: string,
		includeDirs: Set<string>,
		mainDir: string
	): string | null {
		const candidateDirs = [includingDir, ...includeDirs, mainDir];
		for (const dir of candidateDirs) {
			const candidate = path.resolve(dir, include);
			if (this.isExistingFile(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/**
	 * @brief Finds a source file that pairs with a header (`foo.h` → `foo.c`).
	 *
	 * @returns Absolute path to the sibling source, or null if none exists.
	 */
	private static findSiblingSource(headerPath: string): string | null {
		const dir = path.dirname(headerPath);
		const stem = path.basename(headerPath, path.extname(headerPath));
		for (const ext of this.SOURCE_EXTENSIONS) {
			const candidate = path.join(dir, stem + ext);
			if (this.isExistingFile(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/**
	 * @brief Extracts the targets of quoted `#include "…"` directives.
	 *
	 * Angle-bracket includes are intentionally excluded.
	 */
	private static parseQuotedIncludes(content: string): string[] {
		const includes: string[] = [];
		const re = /^[ \t]*#[ \t]*include[ \t]+"([^"]+)"/gm;
		let match: RegExpExecArray | null;
		while ((match = re.exec(content)) !== null) {
			includes.push(match[1]);
		}
		return includes;
	}

/** Case-insensitive distance metric: how many path segments two files differ by. */
private static pathDistance(from: string, to: string): number {
	const a = path
		.dirname(from)
		.split(path.sep)
		.map((segment) => segment.toLowerCase());
	const b = path
		.dirname(to)
		.split(path.sep)
		.map((segment) => segment.toLowerCase());
	let common = 0;
	while (common < a.length && common < b.length && a[common] === b[common]) {
		common++;
	}
	return a.length - common + (b.length - common);
}

	private static isSource(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		return lower.endsWith('.c') || CPP_EXTENSIONS.some((ext) => lower.endsWith(ext));
	}

	private static isHeader(filePath: string): boolean {
		const lower = filePath.toLowerCase();
		return HEADER_EXTENSIONS.some((ext) => lower.endsWith(ext));
	}

	private static isExistingFile(filePath: string): boolean {
		try {
			return fs.statSync(filePath).isFile();
		} catch {
			return false;
		}
	}

	private static readFileSafe(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, 'utf-8');
		} catch {
			return null;
		}
	}
}
