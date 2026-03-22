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
};

type RepoContentResponse = {
	content?: string;
	encoding?: string;
};

const MAX_FILES = 150;
const GITHUB_API_BASE = "https://api.github.com";
const ALLOWED_EXTENSIONS = new Set<string>([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".java",
	".go",
	".rs",
	".cpp",
	".c",
	".cs",
]);
const SKIP_SEGMENTS = [
	"node_modules",
	".git",
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

	return SKIP_SEGMENTS.some((segment) => lowerPath.includes(segment.toLowerCase()));
}

function detectLanguage(filePath: string): string {
	const extension = getExtension(filePath);
	return LANGUAGE_BY_EXTENSION[extension] ?? "Unknown";
}

function buildHeaders(): HeadersInit {
	const token = process.env.GITHUB_TOKEN;

	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "CodeLens-FileWalker",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		method: "GET",
		headers: buildHeaders(),
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

export async function fetchRepoFiles(repoUrl: string): Promise<RepoFile[]> {
	try {
		const { owner, repo } = parseRepoUrl(repoUrl);
		const treeUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
		const treePayload = await fetchJson<GitTreeResponse>(treeUrl);
		const tree = Array.isArray(treePayload.tree) ? treePayload.tree : [];

		const candidatePaths = tree
			.filter((item) => item.type === "blob")
			.map((item) => item.path)
			.filter((path) => !shouldSkipPath(path))
			.filter((path) => ALLOWED_EXTENSIONS.has(getExtension(path)))
			.slice(0, MAX_FILES);

		const files: RepoFile[] = [];

		for (const path of candidatePaths) {
			try {
				const content = await fetchFileContent(owner, repo, path);

				files.push({
					path,
					content,
					language: detectLanguage(path),
				});
			} catch {
				// Skip files that cannot be decoded or fetched.
			}
		}

		return files;
	} catch (error: unknown) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}

		throw new Error("Failed to fetch repository files");
	}
}
