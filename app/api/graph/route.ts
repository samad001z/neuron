import { NextResponse } from "next/server";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";
import type { DependencyGraph, RepoFile } from "@/types";

type GraphSuccessResponse = {
  graph: DependencyGraph;
  summaries: Record<string, string>;
  repoName: string;
  files: Array<Pick<RepoFile, "path" | "language">>;
};

type GraphErrorResponse = {
  error: string;
};

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

export async function GET(request: Request) {
  const supabase = createRouteSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" } satisfies GraphErrorResponse,
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json(
      { error: "Not found" } satisfies GraphErrorResponse,
      { status: 404 },
    );
  }

  const { data: sessionRow, error: sessionError } = await supabaseAdmin
    .from("sessions")
    .select("id, repo_name, graph")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (sessionError && isMissingUserIdColumnError(sessionError.message)) {
    const fallback = await supabaseAdmin
      .from("sessions")
      .select("id, repo_name, graph")
      .eq("id", sessionId)
      .maybeSingle();

    if (fallback.error || !fallback.data) {
      return NextResponse.json(
        { error: "Not found" } satisfies GraphErrorResponse,
        { status: 404 },
      );
    }

    const { data: chunkRows, error: chunkError } = await supabaseAdmin
      .from("file_chunks")
      .select("file_path, language, summary")
      .eq("session_id", sessionId)
      .order("file_path", { ascending: true });

    if (chunkError) {
      logServerError("/api/graph fallback chunks", chunkError);
      return jsonInternalError();
    }

    const summaryMap: Record<string, string> = {};
    const fileMap = new Map<string, Pick<RepoFile, "path" | "language">>();

    for (const row of chunkRows ?? []) {
      const typedRow = row as { file_path: string; language: string | null; summary: string | null };

      if (!summaryMap[typedRow.file_path] && typedRow.summary) {
        summaryMap[typedRow.file_path] = typedRow.summary;
      }

      if (!fileMap.has(typedRow.file_path)) {
        fileMap.set(typedRow.file_path, {
          path: typedRow.file_path,
          language: typedRow.language ?? "Unknown",
        });
      }
    }

    const fallbackResponse: GraphSuccessResponse = {
      graph: (fallback.data.graph as DependencyGraph) ?? { nodes: [], edges: [] },
      summaries: summaryMap,
      repoName: fallback.data.repo_name ?? "unknown",
      files: Array.from(fileMap.values()),
    };

    return NextResponse.json(fallbackResponse);
  }

  if (sessionError || !sessionRow) {
    return NextResponse.json(
      { error: "Not found" } satisfies GraphErrorResponse,
      { status: 404 },
    );
  }

  const { data: chunkRows, error: chunkError } = await supabaseAdmin
    .from("file_chunks")
    .select("file_path, language, summary")
    .eq("session_id", sessionId)
    .order("file_path", { ascending: true });

  if (chunkError) {
    logServerError("/api/graph chunks", chunkError);
    return jsonInternalError();
  }

  const summaryMap: Record<string, string> = {};
  const fileMap = new Map<string, Pick<RepoFile, "path" | "language">>();

  for (const row of chunkRows ?? []) {
    const typedRow = row as { file_path: string; language: string | null; summary: string | null };

    if (!summaryMap[typedRow.file_path] && typedRow.summary) {
      summaryMap[typedRow.file_path] = typedRow.summary;
    }

    if (!fileMap.has(typedRow.file_path)) {
      fileMap.set(typedRow.file_path, {
        path: typedRow.file_path,
        language: typedRow.language ?? "Unknown",
      });
    }
  }

  const response: GraphSuccessResponse = {
    graph: (sessionRow.graph as DependencyGraph) ?? { nodes: [], edges: [] },
    summaries: summaryMap,
    repoName: sessionRow.repo_name ?? "unknown",
    files: Array.from(fileMap.values()),
  };

  return NextResponse.json(response);
}
