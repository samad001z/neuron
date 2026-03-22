import { embedText, summariseFile } from "@/lib/gemini";
import { fetchRepoFiles } from "@/lib/fileWalker";
import { buildDependencyGraph } from "@/lib/graphBuilder";
import type { IngestedRepo, RepoFile } from "@/types";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const MAX_CODEBASE_CHARS = 800_000;
const SUMMARY_BATCH_SIZE = 5;
const EMBEDDING_BATCH_SIZE = 10;
const CHUNK_SIZE = 1800;

type SessionRow = {
	id: string;
	user_id: string;
	repo_url: string;
	repo_name: string | null;
	file_count: number;
	graph: unknown;
	created_at: string;
};

type CodebaseCacheRow = {
	session_id: string;
	codebase_text: string;
	cached_at: string;
	sessions: SessionRow | SessionRow[];
};

type FileChunkRow = {
	file_path: string;
	language: string | null;
	chunk_text: string;
	summary: string | null;
};

type ChunkInsertRow = {
	session_id: string;
	file_path: string;
	language: string;
	chunk_text: string;
	summary: string;
};

function isMissingUserIdColumnError(message?: string): boolean {
	if (!message) {
		return false;
	}

	const lower = message.toLowerCase();
	return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

function buildCodebaseText(files: RepoFile[]): string {
	let text = "";

	for (const file of files) {
		const section = `=== FILE: ${file.path} ===\n${file.content}\n\n`;
		const nextLength = text.length + section.length;

		if (nextLength <= MAX_CODEBASE_CHARS) {
			text += section;
			continue;
		}

		const remaining = MAX_CODEBASE_CHARS - text.length;

		if (remaining > 0) {
			text += section.slice(0, remaining);
		}

		break;
	}

	return text;
}

function splitText(content: string): string[] {
	const trimmed = content.trim();

	if (!trimmed) {
		return [""];
	}

	const chunks: string[] = [];

	for (let index = 0; index < trimmed.length; index += CHUNK_SIZE) {
		chunks.push(trimmed.slice(index, index + CHUNK_SIZE));
	}

	return chunks;
}

function getRepoName(repoUrl: string): string {
	const parts = repoUrl.replace(/\/+$/, "").split("/");
	if (parts.length >= 2) {
		return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
	}

	return parts[parts.length - 1] || "unknown";
}

function emptyGraph() {
	return { nodes: [], edges: [] };
}

function normaliseSessionRelation(sessionRelation: SessionRow | SessionRow[] | undefined): SessionRow | null {
	if (!sessionRelation) {
		return null;
	}

	if (Array.isArray(sessionRelation)) {
		return sessionRelation[0] ?? null;
	}

	return sessionRelation;
}

async function tryGetCachedIngestion(repoUrl: string, userId: string): Promise<IngestedRepo | null> {
	const thresholdIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const { data: cacheRows, error: cacheError } = await supabaseAdmin
		.from("codebase_cache")
		.select("session_id, codebase_text, cached_at, sessions!inner(id, user_id, repo_url, repo_name, file_count, graph, created_at)")
		.eq("sessions.repo_url", repoUrl)
		.eq("sessions.user_id", userId)
		.gte("cached_at", thresholdIso)
		.order("cached_at", { ascending: false })
		.limit(1);

	if (cacheError && isMissingUserIdColumnError(cacheError.message)) {
		console.warn("[ingestRepo] sessions.user_id missing; using compatibility cache lookup without owner filter");

		const fallback = await supabaseAdmin
			.from("codebase_cache")
			.select("session_id, codebase_text, cached_at, sessions!inner(id, repo_url, repo_name, file_count, graph, created_at)")
			.eq("sessions.repo_url", repoUrl)
			.gte("cached_at", thresholdIso)
			.order("cached_at", { ascending: false })
			.limit(1);

		if (fallback.error || !fallback.data || fallback.data.length === 0) {
			return null;
		}

		const fallbackEntry = fallback.data[0] as unknown as CodebaseCacheRow;
		const fallbackSession = normaliseSessionRelation(fallbackEntry.sessions);

		if (!fallbackSession) {
			return null;
		}

		const { data: chunkRows, error: chunkError } = await supabaseAdmin
			.from("file_chunks")
			.select("file_path, language, chunk_text, summary")
			.eq("session_id", fallbackSession.id)
			.order("created_at", { ascending: true });

		if (chunkError || !chunkRows) {
			return null;
		}

		const filesByPath = new Map<string, RepoFile>();
		const summaries: Record<string, string> = {};

		for (const row of chunkRows as unknown as FileChunkRow[]) {
			const existing = filesByPath.get(row.file_path);
			const language = row.language ?? "Unknown";

			if (!existing) {
				filesByPath.set(row.file_path, {
					path: row.file_path,
					language,
					content: row.chunk_text,
				});
			} else {
				existing.content = `${existing.content}\n${row.chunk_text}`;
			}

			if (!summaries[row.file_path] && row.summary) {
				summaries[row.file_path] = row.summary;
			}
		}

		const files = Array.from(filesByPath.values());
		const graph =
			fallbackSession.graph && typeof fallbackSession.graph === "object"
				? fallbackSession.graph
				: emptyGraph();

		return {
			sessionId: fallbackSession.id,
			files,
			codebaseText: fallbackEntry.codebase_text,
			graph: graph as IngestedRepo["graph"],
			fileSummaries: summaries,
		};
	}

	if (cacheError || !cacheRows || cacheRows.length === 0) {
		return null;
	}

	const cacheEntry = cacheRows[0] as unknown as CodebaseCacheRow;
	const sessionRow = normaliseSessionRelation(cacheEntry.sessions);

	if (!sessionRow) {
		return null;
	}

	const { data: chunkRows, error: chunkError } = await supabaseAdmin
		.from("file_chunks")
		.select("file_path, language, chunk_text, summary")
		.eq("session_id", sessionRow.id)
		.order("created_at", { ascending: true });

	if (chunkError || !chunkRows) {
		return null;
	}

	const filesByPath = new Map<string, RepoFile>();
	const summaries: Record<string, string> = {};

	for (const row of chunkRows as unknown as FileChunkRow[]) {
		const existing = filesByPath.get(row.file_path);
		const language = row.language ?? "Unknown";

		if (!existing) {
			filesByPath.set(row.file_path, {
				path: row.file_path,
				language,
				content: row.chunk_text,
			});
		} else {
			existing.content = `${existing.content}\n${row.chunk_text}`;
		}

		if (!summaries[row.file_path] && row.summary) {
			summaries[row.file_path] = row.summary;
		}
	}

	const files = Array.from(filesByPath.values());
	const graph = sessionRow.graph && typeof sessionRow.graph === "object" ? sessionRow.graph : emptyGraph();

	return {
		sessionId: sessionRow.id,
		files,
		codebaseText: cacheEntry.codebase_text,
		graph: graph as IngestedRepo["graph"],
		fileSummaries: summaries,
	};
}

export async function ingestRepo(repoUrl: string, userId: string): Promise<IngestedRepo> {
	console.log("[ingestRepo] Step 0/5: Checking Supabase cache...");
	const cachedIngestion = await tryGetCachedIngestion(repoUrl, userId);

	if (cachedIngestion) {
		console.log(`[ingestRepo] Cache hit for session ${cachedIngestion.sessionId}`);
		return cachedIngestion;
	}

	console.log("[ingestRepo] Step 1/5: Fetching repository files...");
	const files = await fetchRepoFiles(repoUrl);

	console.log("[ingestRepo] Step 2/5: Building concatenated codebase context...");
	const codebaseText = buildCodebaseText(files);

	console.log("[ingestRepo] Step 3/5: Building dependency graph...");
	const graph = buildDependencyGraph(files);

	console.log("[ingestRepo] Step 4/5: Summarising files in batches of 5...");
	const fileSummaries: Record<string, string> = {};

	for (let index = 0; index < files.length; index += SUMMARY_BATCH_SIZE) {
		const batch = files.slice(index, index + SUMMARY_BATCH_SIZE);
		const batchNumber = Math.floor(index / SUMMARY_BATCH_SIZE) + 1;
		const totalBatches = Math.ceil(files.length / SUMMARY_BATCH_SIZE) || 1;

		console.log(
			`[ingestRepo] Processing summary batch ${batchNumber}/${totalBatches} (${batch.length} files)...`,
		);

		const summaries = await Promise.all(
			batch.map(async (file) => {
				const summary = await summariseFile(file.path, file.content);
				return { path: file.path, summary };
			}),
		);

		for (const entry of summaries) {
			fileSummaries[entry.path] = entry.summary;
		}
	}

	console.log("[ingestRepo] Step 5/5: Persisting session/chunks/cache in Supabase...");
	const repoName = getRepoName(repoUrl);

	const { data: insertedSession, error: sessionInsertError } = await supabaseAdmin
		.from("sessions")
		.insert({
			user_id: userId,
			repo_url: repoUrl,
			repo_name: repoName,
			file_count: files.length,
			graph,
		})
		.select("id")
		.single();

	if (sessionInsertError && isMissingUserIdColumnError(sessionInsertError.message)) {
		console.warn("[ingestRepo] sessions.user_id missing; inserting session without owner column (compat mode)");

		const fallbackInsert = await supabaseAdmin
			.from("sessions")
			.insert({
				repo_url: repoUrl,
				repo_name: repoName,
				file_count: files.length,
				graph,
			})
			.select("id")
			.single();

		if (fallbackInsert.error || !fallbackInsert.data) {
			throw new Error(fallbackInsert.error?.message || "Failed to create session");
		}

		const sessionId = (fallbackInsert.data as { id: string }).id;
		const chunkRows: ChunkInsertRow[] = [];

		for (const file of files) {
			const summary = fileSummaries[file.path] ?? "";
			const chunks = splitText(file.content);

			for (const chunkText of chunks) {
				chunkRows.push({
					session_id: sessionId,
					file_path: file.path,
					language: file.language,
					chunk_text: chunkText,
					summary: summary,
				});
			}
		}

		for (let index = 0; index < chunkRows.length; index += EMBEDDING_BATCH_SIZE) {
			const batch = chunkRows.slice(index, index + EMBEDDING_BATCH_SIZE);
			const embeddings = await Promise.all(batch.map(async (row) => embedText(row.chunk_text)));

			const payload = batch.map((row, rowIndex) => {
				const embedding = embeddings[rowIndex];

				return {
					...row,
					embedding: embedding.length === 768 ? embedding : null,
				};
			});

			const { error: chunkInsertError } = await supabaseAdmin.from("file_chunks").insert(payload);

			if (chunkInsertError) {
				throw new Error(chunkInsertError.message);
			}
		}

		const { error: cacheInsertError } = await supabaseAdmin.from("codebase_cache").insert({
			session_id: sessionId,
			codebase_text: codebaseText,
		});

		if (cacheInsertError) {
			throw new Error(cacheInsertError.message);
		}

		const { error: sessionUpdateError } = await supabaseAdmin
			.from("sessions")
			.update({ file_count: files.length })
			.eq("id", sessionId);

		if (sessionUpdateError) {
			throw new Error(sessionUpdateError.message);
		}

		console.log("[ingestRepo] Completed ingestion.");

		return {
			sessionId,
			files,
			codebaseText,
			graph,
			fileSummaries,
		};
	}

	if (sessionInsertError || !insertedSession) {
		throw new Error(sessionInsertError?.message || "Failed to create session");
	}

	const sessionId = (insertedSession as { id: string }).id;
	const chunkRows: ChunkInsertRow[] = [];

	for (const file of files) {
		const summary = fileSummaries[file.path] ?? "";
		const chunks = splitText(file.content);

		for (const chunkText of chunks) {
			chunkRows.push({
				session_id: sessionId,
				file_path: file.path,
				language: file.language,
				chunk_text: chunkText,
				summary: summary,
			});
		}
	}

	for (let index = 0; index < chunkRows.length; index += EMBEDDING_BATCH_SIZE) {
		const batch = chunkRows.slice(index, index + EMBEDDING_BATCH_SIZE);
		const embeddings = await Promise.all(batch.map(async (row) => embedText(row.chunk_text)));

		const payload = batch.map((row, rowIndex) => {
			const embedding = embeddings[rowIndex];

			return {
				...row,
				embedding: embedding.length === 768 ? embedding : null,
			};
		});

		const { error: chunkInsertError } = await supabaseAdmin.from("file_chunks").insert(payload);

		if (chunkInsertError) {
			throw new Error(chunkInsertError.message);
		}
	}

	const { error: cacheInsertError } = await supabaseAdmin.from("codebase_cache").insert({
		session_id: sessionId,
		codebase_text: codebaseText,
	});

	if (cacheInsertError) {
		throw new Error(cacheInsertError.message);
	}

	const { error: sessionUpdateError } = await supabaseAdmin
		.from("sessions")
		.update({ file_count: files.length })
		.eq("id", sessionId);

	if (sessionUpdateError) {
		throw new Error(sessionUpdateError.message);
	}

	console.log("[ingestRepo] Completed ingestion.");

	return {
		sessionId,
		files,
		codebaseText,
		graph,
		fileSummaries,
	};
}
