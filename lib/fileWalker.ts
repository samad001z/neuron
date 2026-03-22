import type { RepoFile } from "@/types";

type ParsedRepo = {
	owner: string;
	repo: string;
};

type GitTreeItem = {
	path: string;
	type: string;
};

type GitTreeResponse = {
	tree?: GitTreeItem[];
	truncated?: boolean;
};

type RepoContentResponse = {
	content?: string;
	encoding?: string;
};

const MAX_FILES = 150;
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_HEADERS: HeadersInit = {
	Accept: "application/vnd.github.v3+json",
	"User-Agent": "Neuron-App",
	...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};
const CODE_EXTENSIONS = new Set<string>([
	"ts",
	"tsx",
	"js",
	"jsx",
	"py",
	"java",
	"go",
	"rs",
	"cpp",
	"c",
	"cs",
	"rb",
	"php",
	"swift",
	"kt",
	"vue",
	"svelte",
	"html",
	"css",
	"scss",
]);
const EXCLUDED_PATH_SEGMENTS = [
	"node_modules",
	"coverage",
	".git",
	"vendor",
	".cache",
	"dist",
	"build",
	"__pycache__",
	".next",
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".py": "Python",
	".java": "Java",
	".go": "Go",
	".rs": "Rust",
	".cpp": "C++",
	".c": "C",
	".cs": "C#",
	".rb": "Ruby",
	".php": "PHP",
	".swift": "Swift",
	".kt": "Kotlin",
	".vue": "Vue",
	".svelte": "Svelte",
	".html": "HTML",
	".css": "CSS",
	".scss": "SCSS",
};

function parseRepoUrl(repoUrl: string): ParsedRepo {
	let parsed: URL;

	try {
		parsed = new URL(repoUrl);
	} catch {
		throw new Error("Invalid GitHub URL. Expected format: https://github.com/owner/repo");
	}

	if (parsed.hostname !== "github.com") {
		throw new Error("Invalid GitHub URL. Host must be github.com");
	}

	const parts = parsed.pathname
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);

	if (parts.length < 2) {
		throw new Error("Invalid GitHub URL. Missing owner or repository name");
	}

	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, "");

	if (!owner || !repo) {
		throw new Error("Invalid GitHub URL. Missing owner or repository name");
	}

	return { owner, repo };
}

function getExtension(filePath: string): string {
	const dotIndex = filePath.lastIndexOf(".");
	return dotIndex === -1 ? "" : filePath.slice(dotIndex).toLowerCase();
}

function shouldSkipPath(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();

	return EXCLUDED_PATH_SEGMENTS.some((segment) => lowerPath.includes(segment.toLowerCase()));
}

function isCodeFile(filePath: string): boolean {
	const extension = getExtension(filePath);
	if (!extension) {
		return false;
	}

	return CODE_EXTENSIONS.has(extension.slice(1));
}

function isExcludedPath(filePath: string): boolean {
	return shouldSkipPath(filePath);
}

function detectLanguage(filePath: string): string {
	const extension = getExtension(filePath);
	return LANGUAGE_BY_EXTENSION[extension] ?? "Unknown";
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		method: "GET",
		headers: GITHUB_HEADERS,
		cache: "no-store",
	});

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error("Repository not found, inaccessible, or private");
		}

		if (response.status === 401 || response.status === 403) {
			throw new Error("GitHub API access denied or rate-limited");
		}

		throw new Error(`GitHub API request failed with status ${response.status}`);
	}

	return (await response.json()) as T;
}

async function fetchFileContent(owner: string, repo: string, path: string): Promise<string> {
	const encodedPath = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodedPath}`;
	const payload = await fetchJson<RepoContentResponse>(url);

	if (payload.encoding !== "base64" || !payload.content) {
		throw new Error(`Unsupported content encoding for ${path}`);
	}

	const normalisedBase64 = payload.content.replace(/\n/g, "");
	return Buffer.from(normalisedBase64, "base64").toString("utf-8");
}

async function fetchSingleFile(owner: string, repo: string, path: string): Promise<RepoFile> {
	const content = await fetchFileContent(owner, repo, path);

	return {
		path,
		content,
		language: detectLanguage(path),
	};
}

async function fetchAllFiles(
	owner: string,
	repo: string,
	paths: string[],
	onProgress?: (current: number, total: number) => void,
): Promise<RepoFile[]> {
	const BATCH_SIZE = 10;
	const results: RepoFile[] = [];
	const total = paths.length;
	let current = 0;

	if (onProgress) {
		onProgress(0, total);
	}

	for (let index = 0; index < paths.length; index += BATCH_SIZE) {
		const batch = paths.slice(index, index + BATCH_SIZE);

		const batchResults = await Promise.allSettled(
			batch.map((path) => fetchSingleFile(owner, repo, path)),
		);

		batchResults.forEach((result, batchIndex) => {
			current += 1;

			if (result.status === "fulfilled") {
				results.push(result.value);
				if (onProgress) {
					onProgress(current, total);
				}
				return;
			}

			console.warn(`[fileWalker] Skipped ${batch[batchIndex]} - fetch failed`);
			if (onProgress) {
				onProgress(current, total);
			}
		});

		if (index + BATCH_SIZE < paths.length) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	return results;
}

export async function fetchRepoFiles(
	repoUrl: string,
	onProgress?: (current: number, total: number) => void,
): Promise<RepoFile[]> {
	try {
		const { owner, repo } = parseRepoUrl(repoUrl);
		const treeUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
		const treePayload = await fetchJson<GitTreeResponse>(treeUrl);
		const tree = Array.isArray(treePayload.tree) ? treePayload.tree : [];

		if (treePayload.truncated) {
			console.warn("[fileWalker] Tree truncated - repo too large, using first 150 files");
		}

		const candidatePaths = tree
			.filter((item) => item.type === "blob")
			.map((item) => item.path)
			.filter((path) => isCodeFile(path))
			.filter((path) => !isExcludedPath(path))
			.slice(0, MAX_FILES);

		return await fetchAllFiles(owner, repo, candidatePaths, onProgress);
	} catch (error: unknown) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}

		throw new Error("Failed to fetch repository files");
	}
}
