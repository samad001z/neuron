import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

export async function GET(
  _request: Request,
  context: { params: { sessionId: string } },
) {
  const supabase = createRouteSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = context.params.sessionId;

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .select("id, repo_url, repo_name, file_count, graph, created_at")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error && isMissingUserIdColumnError(error.message)) {
    const fallback = await supabaseAdmin
      .from("sessions")
      .select("id, repo_url, repo_name, file_count, graph, created_at")
      .eq("id", sessionId)
      .maybeSingle();

    if (fallback.error || !fallback.data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      session: {
        id: fallback.data.id,
        repoUrl: fallback.data.repo_url,
        repoName: fallback.data.repo_name,
        fileCount: fallback.data.file_count,
        graph: fallback.data.graph,
        createdAt: fallback.data.created_at,
      },
    });
  }

  if (error || !data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    session: {
      id: data.id,
      repoUrl: data.repo_url,
      repoName: data.repo_name,
      fileCount: data.file_count,
      graph: data.graph,
      createdAt: data.created_at,
    },
  });
}
