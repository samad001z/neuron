import path from "node:path";
import type { DependencyEdge, DependencyGraph, DependencyNode, RepoFile } from "@/types";

const JS_TS_IMPORT_FROM_REGEX = /import\s+[^"'\n]+\s+from\s+["']([^"']+)["']/g;
const JS_TS_REQUIRE_REGEX = /require\(\s*["']([^"']+)["']\s*\)/g;
const PYTHON_FROM_IMPORT_REGEX = /^\s*from\s+(\.[\w\.]*)\s+import\s+/gm;
const PYTHON_IMPORT_REGEX = /^\s*import\s+(\.[\w\.]*)\b/gm;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".py"];

function normaliseRepoPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function getLabel(filePath: string): string {
	return path.posix.basename(filePath);
}

function extractRelativeImports(file: RepoFile): string[] {
	const imports = new Set<string>();
	const content = file.content;
	const language = file.language.toLowerCase();

	const collectMatches = (regex: RegExp): void => {
		const scopedRegex = new RegExp(regex.source, regex.flags);
		let match: RegExpExecArray | null = scopedRegex.exec(content);

		while (match) {
			const importPath = match[1];

			if (importPath && importPath.startsWith(".")) {
				imports.add(importPath);
			}

			match = scopedRegex.exec(content);
		}
	};

	if (language.includes("typescript") || language.includes("javascript")) {
		collectMatches(JS_TS_IMPORT_FROM_REGEX);
		collectMatches(JS_TS_REQUIRE_REGEX);
	}

	if (language.includes("python")) {
		collectMatches(PYTHON_FROM_IMPORT_REGEX);
		collectMatches(PYTHON_IMPORT_REGEX);
	}

	return Array.from(imports);
}

function resolveRelativeImportPath(importerPath: string, importPath: string, filePathSet: Set<string>): string | null {
	const importerDir = path.posix.dirname(normaliseRepoPath(importerPath));
	const baseResolved = path.posix.normalize(path.posix.join(importerDir, importPath));

	for (const suffix of RESOLUTION_SUFFIXES) {
		const directCandidate = normaliseRepoPath(`${baseResolved}${suffix}`);

		if (filePathSet.has(directCandidate)) {
			return directCandidate;
		}
	}

	for (const suffix of RESOLUTION_SUFFIXES.slice(1)) {
		const indexCandidate = normaliseRepoPath(path.posix.join(baseResolved, `index${suffix}`));

		if (filePathSet.has(indexCandidate)) {
			return indexCandidate;
		}
	}

	return null;
}

export function buildDependencyGraph(files: RepoFile[]): DependencyGraph {
	const normalisedFiles = files.map((file) => ({
		...file,
		path: normaliseRepoPath(file.path),
	}));

	const nodes: DependencyNode[] = normalisedFiles.map((file) => ({
		id: file.path,
		label: getLabel(file.path),
		language: file.language,
	}));

	const filePathSet = new Set<string>(normalisedFiles.map((file) => file.path));
	const edgeSet = new Set<string>();
	const edges: DependencyEdge[] = [];

	for (const file of normalisedFiles) {
		const imports = extractRelativeImports(file);

		for (const importPath of imports) {
			const resolvedTarget = resolveRelativeImportPath(file.path, importPath, filePathSet);

			if (!resolvedTarget) {
				continue;
			}

			const edgeKey = `${file.path}->${resolvedTarget}`;

			if (edgeSet.has(edgeKey)) {
				continue;
			}

			edgeSet.add(edgeKey);
			edges.push({ source: file.path, target: resolvedTarget });
		}
	}

	return { nodes, edges };
}
