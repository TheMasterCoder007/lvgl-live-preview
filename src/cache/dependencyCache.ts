import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * @interface CachedDependency
 * @brief Represents a cached dependency with its metadata
 */
interface CachedDependency {
	sourcePath: string;
	objectPath: string;
	sourceHash: string;
	lastModified: number;
	settingsHash?: string; // Optional for backward compatibility
}

/**
 * @interface CompilationSettings
 * @brief Represents settings that affect compilation
 */
export interface CompilationSettings {
	lvglVersion: string;
	optimization: string;
	lvglMemorySize: number;
	wasmMemorySize: number;
	includePaths: string[];
	defines: string[];
}

/**
 * @class DependencyCache
 * @brief Manages caching of compiled dependency .o files with change detection.
 *
 * Tracks source file hashes and modification times to determine when
 * dependencies need to be recompiled. Stores compiled .o files in a
 * cache directory organized by project.
 */
export class DependencyCache {
	private readonly cacheDir: string;
	private readonly metadataPath: string;
	private cache: Map<string, CachedDependency>;
	private outputChannel: vscode.OutputChannel;
	private readonly currentSettingsHash: string;

	/**
	 * @constructor
	 * @brief Creates a new DependencyCache instance.
	 *
	 * @param context Extension context for accessing global storage
	 * @param projectId Unique identifier for the project (e.g., hash of a config file path)
	 * @param outputChannel Output channel for logging
	 * @param settings Compilation settings that affect object file compatibility
	 */
	constructor(
		context: vscode.ExtensionContext,
		projectId: string,
		outputChannel: vscode.OutputChannel,
		settings: CompilationSettings
	) {
		this.outputChannel = outputChannel;
		this.cacheDir = path.join(context.globalStorageUri.fsPath, 'dependency-cache', projectId);
		this.metadataPath = path.join(this.cacheDir, 'metadata.json');
		this.cache = new Map();
		this.currentSettingsHash = this.computeSettingsHash(settings);

		// Ensure the cache directory exists
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}

		this.loadMetadata();
	}

	/**
	 * @brief Loads cached metadata from disk.
	 */
	private loadMetadata(): void {
		if (fs.existsSync(this.metadataPath)) {
			try {
				const data = fs.readFileSync(this.metadataPath, 'utf-8');
				const entries: CachedDependency[] = JSON.parse(data);

				for (const entry of entries) {
					this.cache.set(entry.sourcePath, entry);
				}

				this.outputChannel.appendLine(`Loaded ${entries.length} cached dependencies`);
			} catch (error) {
				this.outputChannel.appendLine(`Failed to load cache metadata: ${error}`);
				this.cache.clear();
			}
		}
	}

	/**
	 * @brief Saves cached metadata to disk.
	 */
	private saveMetadata(): void {
		try {
			const entries = Array.from(this.cache.values());
			fs.writeFileSync(this.metadataPath, JSON.stringify(entries, null, 2), 'utf-8');
		} catch (error) {
			this.outputChannel.appendLine(`Failed to save cache metadata: ${error}`);
		}
	}

	/**
	 * @brief Computes SHA-256 hash of a file.
	 *
	 * @param filePath Path to the file
	 * @returns Hex-encoded hash string
	 */
	private computeFileHash(filePath: string): string {
		const content = fs.readFileSync(filePath);
		return crypto.createHash('sha256').update(content).digest('hex');
	}

	/**
	 * @brief Computes a hash of compilation settings.
	 *
	 * @param settings Compilation settings
	 * @returns Hex-encoded hash string
	 */
	private computeSettingsHash(settings: CompilationSettings): string {
		// Sort arrays for consistent hashing
		const normalized = {
			lvglVersion: settings.lvglVersion,
			optimization: settings.optimization,
			lvglMemorySize: settings.lvglMemorySize,
			wasmMemorySize: settings.wasmMemorySize,
			includePaths: [...settings.includePaths].sort(),
			defines: [...settings.defines].sort(),
		};
		const settingsString = JSON.stringify(normalized);
		return crypto.createHash('sha256').update(settingsString).digest('hex').substring(0, 16);
	}

	/**
	 * @brief Checks if a cached object file is still valid.
	 *
	 * Validates that:
	 * - The object file exists
	 * - The source file hasn't been modified
	 * - The source file hash matches
	 * - The compilation settings haven't changed
	 *
	 * @param sourcePath Path to the source C file
	 * @returns true if cache is valid, false if recompilation is needed
	 */
	public isCacheValid(sourcePath: string): boolean {
		const cached = this.cache.get(sourcePath);
		if (!cached) {
			return false;
		}

		// Check if compilation settings changed
		if (cached.settingsHash && cached.settingsHash !== this.currentSettingsHash) {
			this.outputChannel.appendLine(
				`Cache miss: ${path.basename(sourcePath)} - compilation settings changed`
			);
			return false;
		}

		// Check if an object file exists
		if (!fs.existsSync(cached.objectPath)) {
			this.outputChannel.appendLine(`Cache miss: object file not found for ${path.basename(sourcePath)}`);
			return false;
		}

		// Check if a source file still exists
		if (!fs.existsSync(sourcePath)) {
			this.outputChannel.appendLine(`Cache miss: source file not found ${path.basename(sourcePath)}`);
			return false;
		}

		// Check modification time
		const stat = fs.statSync(sourcePath);
		if (stat.mtimeMs !== cached.lastModified) {
			this.outputChannel.appendLine(`Cache miss: ${path.basename(sourcePath)} was modified`);
			return false;
		}

		// Optionally check hash for extra safety
		const currentHash = this.computeFileHash(sourcePath);
		if (currentHash !== cached.sourceHash) {
			this.outputChannel.appendLine(`Cache miss: ${path.basename(sourcePath)} hash changed`);
			return false;
		}

		return true;
	}

	/**
	 * @brief Gets the cached object file path for a source file.
	 *
	 * @param sourcePath Path to the source C file
	 * @returns Path to the cached object file, or null if not cached
	 */
	public getCachedObject(sourcePath: string): string | null {
		if (!this.isCacheValid(sourcePath)) {
			return null;
		}

		const cached = this.cache.get(sourcePath);
		return cached ? cached.objectPath : null;
	}

	/**
	 * @brief Updates the cache with a newly compiled object file.
	 *
	 * @param sourcePath Path to the source C file
	 * @param objectPath Path to the compiled object file
	 */
	public updateCache(sourcePath: string, objectPath: string): void {
		const stat = fs.statSync(sourcePath);
		const hash = this.computeFileHash(sourcePath);

		const entry: CachedDependency = {
			sourcePath,
			objectPath,
			sourceHash: hash,
			lastModified: stat.mtimeMs,
			settingsHash: this.currentSettingsHash,
		};

		this.cache.set(sourcePath, entry);
		this.saveMetadata();
	}

	/**
	 * @brief Gets the cache directory path.
	 *
	 * @returns Path to the cache directory
	 */
	public getCacheDir(): string {
		return this.cacheDir;
	}

	/**
	 * @brief Gets all cached object files that are still valid.
	 *
	 * @param sourcePaths Array of source file paths
	 * @returns Map of source paths to object paths for valid cached files
	 */
	public getValidCachedObjects(sourcePaths: string[]): Map<string, string> {
		const validCache = new Map<string, string>();

		for (const sourcePath of sourcePaths) {
			const objectPath = this.getCachedObject(sourcePath);
			if (objectPath) {
				validCache.set(sourcePath, objectPath);
			}
		}

		return validCache;
	}

	/**
	 * @brief Clears the entire cache.
	 */
	public clear(): void {
		this.cache.clear();

		// Delete all files in the cache directory
		if (fs.existsSync(this.cacheDir)) {
			const files = fs.readdirSync(this.cacheDir);
			for (const file of files) {
				const filePath = path.join(this.cacheDir, file);
				try {
					fs.rmSync(filePath);
				} catch (error) {
					this.outputChannel.appendLine(`Failed to delete ${filePath}: ${error}`);
				}
			}
		}

		this.outputChannel.appendLine('Dependency cache cleared');
	}
}
