import { NextResponse } from "next/server";
import { askGemini, embedText, getCurrentChatModelName } from "@/lib/gemini";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type AskRequestBody = {
  sessionId: string;
  question: string;
};

type AskSuccessResponse = {
  answer: string;
  model: string;
  sources: string[];
};

type AskErrorResponse = {
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
      return NextResponse.json({ error: "Unauthorized" } satisfies AskErrorResponse, { status: 401 });
    }

    const body = (await request.json()) as AskRequestBody;
    const sessionId = body?.sessionId;
    const question = body?.question;

    if (!sessionId || !question) {
      return NextResponse.json(
        { error: "Missing sessionId or question" } satisfies AskErrorResponse,
        { status: 400 },
      );
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
        return NextResponse.json(
          { error: "Session not found." } satisfies AskErrorResponse,
          { status: 404 },
        );
      }
    } else if (sessionError || !sessionRow) {
      return NextResponse.json(
        { error: "Session not found." } satisfies AskErrorResponse,
        { status: 404 },
      );
    }

    const { data: cache, error: cacheError } = await supabaseAdmin
      .from("codebase_cache")
      .select("codebase_text")
      .eq("session_id", sessionId)
      .single();

    if (cacheError || !cache) {
      return NextResponse.json(
        { error: "Session not found. Please re-ingest the repository." } satisfies AskErrorResponse,
        { status: 404 },
      );
    }

    let retrievalContext = "";
    let sources: string[] = [];

    try {
      const questionEmbedding = await embedText(question);

      const { data: matchedChunks } = await supabaseAdmin.rpc("match_chunks", {
        query_embedding: questionEmbedding,
        match_session_id: sessionId,
        match_count: 8,
      });

      const rows = (matchedChunks ?? []) as Array<{
        file_path: string;
        chunk_text: string;
        summary: string | null;
        similarity: number;
      }>;

      sources = Array.from(new Set(rows.map((row) => row.file_path))).slice(0, 8);
      retrievalContext = rows
        .map((row, index) => {
          const score = Number.isFinite(row.similarity) ? row.similarity.toFixed(3) : "n/a";
          return `[#${index + 1}] file=${row.file_path} similarity=${score}\nsummary=${row.summary ?? ""}\nchunk=${row.chunk_text}`;
        })
        .join("\n\n");
    } catch {
      // Retrieval is best-effort; fall back to full codebase context only.
      sources = [];
      retrievalContext = "";
    }

    const guidedQuestion = `${question}\n\nAlso include a short \"Sources\" section listing the most relevant file paths you used.`;
    const answer = await askGemini(cache.codebase_text, guidedQuestion, retrievalContext);
    const answerWithSources =
      sources.length > 0
        ? `${answer}\n\n### Sources\n${sources.map((path) => `- [${path}]`).join("\n")}`
        : answer;

    const { error: insertError } = await supabaseAdmin
      .from("messages")
      .insert([
        { session_id: sessionId, role: "user", content: question },
        { session_id: sessionId, role: "assistant", content: answerWithSources },
      ]);

    if (insertError) {
      logServerError("/api/ask insert", insertError);
      return jsonInternalError("Failed to save messages");
    }

    const response: AskSuccessResponse = {
      answer: answerWithSources,
      model: getCurrentChatModelName(),
      sources,
    };

    return NextResponse.json(response);
  } catch (error: unknown) {
    logServerError("/api/ask", error);
    return jsonInternalError();
  }
}
