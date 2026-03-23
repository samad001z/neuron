import { NextResponse } from "next/server";
import { askGeminiRaw } from "@/lib/gemini";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type WikiRequestBody = {
  sessionId?: string;
};

type WikiSuccessResponse = {
  wiki: string;
  wordCount: number;
  sectionCount: number;
};

type WikiErrorResponse = {
  error: string;
};

type SessionRow = {
  id: string;
  repo_name: string | null;
  file_count: number | null;
};

type CacheRow = {
  codebase_text: string;
};

type ChunkRow = {
  file_path: string;
  summary: string | null;
};

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

function toFileSummariesContext(rows: ChunkRow[]): string {
  const summaryByFile = new Map<string, string>();

  for (const row of rows) {
    if (!row.summary) {
      continue;
    }

    if (!summaryByFile.has(row.file_path)) {
      summaryByFile.set(row.file_path, row.summary);
    }
  }

  return Array.from(summaryByFile.entries())
    .map(([filePath, summary]) => `- ${filePath}: ${summary}`)
    .join("\n");
}

export async function POST(request: Request) {
  try {
    const supabase = createRouteSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" } satisfies WikiErrorResponse, { status: 401 });
    }

    const body = (await request.json()) as WikiRequestBody;
    const sessionId = body?.sessionId?.trim();

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" } satisfies WikiErrorResponse, { status: 400 });
    }

    let sessionData: SessionRow | null = null;

    const { data: sessionRow, error: sessionError } = await supabaseAdmin
      .from("sessions")
      .select("id, repo_name, file_count")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError && isMissingUserIdColumnError(sessionError.message)) {
      const fallback = await supabaseAdmin
        .from("sessions")
        .select("id, repo_name, file_count")
        .eq("id", sessionId)
        .maybeSingle();

      if (fallback.error || !fallback.data) {
        return NextResponse.json({ error: "Session not found." } satisfies WikiErrorResponse, { status: 404 });
      }

      sessionData = fallback.data as SessionRow;
    } else if (sessionError || !sessionRow) {
      return NextResponse.json({ error: "Session not found." } satisfies WikiErrorResponse, { status: 404 });
    } else {
      sessionData = sessionRow as SessionRow;
    }

    const { data: cacheRow, error: cacheError } = await supabaseAdmin
      .from("codebase_cache")
      .select("codebase_text")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (cacheError || !cacheRow) {
      return NextResponse.json(
        { error: "Session not found. Please re-ingest the repository." } satisfies WikiErrorResponse,
        { status: 404 },
      );
    }

    const typedCache = cacheRow as CacheRow;

    const { data: chunkRows } = await supabaseAdmin
      .from("file_chunks")
      .select("file_path, summary")
      .eq("session_id", sessionId)
      .order("file_path", { ascending: true });

    const fileSummaryContext = toFileSummariesContext((chunkRows ?? []) as ChunkRow[]);
    const repoName = sessionData?.repo_name ?? "unknown-repo";
    const fileCount = sessionData?.file_count ?? 0;

    const prompt = `You are a senior technical writer. Generate a complete documentation wiki
for this codebase. Make it clear enough for a developer joining the team today.

REPO: ${repoName}
FILES: ${fileCount}

CODEBASE:
${typedCache.codebase_text.slice(0, 800000)}

FILE SUMMARIES:
${fileSummaryContext || "No file summaries available."}

Generate a complete wiki with these exact sections:

# ${repoName} - Documentation

## Overview
What this project does, who it's for, what problem it solves. 3-5 sentences.

## Architecture
How the codebase is structured. Explain the main directories and how they relate.
Include a text-based architecture diagram using ASCII.

## Getting Started
How to install, configure, and run this project locally.
Include actual commands from the codebase (check package.json, Makefile, README).

## Core Concepts
The 3-5 most important concepts a developer needs to understand.
Each concept gets a heading, explanation, and code example.

## File Reference
For every file in the main source directory, provide:
### filename.ext
**Purpose:** one sentence
**Exports:** key exports/functions/classes
**Used by:** which other files import this

## API Reference
If this is a library or has an API, document every public method/endpoint.

## Data Flow
How data moves through the system. Use a text diagram if helpful.

## Common Patterns
Patterns used consistently throughout the codebase.

## Contributing
How to add a new feature, following the existing patterns.

Make everything specific to THIS codebase - no generic placeholders.`;

    const wiki = await askGeminiRaw(prompt);
    const wordCount = wiki.split(/\s+/).filter(Boolean).length;
    const sectionCount = (wiki.match(/^#{1,3} /gm) || []).length;

    return NextResponse.json({
      wiki,
      wordCount,
      sectionCount,
    } satisfies WikiSuccessResponse);
  } catch (error: unknown) {
    logServerError("/api/wiki", error);
    return jsonInternalError();
  }
}
