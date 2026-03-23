import { NextResponse } from "next/server";
import { askGeminiRaw } from "@/lib/gemini";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type PrRequestBody = {
  prUrl?: string;
  sessionId?: string;
};

type PrMetadataResponse = {
  title: string;
  author: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  risk: "LOW" | "MEDIUM" | "HIGH";
};

type PrSuccessResponse = {
  analysis: string;
  prMetadata: PrMetadataResponse;
};

type PrErrorResponse = {
  error: string;
};

type GitHubPrResponse = {
  title?: string;
  body?: string | null;
  user?: { login?: string };
  base?: { ref?: string };
  head?: { ref?: string };
  changed_files?: number;
  additions?: number;
  deletions?: number;
  created_at?: string;
};

type GitHubPrFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_HEADERS: HeadersInit = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "Neuron-App",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; pullNumber: string } | null {
  const match = prUrl.match(PR_URL_REGEX);

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
    pullNumber: match[3],
  };
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  return remaining === "0";
}

async function fetchGitHubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: GITHUB_HEADERS,
    cache: "no-store",
  });

  if (!response.ok) {
    const error = new Error(`GitHub API request failed with status ${response.status}`) as Error & {
      status?: number;
      rateLimited?: boolean;
    };

    error.status = response.status;
    error.rateLimited = isRateLimited(response);
    throw error;
  }

  return (await response.json()) as T;
}

function toDiffContext(files: GitHubPrFile[]): string {
  return files
    .map((file) => {
      const patch = file.patch ? file.patch.slice(0, 2000) : "binary file";
      return `FILE: ${file.filename} (${file.status}) +${file.additions} -${file.deletions}\n${patch}`;
    })
    .join("\n\n");
}

function extractRiskLevel(analysis: string): "LOW" | "MEDIUM" | "HIGH" {
  const upper = analysis.toUpperCase();

  if (upper.includes("RISK: HIGH") || upper.includes("HIGH RISK") || upper.includes("RISK**\nHIGH")) {
    return "HIGH";
  }

  if (upper.includes("RISK: MEDIUM") || upper.includes("MEDIUM RISK")) {
    return "MEDIUM";
  }

  return "LOW";
}

export async function POST(request: Request) {
  try {
    const supabase = createRouteSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" } satisfies PrErrorResponse, { status: 401 });
    }

    const body = (await request.json()) as PrRequestBody;
    const prUrl = body?.prUrl?.trim();
    const sessionId = body?.sessionId?.trim();

    if (!prUrl) {
      return NextResponse.json({ error: "Missing prUrl" } satisfies PrErrorResponse, { status: 400 });
    }

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" } satisfies PrErrorResponse, { status: 400 });
    }

    const parsed = parsePrUrl(prUrl);

    if (!parsed) {
      return NextResponse.json({ error: "Invalid GitHub PR URL" } satisfies PrErrorResponse, { status: 400 });
    }

    const { data: sessionRow, error: sessionError } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError && isMissingUserIdColumnError(sessionError.message)) {
      const fallbackSessionLookup = await supabaseAdmin
        .from("sessions")
        .select("id")
        .eq("id", sessionId)
        .maybeSingle();

      if (fallbackSessionLookup.error || !fallbackSessionLookup.data) {
        return NextResponse.json({ error: "Session not found." } satisfies PrErrorResponse, { status: 404 });
      }
    } else if (sessionError || !sessionRow) {
      return NextResponse.json({ error: "Session not found." } satisfies PrErrorResponse, { status: 404 });
    }

    const metadataUrl = `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}`;
    const filesUrl = `${metadataUrl}/files`;

    let prData: GitHubPrResponse;
    let prFiles: GitHubPrFile[];

    try {
      prData = await fetchGitHubJson<GitHubPrResponse>(metadataUrl);
      prFiles = await fetchGitHubJson<GitHubPrFile[]>(filesUrl);
    } catch (error: unknown) {
      const typed = error as Error & { status?: number; rateLimited?: boolean };

      if (typed.rateLimited) {
        return NextResponse.json(
          { error: "GitHub rate limit reached. Add GITHUB_TOKEN to .env" } satisfies PrErrorResponse,
          { status: 429 },
        );
      }

      if (typed.status === 404) {
        return NextResponse.json(
          { error: "PR not found or repository is private" } satisfies PrErrorResponse,
          { status: 404 },
        );
      }

      throw error;
    }

    const limitedFiles = prFiles.slice(0, 50);
    const diffContext = toDiffContext(limitedFiles);

    let codebaseContext = "";
    const { data: cacheData } = await supabaseAdmin
      .from("codebase_cache")
      .select("codebase_text")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (cacheData?.codebase_text) {
      codebaseContext = cacheData.codebase_text;
    }

    const prompt = `You are a senior code reviewer. Analyze this pull request and provide:

PR TITLE: ${prData.title ?? "Untitled"}
PR DESCRIPTION: ${prData.body ?? "No description provided."}
CHANGED FILES: ${prData.changed_files ?? limitedFiles.length} files, +${prData.additions ?? 0} -${prData.deletions ?? 0} lines
BASE BRANCH: ${prData.base?.ref ?? "unknown"}
HEAD BRANCH: ${prData.head?.ref ?? "unknown"}
AUTHOR: ${prData.user?.login ?? "unknown"}
CREATED AT: ${prData.created_at ?? "unknown"}

DIFF:
${diffContext}

${codebaseContext ? `BROADER CODEBASE CONTEXT:\n${codebaseContext.slice(0, 400000)}` : ""}

Provide a structured analysis with these exact sections:

## Summary
2-3 sentences explaining what this PR does in plain English.

## What Changed
List the key changes, grouped by file or feature area.

## Risk Analysis
Rate overall risk: LOW / MEDIUM / HIGH
List specific risks - what could break, edge cases, side effects.

## Security Concerns
Any security issues introduced - XSS, injection, auth bypass, exposed secrets.
If none found, say "No security concerns identified."

## Files to Review Carefully
The 3-5 most important files a reviewer should focus on, with reasons.

## Suggested Review Questions
3-5 questions a reviewer should ask the PR author.`;

    const analysis = await askGeminiRaw(prompt);

    const { error: insertError } = await supabaseAdmin
      .from("messages")
      .insert([{ session_id: sessionId, role: "assistant", content: analysis, file_ref: prUrl }]);

    if (insertError) {
      logServerError("/api/pr insert", insertError);
      return jsonInternalError("Failed to save PR analysis");
    }

    return NextResponse.json({
      analysis,
      prMetadata: {
        title: prData.title ?? "Untitled",
        author: prData.user?.login ?? "unknown",
        changedFiles: prData.changed_files ?? limitedFiles.length,
        additions: prData.additions ?? 0,
        deletions: prData.deletions ?? 0,
        risk: extractRiskLevel(analysis),
      },
    } satisfies PrSuccessResponse);
  } catch (error: unknown) {
    logServerError("/api/pr", error);
    return jsonInternalError();
  }
}
