import { NextResponse } from "next/server";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type SessionListItem = {
  id: string;
  repoUrl: string;
  repoName: string;
  fileCount: number;
  messageCount: number;
  createdAt: string;
};

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

export async function GET() {
  const supabase = createRouteSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("sessions")
    .select("id, repo_url, repo_name, file_count, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error && isMissingUserIdColumnError(error.message)) {
    const fallback = await supabaseAdmin
      .from("sessions")
      .select("id, repo_url, repo_name, file_count, created_at")
      .order("created_at", { ascending: false });

    if (fallback.error) {
      logServerError("/api/sessions fallback", fallback.error);
      return jsonInternalError();
    }

    const sessionIds = (fallback.data ?? []).map((row) => row.id);
    const messageCountBySession = new Map<string, number>();

    if (sessionIds.length > 0) {
      const { data: messageRows } = await supabaseAdmin
        .from("messages")
        .select("session_id")
        .in("session_id", sessionIds);

      for (const row of messageRows ?? []) {
        const count = messageCountBySession.get(row.session_id) ?? 0;
        messageCountBySession.set(row.session_id, count + 1);
      }
    }

    const sessions: SessionListItem[] = (fallback.data ?? []).map((row) => ({
      id: row.id,
      repoUrl: row.repo_url,
      repoName: row.repo_name ?? "unknown",
      fileCount: row.file_count ?? 0,
      messageCount: messageCountBySession.get(row.id) ?? 0,
      createdAt: row.created_at,
    }));

    return NextResponse.json({ sessions });
  }

  if (error) {
    logServerError("/api/sessions", error);
    return jsonInternalError();
  }

  const sessionIds = (data ?? []).map((row) => row.id);
  const messageCountBySession = new Map<string, number>();

  if (sessionIds.length > 0) {
    const { data: messageRows } = await supabaseAdmin
      .from("messages")
      .select("session_id")
      .in("session_id", sessionIds);

    for (const row of messageRows ?? []) {
      const count = messageCountBySession.get(row.session_id) ?? 0;
      messageCountBySession.set(row.session_id, count + 1);
    }
  }

  const sessions: SessionListItem[] = (data ?? []).map((row) => ({
    id: row.id,
    repoUrl: row.repo_url,
    repoName: row.repo_name ?? "unknown",
    fileCount: row.file_count ?? 0,
    messageCount: messageCountBySession.get(row.id) ?? 0,
    createdAt: row.created_at,
  }));

  return NextResponse.json({ sessions });
}
