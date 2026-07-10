/**
 * @file languageUtils.ts
 * @brief Shared helpers for the C/C++ sources the preview accepts.
 *
 * The LVGL UI itself is written in C, but a project's entry-point ("glue")
 * file may be C++. Emscripten compiles each input by extension and links
 * libc++ on demand, so no special linker handling is needed; these helpers
 * just centralize which language ids and file extensions count as previewable.
 */

/** File extensions treated as C++ translation units. */
export const CPP_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.c++', '.cppm', '.ixx'];

/**
 * File extensions treated as headers. VS Code reports a `c`/`cpp` languageId for
 * these too, but a header is not a valid preview entry point — compiling one
 * directly produces confusing errors — so they are rejected up front.
 */
export const HEADER_EXTENSIONS = ['.h', '.hpp', '.hh', '.hxx', '.h++', '.hp', '.tcc', '.inc'];

/** VS Code languageIds accepted as previewable LVGL sources. */
export const SUPPORTED_LANGUAGE_IDS = ['c', 'cpp'];

/**
 * @brief Returns true if the given file path is a C++ source file.
 *
 * Detection is by extension (case-insensitive); a plain `.c` file is C.
 *
 * @param filePath Path or file name to inspect.
 */
export function isCppSource(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return CPP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * @brief Returns true if the given file path is a C/C++ header file.
 *
 * Detection is by extension (case-insensitive). Headers share the `c`/`cpp`
 * languageId with sources but cannot be previewed on their own.
 *
 * @param filePath Path or file name to inspect.
 */
export function isHeaderFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return HEADER_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * @brief Returns true if any of the given files is a C++ source file.
 *
 * @param filePaths Paths to inspect.
 */
export function anyCppSource(filePaths: string[]): boolean {
	return filePaths.some(isCppSource);
}
