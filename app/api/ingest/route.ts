import { NextResponse } from "next/server";
import { ingestRepo } from "@/lib/repoIngester";
import { logServerError } from "@/lib/apiErrors";
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

type IngestStreamEvent = {
  stage: "starting" | "tree" | "fetching" | "graph" | "processing" | "saving" | "complete" | "error";
  message: string;
  current?: number;
  total?: number;
  sessionId?: string;
  fileCount?: number;
  nodeCount?: number;
};

export async function POST(request: Request) {
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

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: IngestStreamEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const ingestedRepo = await ingestRepo(repoUrl, user.id, (event) => {
          send(event);
        });

        const success: IngestSuccessResponse = {
          success: true,
          sessionId: ingestedRepo.sessionId,
          fileCount: ingestedRepo.files.length,
          nodeCount: ingestedRepo.graph.nodes.length,
        };

        send({
          stage: "complete",
          message: "Ready",
          sessionId: success.sessionId,
          fileCount: success.fileCount,
          nodeCount: success.nodeCount,
        });
      } catch (error: unknown) {
        logServerError("/api/ingest", error);
        const message = error instanceof Error ? error.message : "Failed to ingest repository";
        send({ stage: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
