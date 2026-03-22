export type RepoFile = {
	path: string;
	content: string;
	language: string;
};

export type DependencyNode = {
	id: string;
	label: string;
	language: string;
};

export type DependencyEdge = {
	source: string;
	target: string;
};

export type DependencyGraph = {
	nodes: DependencyNode[];
	edges: DependencyEdge[];
};

export type IngestedRepo = {
	sessionId: string;
	files: RepoFile[];
	codebaseText: string;
	graph: DependencyGraph;
	fileSummaries: Record<string, string>;
};

export interface User {
	id: string;
	email: string;
	fullName: string | null;
	avatarUrl: string | null;
}

export interface ChatSession {
	id: string;
	userId: string;
	repoUrl: string;
	repoName: string;
	fileCount: number;
	graph: DependencyGraph;
	messageCount: number;
	createdAt: Date;
}

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | string;

export interface GroupedSessions {
	label: DateGroup;
	sessions: ChatSession[];
}

export interface Session {
	id: string;
	repoUrl: string;
	repoName: string;
	fileCount: number;
	graph: DependencyGraph;
	createdAt: Date;
}

export interface Message {
	id: string;
	sessionId: string;
	role: "user" | "assistant";
	text: string;
	fileRef: string | null;
	createdAt: Date;
	isStreaming?: boolean;
}

export interface FileChunk {
	id: string;
	sessionId: string;
	filePath: string;
	language: string;
	chunkText: string;
	summary: string;
	similarity?: number;
}
