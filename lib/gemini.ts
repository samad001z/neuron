import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";

const ASK_SYSTEM_PROMPT =
	"You are an expert software engineer helping a developer understand an unfamiliar codebase. Answer questions accurately with file names and line references where possible.";

const CHAT_MODELS = [
	process.env.GEMINI_MODEL?.trim(),
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
	"gemini-2.5-pro",
	"gemini-2.0-flash",
	"gemini-1.5-flash",
	"gemini-1.5-pro",
	"gemini-pro",
].filter((value): value is string => Boolean(value));

const EMBED_MODELS = [
	"text-embedding-004",
	"embedding-001",
];

let cachedChatModel: GenerativeModel | null = null;
let cachedChatModelName: string | null = null;
let summaryCooldownUntil = 0;

const getApiKey = (): string | undefined => process.env.GEMINI_API_KEY;

function isRateLimitError(message: string): boolean {
	return message.includes("429") || message.toLowerCase().includes("quota exceeded");
}

function extractRetryDelayMs(message: string): number {
	const retryInMatch = message.match(/retry in\s+([\d.]+)s/i);
	if (retryInMatch) {
		return Math.max(1000, Math.ceil(Number(retryInMatch[1]) * 1000));
	}

	const retryDelayMatch = message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
	if (retryDelayMatch) {
		return Math.max(1000, Math.ceil(Number(retryDelayMatch[1]) * 1000));
	}

	return 30_000;
}

function buildFallbackSummary(filePath: string, fileContent: string): string {
	const fileName = filePath.split("/").pop() ?? filePath;
	const lineCount = fileContent ? fileContent.split(/\r?\n/).length : 0;
	return `${fileName} - summary unavailable (rate limit reached, ${lineCount} lines)`;
}

function getClient(): GoogleGenerativeAI | null {
	const apiKey = getApiKey();
	return apiKey ? new GoogleGenerativeAI(apiKey) : null;
}

async function getWorkingChatModel(): Promise<GenerativeModel> {
	const client = getClient();

	if (!client) {
		throw new Error("Gemini API key is missing");
	}

	for (const modelName of CHAT_MODELS) {
		try {
			const model = client.getGenerativeModel({
				model: modelName,
				systemInstruction: ASK_SYSTEM_PROMPT,
			});
			await model.generateContent("hi");
			cachedChatModelName = modelName;
			console.log(`[Gemini] Using model: ${modelName}`);
			return model;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.warn(`[Gemini] Model ${modelName} failed: ${message}`);
		}
	}

	throw new Error("No working Gemini model found. Check your API key.");
}

async function getChatModel(): Promise<GenerativeModel> {
	if (!cachedChatModel) {
		cachedChatModel = await getWorkingChatModel();
	}

	return cachedChatModel;
}

export function getCurrentChatModelName(): string {
	return cachedChatModelName ?? "unresolved";
}

export async function askGemini(
	codebaseText: string,
	question: string,
	retrievedContext?: string,
): Promise<string> {
	const safeChatError = "I could not generate an answer right now. Please try again.";

	try {
		const model = await getChatModel();
		const prompt = `You are an expert software engineer helping a developer understand an unfamiliar codebase. Answer clearly and ground claims in the provided context.

CODEBASE:
${codebaseText.slice(0, 800000)}

RELEVANT_SNIPPETS:
${(retrievedContext ?? "None").slice(0, 120000)}

QUESTION: ${question}

Answer requirements:
- Use concise markdown headings and bullets when useful.
- Prefer facts from RELEVANT_SNIPPETS.
- Reference files inline as [path/to/file.ext].
- If uncertain, explicitly say what is unknown.

Answer:`;
		const result = await model.generateContent(prompt);
		return result.response.text();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown error";

		if (isRateLimitError(message)) {
			const waitMs = extractRetryDelayMs(message);
			console.warn(`[askGemini] rate limited, retrying in ${Math.ceil(waitMs / 1000)}s`);
			await new Promise((resolve) => setTimeout(resolve, waitMs));

			try {
				const retryModel = await getChatModel();
				const retryPrompt = `You are an expert software engineer helping a developer understand an unfamiliar codebase. Answer clearly and ground claims in the provided context.

CODEBASE:
${codebaseText.slice(0, 800000)}

RELEVANT_SNIPPETS:
${(retrievedContext ?? "None").slice(0, 120000)}

QUESTION: ${question}

Answer requirements:
- Use concise markdown headings and bullets when useful.
- Prefer facts from RELEVANT_SNIPPETS.
- Reference files inline as [path/to/file.ext].
- If uncertain, explicitly say what is unknown.

Answer:`;
				const retryResult = await retryModel.generateContent(retryPrompt);
				return retryResult.response.text();
			} catch (retryError: unknown) {
				const retryMessage = retryError instanceof Error ? retryError.message : "Unknown error";
				console.error("[askGemini] retry failed:", retryMessage);
				return safeChatError;
			}
		}

		cachedChatModel = null;
		cachedChatModelName = null;
		console.error("[askGemini] error:", message);
		return safeChatError;
	}
}

export async function askGeminiRaw(prompt: string): Promise<string> {
	const safeChatError = "I could not generate an answer right now. Please try again.";

	try {
		const model = await getChatModel();
		const result = await model.generateContent(prompt);
		return result.response.text();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown error";

		if (isRateLimitError(message)) {
			const waitMs = extractRetryDelayMs(message);
			console.warn(`[askGeminiRaw] rate limited, retrying in ${Math.ceil(waitMs / 1000)}s`);
			await new Promise((resolve) => setTimeout(resolve, waitMs));

			try {
				const retryModel = await getChatModel();
				const retryResult = await retryModel.generateContent(prompt);
				return retryResult.response.text();
			} catch (retryError: unknown) {
				const retryMessage = retryError instanceof Error ? retryError.message : "Unknown error";
				console.error("[askGeminiRaw] retry failed:", retryMessage);
				return safeChatError;
			}
		}

		cachedChatModel = null;
		cachedChatModelName = null;
		console.error("[askGeminiRaw] error:", message);
		return safeChatError;
	}
}

export async function summariseFile(
	filePath: string,
	fileContent: string,
): Promise<string> {
	if (Date.now() < summaryCooldownUntil) {
		return buildFallbackSummary(filePath, fileContent);
	}

	try {
		const model = await getChatModel();
		const result = await model.generateContent(
			`Summarise what this file does in 2 sentences max. Be specific.\nFile: ${filePath}\n\n${fileContent.slice(0, 8000)}`,
		);
		return result.response.text();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown error";

		if (isRateLimitError(message)) {
			const waitMs = extractRetryDelayMs(message);
			summaryCooldownUntil = Date.now() + waitMs;
		}

		console.warn(`[summariseFile] ${filePath} failed:`, message);
		return buildFallbackSummary(filePath, fileContent);
	}
}

export async function embedText(text: string): Promise<number[]> {
	const client = getClient();

	if (!client) {
		console.error("[embedText] Gemini API key is missing, returning zero vector");
		return new Array(768).fill(0);
	}

	for (const modelName of EMBED_MODELS) {
		try {
			const model = client.getGenerativeModel({ model: modelName });
			const result = await model.embedContent(text);
			return result.embedding.values;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.warn(`[embedText] Model ${modelName} failed:`, message);
		}
	}

	console.error("[embedText] All embed models failed, returning zero vector");
	return new Array(768).fill(0);
}
