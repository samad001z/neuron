import { NextResponse } from "next/server";
import { ingestRepo } from "@/lib/repoIngester";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type IngestRequestBody = {
  repoUrl: string;
};

type IngestSuccessResponse = {
  success: true;
  sessionId: string;
  fileCount: number;
  nodeCount: number;
};

type IngestErrorResponse = {
  error: string;
};

export async function POST(request: Request) {
  try {
    const supabase = createRouteSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" } satisfies IngestErrorResponse, { status: 401 });
    }

    const body = (await request.json()) as IngestRequestBody;
    const repoUrl = body?.repoUrl;

    if (!repoUrl || typeof repoUrl !== "string") {
      return NextResponse.json({ error: "Missing repoUrl" } satisfies IngestErrorResponse, { status: 400 });
    }

    const ingestedRepo = await ingestRepo(repoUrl, user.id);

    const response: IngestSuccessResponse = {
      success: true,
      sessionId: ingestedRepo.sessionId,
      fileCount: ingestedRepo.files.length,
      nodeCount: ingestedRepo.graph.nodes.length,
    };

    return NextResponse.json(response);
  } catch (error: unknown) {
    logServerError("/api/ingest", error);
    return jsonInternalError("Failed to ingest repository");
  }
}
