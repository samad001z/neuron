import { NextResponse } from "next/server";
import { askGemini } from "@/lib/gemini";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type OnboardingRequestBody = {
  sessionId: string;
  persona?: "fullstack" | "backend" | "frontend";
};

type OnboardingSuccessResponse = {
  brief: string;
  persona: "fullstack" | "backend" | "frontend";
};

type OnboardingErrorResponse = {
  error: string;
};

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

export async function POST(request: Request) {
  try {
    const supabase = createRouteSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" } satisfies OnboardingErrorResponse, { status: 401 });
    }

    const body = (await request.json()) as OnboardingRequestBody;
    const sessionId = body?.sessionId;
    const persona = body?.persona ?? "fullstack";

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" } satisfies OnboardingErrorResponse, { status: 400 });
    }

    const sessionLookup = await supabaseAdmin
      .from("sessions")
      .select("id, repo_name, repo_url, graph")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    let sessionRow = sessionLookup.data;

    if (sessionLookup.error && isMissingUserIdColumnError(sessionLookup.error.message)) {
      const fallback = await supabaseAdmin
        .from("sessions")
        .select("id, repo_name, repo_url, graph")
        .eq("id", sessionId)
        .maybeSingle();

      if (fallback.error || !fallback.data) {
        return NextResponse.json({ error: "Session not found" } satisfies OnboardingErrorResponse, { status: 404 });
      }

      sessionRow = fallback.data;
    } else if (sessionLookup.error || !sessionLookup.data) {
      return NextResponse.json({ error: "Session not found" } satisfies OnboardingErrorResponse, { status: 404 });
    }

    if (!sessionRow) {
      return NextResponse.json({ error: "Session not found" } satisfies OnboardingErrorResponse, { status: 404 });
    }

    const { data: cache, error: cacheError } = await supabaseAdmin
      .from("codebase_cache")
      .select("codebase_text")
      .eq("session_id", sessionId)
      .single();

    if (cacheError || !cache) {
      return NextResponse.json(
        { error: "Session cache not found. Please re-ingest the repository." } satisfies OnboardingErrorResponse,
        { status: 404 },
      );
    }

    const { data: chunkRows } = await supabaseAdmin
      .from("file_chunks")
      .select("file_path, summary")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(300);

    const summaryByFile = new Map<string, string>();
    for (const row of chunkRows ?? []) {
      const typed = row as { file_path: string; summary: string | null };
      if (!summaryByFile.has(typed.file_path) && typed.summary) {
        summaryByFile.set(typed.file_path, typed.summary);
      }
    }

    const topFilesContext = Array.from(summaryByFile.entries())
      .slice(0, 40)
      .map(([filePath, summary]) => `${filePath}: ${summary}`)
      .join("\n");

    const indexedFiles = Array.from(summaryByFile.keys()).slice(0, 120).join("\n");

    const graphInfo = (sessionRow.graph as { nodes?: unknown[]; edges?: unknown[] } | null) ?? null;
    const nodeCount = graphInfo?.nodes?.length ?? 0;
    const edgeCount = graphInfo?.edges?.length ?? 0;

    const onboardingPrompt = `Create a practical onboarding brief for a ${persona} engineer joining this codebase.

Repo: ${sessionRow.repo_name ?? sessionRow.repo_url}
Graph stats: ${nodeCount} files, ${edgeCount} dependencies

Use this exact structure:
1) System Overview (5 bullets)
2) Architecture Map (main modules and how they interact)
  3) Start Here (top 10 files with 1-line why; only use indexed files)
4) Critical Runtime Flows (request/data paths)
5) Pitfalls and gotchas (at least 5)
6) First 3 high-impact tasks for a new engineer
7) Glossary (key project terms)
  8) Evidence (8-12 bullet points mapping claim -> [file/path])

Rules:
  - Keep it concise and action-oriented (target <= 650 words).
  - Every non-trivial claim must include at least one [path/to/file] reference.
  - Only cite paths that appear in the indexed file list.
  - If evidence is missing, explicitly say: Not found in indexed files.
  - Do not invent components not present in context.`;

    const retrievalContext = `Indexed files:\n${indexedFiles}\n\nFile summaries:\n${topFilesContext}`;
    const brief = await askGemini(cache.codebase_text, onboardingPrompt, retrievalContext);

    const persistedBrief = `## Onboarding Brief (${persona})\n\n${brief}`;
    await supabaseAdmin.from("messages").insert([{ session_id: sessionId, role: "assistant", content: persistedBrief }]);

    return NextResponse.json({ brief: persistedBrief, persona } satisfies OnboardingSuccessResponse);
  } catch (error: unknown) {
    logServerError("/api/onboarding", error);
    return jsonInternalError("Failed to generate onboarding brief");
  }
}
