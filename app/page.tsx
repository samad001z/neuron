"use client";

import { type ComponentPropsWithoutRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/lib/supabase";
import type { Message as AppMessage } from "@/types";

type FileItem = { path: string; language: string };
type GraphNode = { id: string; label: string; language: string };
type GraphEdge = { source: string; target: string };
type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] };

type IngestResponse = {
  success?: boolean;
  sessionId?: string;
  fileCount?: number;
  nodeCount?: number;
  error?: string;
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

type GraphResponse = {
  graph?: GraphData;
  summaries?: Record<string, string>;
  repoName?: string;
  files?: FileItem[];
  error?: string;
};

type AskResponse = {
  answer?: string;
  model?: string;
  sources?: string[];
  error?: string;
};

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
};

type SessionRestoreResponse = {
  session?: {
    id: string;
    repoUrl: string;
    repoName: string;
    fileCount: number;
    graph: GraphData;
    createdAt: string;
  };
  error?: string;
};

type HistorySession = {
  id: string;
  repoUrl: string;
  repoName: string;
  fileCount: number;
  messageCount: number;
  createdAt: string;
};

type SessionListResponse = {
  sessions?: HistorySession[];
  error?: string;
};

const suggestions = [
  "Explain the architecture",
  "Find potential bugs",
  "How does auth work?",
  "What does index.ts export?",
];

function getRepoName(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  return parts[parts.length - 1] || "-";
}

function getLangColor(language: string): string {
  const key = language.toLowerCase();

  if (key.includes("typescript")) return "#3b82f6";
  if (key.includes("javascript")) return "#eab308";
  if (key.includes("python")) return "#22c55e";
  if (key.includes("json") || key.includes("config") || key.includes("yaml") || key.includes("toml")) {
    return "#6b7280";
  }
  if (key.includes("css") || key.includes("scss") || key.includes("sass")) return "#a855f7";

  return "#71717a";
}

function parseSessionIdFromPathname(pathname: string): string | null {
  const marker = "/session/";
  const index = pathname.indexOf(marker);

  if (index === -1) {
    return null;
  }

  const extracted = pathname.slice(index + marker.length).split("/")[0];
  return extracted || null;
}

function formatTimeAgo(timeValue: Date | string | null, nowMs: number): string {
  if (!timeValue) {
    return "-";
  }

  const date = typeof timeValue === "string" ? new Date(timeValue) : timeValue;
  const diffMs = Math.max(0, nowMs - date.getTime());

  if (diffMs < 60_000) {
    return "just now";
  }

  if (diffMs < 3_600_000) {
    const mins = Math.floor(diffMs / 60_000);
    return `${mins} min ago`;
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function buildFollowUps(): string[] {
  return suggestions;
}

function getHistoryBucket(dateLike: Date | string): string {
  const date = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - target.getTime()) / 86_400_000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "Previous 7 days";
  if (diffDays < 30) return "Previous 30 days";

  return target.toLocaleDateString([], { month: "long" });
}

export default function NeuronPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState<boolean>(true);
  const [isSessionSwitching, setIsSessionSwitching] = useState<boolean>(false);
  const [currentUserEmail, setCurrentUserEmail] = useState<string>("");
  const [currentUserName, setCurrentUserName] = useState<string>("");
  const [currentUserAvatar, setCurrentUserAvatar] = useState<string>("");
  const [chatSessions, setChatSessions] = useState<HistorySession[]>([]);
  const [isIngesting, setIsIngesting] = useState<boolean>(false);
  const [isIngested, setIsIngested] = useState<boolean>(false);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [, setSummaries] = useState<Record<string, string>>({});
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "graph">("chat");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [, setPanelOpen] = useState<boolean>(false);
  const [chatInput, setChatInput] = useState<string>("");
  const [, setStatusText] = useState<string>("idle");
  const [isComposerFocused, setIsComposerFocused] = useState<boolean>(false);
  const [, setAnalysisText] = useState<string>("");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestProgress, setIngestProgress] = useState<{
    stage: string;
    message: string;
    current?: number;
    total?: number;
  }>({ stage: "idle", message: "" });
  const [indexedAt, setIndexedAt] = useState<Date | null>(null);
  const [repoNameMeta, setRepoNameMeta] = useState<string>("");
  const [, setProgress] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [, setCurrentModel] = useState<string>("resolving");
  const [fileFilter, setFileFilter] = useState<string>("");

  const messageContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const progressRef = useRef<NodeJS.Timeout | null>(null);
  const messageCacheRef = useRef<Record<string, AppMessage[]>>({});
  const pendingAssistantIdRef = useRef<string | null>(null);

  const groupedHistory = useMemo(() => {
    const groups = new Map<string, HistorySession[]>();

    for (const item of chatSessions) {
      const key = getHistoryBucket(item.createdAt);
      const current = groups.get(key) ?? [];
      current.push(item);
      groups.set(key, current);
    }

    return Array.from(groups.entries()).map(([label, sessions]) => ({ label, sessions }));
  }, [chatSessions]);

  const lastAssistantIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") {
        return index;
      }
    }

    return -1;
  }, [messages]);

  const filteredFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();

    if (!query) {
      return files;
    }

    return files.filter((item) => item.path.toLowerCase().includes(query));
  }, [fileFilter, files]);

  useEffect(() => {
    if (messageContainerRef.current) {
      messageContainerRef.current.scrollTop = messageContainerRef.current.scrollHeight;
    }
  }, [messages, isChatLoading]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    messageCacheRef.current[sessionId] = messages;
  }, [messages, sessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(
    () => () => {
      if (progressRef.current) {
        clearInterval(progressRef.current);
        progressRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        urlInputRef.current?.focus();
      }

      if (event.key === "Escape") {
        urlInputRef.current?.blur();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const appendRealtimeMessage = useCallback((incoming: AppMessage) => {
    setMessages((prev) => {
      if (prev.some((item) => item.id === incoming.id)) {
        return prev;
      }

      return [...prev, incoming];
    });
  }, []);

  const loadSessionHistory = useCallback(async (): Promise<void> => {
    setIsHistoryLoading(true);

    try {
      const response = await fetch("/api/sessions");
      const payload = (await response.json()) as SessionListResponse;

      if (!response.ok || !payload.sessions) {
        return;
      }

      setChatSessions(payload.sessions);
    } finally {
      setIsHistoryLoading(false);
    }
  }, []);

  const loadGraphState = useCallback(async (id: string): Promise<void> => {
    const graphResponse = await fetch(`/api/graph?sessionId=${encodeURIComponent(id)}`);
    const graphPayload = (await graphResponse.json()) as GraphResponse;

    if (!graphResponse.ok || !graphPayload.graph || !graphPayload.summaries) {
      throw new Error(graphPayload.error || "Failed to load graph");
    }

    setGraph(graphPayload.graph);
    setSummaries(graphPayload.summaries);
    setRepoNameMeta(graphPayload.repoName ?? "");
    setFiles(
      graphPayload.files ?? graphPayload.graph.nodes.map((node) => ({ path: node.id, language: node.language })),
    );
  }, []);

  const loadInitialMessages = useCallback(async (id: string): Promise<void> => {
    if (!supabase) {
      return;
    }

    const { data, error } = await supabase
      .from("messages")
      .select("id, session_id, role, content, file_ref, created_at")
      .eq("session_id", id)
      .order("created_at", { ascending: true });

    if (error || !data) {
      return;
    }

    const mapped = data.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as "user" | "assistant",
      text: row.content,
      fileRef: row.file_ref,
      createdAt: new Date(row.created_at),
    }));

    setMessages((prev) => {
      if (mapped.length > 0) {
        return mapped;
      }

      const cached = messageCacheRef.current[id];
      return cached && cached.length > 0 ? cached : prev;
    });
  }, []);

  useEffect(() => {
    if (activeTab !== "chat" || !sessionId || messages.length > 0) {
      return;
    }

    const cached = messageCacheRef.current[sessionId];
    if (cached && cached.length > 0) {
      setMessages(cached);
      return;
    }

    void loadInitialMessages(sessionId);
  }, [activeTab, loadInitialMessages, messages.length, sessionId]);

  const restoreSessionById = useCallback(
    async (id: string): Promise<void> => {
      const response = await fetch(`/api/session/${encodeURIComponent(id)}`);
      const payload = (await response.json()) as SessionRestoreResponse;

      if (!response.ok || !payload.session) {
        return;
      }

      setSessionId(payload.session.id);
      setRepoUrl(payload.session.repoUrl);
      setGraph(payload.session.graph);
      setRepoNameMeta(payload.session.repoName);
      setIsIngested(true);
      setIndexedAt(new Date(payload.session.createdAt));
      setStatusText("ready");
      setIngestError(null);

      await loadGraphState(payload.session.id);
      await loadInitialMessages(payload.session.id);
    },
    [loadGraphState, loadInitialMessages],
  );

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      setIsHistoryLoading(false);
      return;
    }

    const client = supabase;

    const next = `${window.location.pathname}${window.location.search}`;

    void client.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        router.replace(`/auth?next=${encodeURIComponent(next)}`);
        return;
      }

      setCurrentUserEmail(data.user.email ?? "");
      setCurrentUserName((data.user.user_metadata?.full_name as string | undefined) ?? "");
      setCurrentUserAvatar((data.user.user_metadata?.avatar_url as string | undefined) ?? "");

      const { data: profile } = await client
        .from("profiles")
        .select("full_name, avatar_url")
        .eq("id", data.user.id)
        .maybeSingle();

      if (profile?.full_name) {
        setCurrentUserName(profile.full_name);
      }

      if (profile?.avatar_url) {
        setCurrentUserAvatar(profile.avatar_url);
      }

      setAuthReady(true);
      await loadSessionHistory();
    });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        router.replace(`/auth?next=${encodeURIComponent(next)}`);
        return;
      }

      setCurrentUserEmail(session.user.email ?? "");
      setCurrentUserName((session.user.user_metadata?.full_name as string | undefined) ?? "");
      setCurrentUserAvatar((session.user.user_metadata?.avatar_url as string | undefined) ?? "");
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [loadSessionHistory, router]);

  useEffect(() => {
    if (!authReady) {
      return;
    }

    const pathSessionId = parseSessionIdFromPathname(window.location.pathname);

    if (!pathSessionId) {
      return;
    }

    void restoreSessionById(pathSessionId);
  }, [authReady, restoreSessionById]);

  useEffect(() => {
    if (!sessionId || !supabase) {
      return;
    }

    const client = supabase;

    const channel = client
      .channel(`messages:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            session_id: string;
            role: "user" | "assistant";
            content: string;
            file_ref: string | null;
            created_at: string;
          };

          appendRealtimeMessage({
            id: row.id,
            sessionId: row.session_id,
            role: row.role,
            text: row.content,
            fileRef: row.file_ref,
            createdAt: new Date(row.created_at),
          });
        },
      )
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [appendRealtimeMessage, sessionId]);

  const sendMessage = useCallback(
    async (question: string): Promise<void> => {
      const trimmed = question.trim();

      if (!trimmed || isChatLoading || !isIngested || !sessionId) {
        return;
      }

      const optimisticUserId = `local-user-${Date.now()}`;
      const optimisticAssistantId = `local-thinking-${Date.now()}`;

      setMessages((prev) => [
        ...prev,
        {
          id: optimisticUserId,
          sessionId,
          role: "user",
          text: trimmed,
          fileRef: null,
          createdAt: new Date(),
        },
        {
          id: optimisticAssistantId,
          sessionId,
          role: "assistant",
          text: "Thinking...",
          fileRef: null,
          createdAt: new Date(),
        },
      ]);

      pendingAssistantIdRef.current = optimisticAssistantId;
      setIsChatLoading(true);
      setChatInput("");

      try {
        const askResponse = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, question: trimmed }),
        });

        const payload = (await askResponse.json()) as AskResponse;

        if (payload.model) {
          setCurrentModel(payload.model);
        }

        if (!askResponse.ok) {
          setMessages((prev) => {
            const withoutThinking = prev.filter((item) => item.id !== optimisticAssistantId);

            return [
              ...withoutThinking,
              {
                id: `${Date.now()}-local-error`,
                sessionId,
                role: "assistant",
                text: `Error: ${payload.error || "Request failed"}`,
                fileRef: null,
                createdAt: new Date(),
              },
            ];
          });
        }
      } catch {
        setMessages((prev) => {
          const withoutThinking = prev.filter((item) => item.id !== optimisticAssistantId);

          return [
            ...withoutThinking,
            {
              id: `${Date.now()}-fetch-error`,
              sessionId,
              role: "assistant",
              text: "Error: Failed to fetch answer. Please try again.",
              fileRef: null,
              createdAt: new Date(),
            },
          ];
        });
      } finally {
        setMessages((prev) => prev.filter((item) => item.id !== optimisticAssistantId));
        pendingAssistantIdRef.current = null;
        setIsChatLoading(false);
        await loadInitialMessages(sessionId);
      }
    },
    [isChatLoading, isIngested, loadInitialMessages, sessionId],
  );

  const handleIngest = async (): Promise<void> => {
    const trimmedUrl = repoUrl.trim();

    if (!trimmedUrl || isIngesting) {
      return;
    }

    setIsIngesting(true);
    setIsIngested(false);
    setSessionId(null);
    setMessages([]);
    setGraph(null);
    setFiles([]);
    setSummaries({});
    setSelectedFile(null);
    setIngestError(null);
    setPanelOpen(false);
    setStatusText("analyzing");
    setAnalysisText("Connecting...");
    setIngestProgress({ stage: "starting", message: "Connecting...", current: 0, total: 0 });
    setProgress(0);

    if (progressRef.current) {
      clearInterval(progressRef.current);
      progressRef.current = null;
    }

    setProgress(2);

    try {
      const ingestResponse = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: trimmedUrl }),
      });

      if (!ingestResponse.ok) {
        const fallbackPayload = (await ingestResponse.json()) as IngestResponse;
        throw new Error(fallbackPayload.error || "Failed to ingest repository");
      }

      if (!ingestResponse.body) {
        throw new Error("No stream returned from ingest endpoint");
      }

      const reader = ingestResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines.filter((item) => item.startsWith("data: "))) {
          const data = JSON.parse(line.slice(6)) as IngestStreamEvent;
          setIngestProgress(data);

          const current = data.current ?? 0;
          const total = data.total ?? 0;
          setAnalysisText(total > 0 ? `${data.message} ${current}/${total}` : data.message);

          if (data.stage === "tree") {
            setProgress((value) => Math.max(value, 10));
          }

          if (data.stage === "fetching" && total > 0) {
            const ratio = Math.max(0, Math.min(1, current / total));
            setProgress(Math.round(15 + ratio * 70));
          }

          if (data.stage === "graph") {
            setProgress((value) => Math.max(value, 88));
          }

          if (data.stage === "processing") {
            setProgress((value) => Math.max(value, 90));
          }

          if (data.stage === "saving") {
            setProgress((value) => Math.max(value, 95));
          }

          if (data.stage === "complete") {
            if (!data.sessionId) {
              throw new Error("Ingestion completed without a session id");
            }

            setSessionId(data.sessionId);
            setRepoNameMeta(getRepoName(trimmedUrl));
            window.history.pushState({}, "", `/session/${data.sessionId}`);

            const graphRes = await fetch(`/api/graph?sessionId=${encodeURIComponent(data.sessionId)}`);
            const graphPayload = (await graphRes.json()) as GraphResponse;

            if (!graphRes.ok || !graphPayload.graph || !graphPayload.summaries) {
              throw new Error(graphPayload.error || "Failed to load graph");
            }

            setGraph(graphPayload.graph);
            setSummaries(graphPayload.summaries);
            setRepoNameMeta(graphPayload.repoName ?? getRepoName(trimmedUrl));
            setFiles(
              graphPayload.files ?? graphPayload.graph.nodes.map((node) => ({ path: node.id, language: node.language })),
            );

            await loadInitialMessages(data.sessionId);
            await loadSessionHistory();

            setIndexedAt(new Date());
            setIsIngested(true);
            setStatusText("ready");
            setProgress(100);
            setIsIngesting(false);
            return;
          }

          if (data.stage === "error") {
            setIngestError(data.message);
            setStatusText("error");
            setIsIngesting(false);
            return;
          }
        }
      }

      throw new Error("Ingestion stream ended unexpectedly");
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : "Ingestion failed";
      setIngestError(text);
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-err`,
          sessionId: sessionId ?? "",
          role: "assistant",
          text: `Error: ${text}`,
          fileRef: null,
          createdAt: new Date(),
        },
      ]);
      setStatusText("error");
    } finally {
      if (progressRef.current) {
        clearInterval(progressRef.current);
        progressRef.current = null;
      }

      setProgress(100);
      window.setTimeout(() => setProgress(0), 600);

      setIsIngesting(false);
      setAnalysisText("");
      setIngestProgress({ stage: "idle", message: "" });
    }
  };

  const explainFile = useCallback(async (filePath: string): Promise<void> => {
    setSelectedFile(filePath);
    setPanelOpen(true);
    setActiveTab("chat");
    await sendMessage(
      `Explain file \`${filePath}\` - purpose, key exports, and how it connects to the rest of the codebase`,
    );
  }, [sendMessage]);

  const startNewChat = (): void => {
    setSessionId(null);
    setIsIngested(false);
    setRepoUrl("");
    setMessages([]);
    setGraph(null);
    setFiles([]);
    setSummaries({});
    setSelectedFile(null);
    setPanelOpen(false);
    setIndexedAt(null);
    setStatusText("idle");
    setIngestError(null);
    window.history.pushState({}, "", "/");
  };

  const openHistorySession = (id: string): void => {
    if (sessionId === id) {
      return;
    }

    setIsSessionSwitching(true);
    window.history.pushState({}, "", `/session/${id}`);

    void (async () => {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 150);
      });
      await restoreSessionById(id);
      setIsSessionSwitching(false);
    })();
  };

  const deleteHistorySession = async (id: string): Promise<void> => {
    if (!supabase) {
      return;
    }

    const confirmed = window.confirm("Delete this chat session?");

    if (!confirmed) {
      return;
    }

    const { error } = await supabase.from("sessions").delete().eq("id", id);

    if (error) {
      return;
    }

    if (sessionId === id) {
      startNewChat();
    }

    await loadSessionHistory();
  };

  const signOut = async (): Promise<void> => {
    if (!supabase) {
      router.replace("/auth");
      return;
    }

    await supabase.auth.signOut();
    router.replace("/auth");
  };

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = "0px";
    const next = Math.min(textareaRef.current.scrollHeight, 160);
    textareaRef.current.style.height = `${next}px`;
  }, [chatInput]);

  useEffect(() => {
    if (!graphRef.current || activeTab !== "graph") {
      return;
    }

    const root = graphRef.current;
    root.innerHTML = "";

    if (!graph || graph.nodes.length === 0) {
      return;
    }

    let mounted = true;
    let simulationRef: { stop: () => void } | null = null;

    void (async () => {
      const d3 = await import("d3");

      if (!mounted || !graphRef.current) {
        return;
      }

      const width = graphRef.current.clientWidth;
      const height = graphRef.current.clientHeight;

      type SimNode = GraphNode & d3.SimulationNodeDatum;
      type SimEdge = d3.SimulationLinkDatum<SimNode> & {
        source: string | SimNode;
        target: string | SimNode;
      };

      const nodes: SimNode[] = graph.nodes.map((node) => ({ ...node }));
      const links: SimEdge[] = graph.edges.map((edge) => ({ ...edge }));

      const getDisplayLabel = (nodeId: string): string => {
        const parts = nodeId.split("/");
        return parts.length > 1 ? parts.slice(-2).join("/") : parts[0] || nodeId;
      };

      const degree = new Map<string, number>();
      for (const node of nodes) {
        degree.set(node.id, 0);
      }

      for (const edge of links) {
        const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
        const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
        degree.set(sourceId, (degree.get(sourceId) ?? 0) + 1);
        degree.set(targetId, (degree.get(targetId) ?? 0) + 1);
      }

      let maxDegreeNodeId = "";
      let maxDegree = -1;
      degree.forEach((value, key) => {
        if (value > maxDegree) {
          maxDegree = value;
          maxDegreeNodeId = key;
        }
      });

      const getNodeRadius = (nodeId: string): number => {
        const nodeDegree = degree.get(nodeId) ?? 0;

        if (nodeId === maxDegreeNodeId) return 16;
        if (nodeDegree > 10) return 14;
        if (nodeDegree > 5) return 10;
        return 6;
      };

      const svg = d3
        .select(graphRef.current)
        .append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

      const graphGroup = svg.append("g");

      const link = graphGroup
        .append("g")
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 1);

      const labels = graphGroup
        .append("g")
        .selectAll("text")
        .data(nodes)
        .join("text")
        .text((d) => getDisplayLabel(d.id))
        .attr("font-size", (d) => ((degree.get(d.id) ?? 0) > 4 || d.id === maxDegreeNodeId ? 10 : 9))
        .attr("fill", (d) => {
          if (d.id === maxDegreeNodeId) return "#c4b5fd";
          return (degree.get(d.id) ?? 0) > 4 ? "#d4d4d8" : "#71717a";
        })
        .style("text-shadow", "0 1px 3px rgba(0,0,0,0.8)")
        .style("display", (d) => ((degree.get(d.id) ?? 0) > 4 || d.id === maxDegreeNodeId ? "block" : "none"));

      const node = graphGroup
        .append("g")
        .selectAll<SVGCircleElement, SimNode>("circle")
        .data(nodes)
        .join("circle")
        .attr("r", (d) => getNodeRadius(d.id))
        .attr("fill", "transparent")
        .attr("stroke", (d) => (d.id === maxDegreeNodeId ? "#a78bfa" : getLangColor(d.language)))
        .attr("stroke-width", (d) => (d.id === maxDegreeNodeId ? 2 : 1))
        .style("cursor", "pointer")
        .on("mouseenter", (event, d) => {
          d3.select<SVGCircleElement, SimNode>(event.currentTarget).attr("stroke-width", 2);
          if ((degree.get(d.id) ?? 0) <= 4 && d.id !== maxDegreeNodeId) {
            labels.filter((x) => x.id === d.id).style("display", "block");
          }
        })
        .on("mouseleave", (event, d) => {
          d3.select<SVGCircleElement, SimNode>(event.currentTarget).attr(
            "stroke-width",
            d.id === maxDegreeNodeId ? 2 : 1,
          );
          if ((degree.get(d.id) ?? 0) <= 4 && d.id !== maxDegreeNodeId) {
            labels.filter((x) => x.id === d.id).style("display", "none");
          }
        })
        .on("click", (_, d) => {
          setActiveTab("chat");
          void explainFile(d.id);
        });

      const simulation = d3
        .forceSimulation(nodes)
        .force("link", d3.forceLink(links).id((d: d3.SimulationNodeDatum) => (d as SimNode).id).distance(80))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("collision", d3.forceCollide(20))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .alphaDecay(0.02)
        .on("tick", () => {
          link
            .attr("x1", (d) => (d.source as SimNode).x ?? 0)
            .attr("y1", (d) => (d.source as SimNode).y ?? 0)
            .attr("x2", (d) => (d.target as SimNode).x ?? 0)
            .attr("y2", (d) => (d.target as SimNode).y ?? 0);

          node
            .attr("cx", (d) => d.x ?? 0)
            .attr("cy", (d) => d.y ?? 0);

          labels
            .attr("x", (d) => (d.x ?? 0) + 10)
            .attr("y", (d) => (d.y ?? 0) + 3);
        });

      simulationRef = simulation;

      const drag = d3
        .drag<SVGCircleElement, SimNode>()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        });

      const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 3]).on("zoom", (event) => {
        graphGroup.attr("transform", event.transform.toString());
      });

      svg.call(zoom as unknown as (selection: d3.Selection<SVGSVGElement, unknown, null, undefined>) => void);
      node.call(drag);
    })();

    return () => {
      mounted = false;
      if (simulationRef) {
        simulationRef.stop();
      }
      root.innerHTML = "";
    };
  }, [activeTab, explainFile, graph]);

  const repoDisplayName = repoNameMeta || getRepoName(repoUrl);

  if (!authReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#090b10]">
        <p className="text-[32px] font-semibold tracking-tight text-zinc-500 animate-pulse">neuron</p>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-[#090b10] text-[#f4f4f5] [background:radial-gradient(1200px_600px_at_100%_-10%,rgba(0,112,243,0.16),transparent_58%),radial-gradient(860px_420px_at_0%_0%,rgba(255,255,255,0.06),transparent_52%),#090b10]">
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap');
        html, body {
          font-family: 'Geist', sans-serif;
        }
        * {
          scrollbar-color: #3f3f46 #10131b;
        }
        @keyframes blink-cursor {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        @keyframes equalizer {
          from { height: 4px; }
          to { height: 16px; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        @keyframes tab-in {
          from { opacity: 0; transform: translateY(10px) scale(0.995); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-zinc-800/80 bg-[#0d1118]/95 backdrop-blur-xl animate-in slide-in-from-left duration-300">
          <div className="p-3">
            <button
              type="button"
              onClick={startNewChat}
              className="flex h-9 w-full items-center gap-2 rounded-md border border-zinc-700/80 bg-zinc-900/50 px-3 text-[13px] text-zinc-200 transition hover:bg-zinc-800/60"
            >
              <span className="text-base leading-none">+</span>
              <span>New chat</span>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {isHistoryLoading ? (
              <>
                {[0, 1, 2, 3].map((item) => (
                  <div key={item} className="px-3 py-2.5 rounded-md animate-pulse">
                    <div className="mb-1.5 h-3 w-3/4 rounded bg-zinc-800" />
                    <div className="h-2 w-1/2 rounded bg-zinc-800/60" />
                  </div>
                ))}
              </>
            ) : groupedHistory.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-zinc-600">No chats yet.</p>
            ) : (
              groupedHistory.map((group) => (
                <div key={group.label} className="mb-2">
                  <p className="px-3 py-2 text-[10px] uppercase tracking-widest text-zinc-600">{group.label}</p>
                  <div className="space-y-1">
                    {group.sessions.map((item) => {
                      const active = sessionId === item.id;

                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => openHistorySession(item.id)}
                          className={`group w-full rounded-md px-3 py-2.5 text-left transition ${
                            active
                              ? "border-l-2 border-sky-400 bg-zinc-800/70"
                              : "text-zinc-400 hover:bg-zinc-800/60"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-[12px] text-zinc-300">{item.repoName || getRepoName(item.repoUrl)}</p>
                              <p className="truncate text-[10px] text-zinc-600">
                                {item.messageCount} messages · {formatTimeAgo(item.createdAt, nowTick)}
                              </p>
                            </div>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteHistorySession(item.id);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void deleteHistorySession(item.id);
                                }
                              }}
                              className="invisible mt-0.5 text-[14px] leading-none text-zinc-600 transition hover:text-red-400 group-hover:visible"
                            >
                              ×
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-zinc-800/60 p-3">
            <div className="flex items-center gap-2">
              {currentUserAvatar ? (
                <Image
                  src={currentUserAvatar}
                  alt="avatar"
                  width={32}
                  height={32}
                  className="h-8 w-8 rounded-full object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-600 text-[11px] font-semibold text-white">
                  {(currentUserName || currentUserEmail || "N")
                    .split(" ")
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase())
                    .join("")}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-zinc-300">{currentUserName || currentUserEmail || "User"}</p>
                <p className="truncate text-[10px] text-zinc-600">{currentUserEmail || ""}</p>
              </div>

              <button
                type="button"
                onClick={() => {
                  void signOut();
                }}
                className="text-[11px] text-zinc-600 transition hover:text-zinc-300"
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[#090b10] animate-in fade-in duration-500">
          {(sessionId || isIngesting) && (
          <div className="sticky top-0 z-10">
            <header
              className="flex min-w-0 items-center gap-4 px-4"
              style={{
                height: "48px",
                borderBottom: "1px solid var(--border-subtle)",
                backgroundColor: "var(--bg-app)",
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={startNewChat}
                className="transition-opacity hover:opacity-80"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "var(--text-primary)",
                  letterSpacing: "-0.01em",
                }}
              >
                neuron
              </button>

              <div style={{ width: "1px", height: "16px", background: "var(--border-subtle)" }} />

              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div
                  className="flex min-w-0 flex-1 items-center"
                  style={{
                    maxWidth: "480px",
                    height: "32px",
                    padding: "0 10px",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--bg-elevated)",
                    transition: "border-color 150ms",
                  }}
                >
                  <input
                    ref={urlInputRef}
                    type="text"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleIngest();
                      }
                    }}
                    placeholder="github.com/owner/repo"
                    className="min-w-0 flex-1 border-none bg-transparent outline-none placeholder:text-[var(--text-tertiary)]"
                    style={{
                      fontSize: "12px",
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-primary)",
                    }}
                  />

                  {isIngested && (
                    <div className="hidden flex-shrink-0 items-center gap-2 md:flex">
                      <span className="font-mono text-[10px] text-[var(--text-secondary)]">{files.length} files</span>
                      <span className="text-[10px] text-[var(--text-tertiary)]">·</span>
                      <span className="text-[10px] text-[var(--text-tertiary)]">
                        indexed {indexedAt ? formatTimeAgo(indexedAt, nowTick) : "-"}
                      </span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    void handleIngest();
                  }}
                  disabled={!repoUrl.trim() || isIngesting}
                  className="h-8 flex-shrink-0 rounded-[var(--radius-md)] px-[14px] text-[12px] font-medium transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    background: "var(--text-primary)",
                    color: "var(--bg-app)",
                    border: "none",
                    fontFamily: "var(--font-sans)",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.opacity = "0.85";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.opacity = "1";
                  }}
                >
                  {isIngesting ? (
                    <span className="flex items-center gap-1.5">
                      <span className="flex gap-0.5">
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className="h-1 w-1 rounded-full bg-white/80"
                            style={{ animation: `pulse 1s ease-in-out ${i * 0.2}s infinite` }}
                          />
                        ))}
                      </span>
                    </span>
                  ) : (
                    "Analyze"
                  )}
                </button>
              </div>
            </header>

            {isIngesting && (
              <div
                style={{
                  height: "32px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "0 16px",
                  borderBottom: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--bg-surface)",
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    backgroundColor: "#ffffff",
                    animation: "pulse 1.5s ease-in-out infinite",
                  }}
                />

                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                  }}
                >
                  {ingestProgress.message || "Analyzing..."}
                </span>

                {(ingestProgress.current ?? 0) > 0 && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      color: "var(--text-tertiary)",
                      marginLeft: "auto",
                    }}
                  >
                    {ingestProgress.current}/{ingestProgress.total} files
                  </span>
                )}
              </div>
            )}

            <div
              style={{
                display: "flex",
                borderBottom: "1px solid var(--border-subtle)",
                padding: "0 16px",
                gap: "0",
                flexShrink: 0,
              }}
            >
              {["Chat", "Graph"].map((tab) => {
                const tabValue = tab.toLowerCase() as "chat" | "graph";
                const isActive = activeTab === tabValue;

                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tabValue)}
                    style={{
                      height: "40px",
                      padding: "0 12px",
                      background: "transparent",
                      border: "none",
                      borderBottom: isActive ? "1px solid var(--text-primary)" : "1px solid transparent",
                      marginBottom: "-1px",
                      fontSize: "12px",
                      fontWeight: isActive ? 500 : 400,
                      color: isActive ? "var(--text-primary)" : "var(--text-tertiary)",
                      cursor: "pointer",
                      transition: "color 150ms",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {tab}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          <div className={`min-h-0 flex-1 px-6 py-4 transition-opacity duration-200 ${isSessionSwitching ? "opacity-50" : "opacity-100"}`}>
            {ingestError && (
              <div className="mb-3 rounded-[6px] border border-red-500/30 bg-red-950/30 px-3 py-2 text-[12px] text-red-200">
                {ingestError}
              </div>
            )}

            {!sessionId && !isIngesting ? (
              <div className="flex h-full flex-col items-center justify-center">
                <p className="text-[48px] font-semibold tracking-tight text-zinc-700">neuron</p>
                <p className="mt-2 text-[14px] text-zinc-600">What codebase do you want to explore?</p>

                <div className="mt-6 flex h-10 w-full max-w-lg items-center gap-2 rounded-md border border-zinc-700/80 bg-zinc-900/70 px-3">
                  <input
                    ref={urlInputRef}
                    type="text"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleIngest();
                      }
                    }}
                    placeholder="github.com/owner/repo"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-zinc-300 placeholder-zinc-700 outline-none"
                  />

                  <button
                    type="button"
                    onClick={() => {
                      void handleIngest();
                    }}
                    disabled={!repoUrl.trim() || isIngesting}
                    className="h-7 rounded-md bg-sky-600 px-3 text-[12px] font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Analyze
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {[
                    "expressjs/express",
                    "vercel/next.js",
                    "facebook/react",
                  ].map((exampleRepo) => (
                    <button
                      key={exampleRepo}
                      type="button"
                      onClick={() => setRepoUrl(`https://github.com/${exampleRepo}`)}
                      className="rounded-md border border-zinc-700/80 px-3 py-1.5 text-[11px] text-zinc-500 transition hover:border-sky-500/35 hover:text-sky-300"
                    >
                      {exampleRepo}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
            activeTab === "chat" ? (
              <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-zinc-700/60 bg-[#111722]/95 shadow-[0_20px_60px_rgba(0,0,0,0.35)]" style={{ animation: "tab-in 180ms ease-out" }}>
                {sessionId && (
                  <div className="border-b border-zinc-800/60 px-8 py-3">
                    <p className="font-mono text-[13px] text-zinc-400">{repoDisplayName}</p>
                    <p className="text-[11px] text-zinc-600">
                      ingested {indexedAt ? formatTimeAgo(indexedAt, nowTick) : "-"} · {files.length} files
                    </p>
                  </div>
                )}
                <div ref={messageContainerRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6 scrollbar-thin">
                  {!isIngested && messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center">
                      <p className="pointer-events-none select-none text-[80px] font-semibold leading-none text-zinc-900">neuron</p>
                      <p className="mt-2 text-sm text-zinc-700">paste a github url to begin</p>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center text-[13px] text-zinc-600">
                      <p>Ask anything about the codebase.</p>
                      <div className="mt-6 flex flex-wrap gap-2">
                        {suggestions.map((suggestion) => (
                          <button
                            type="button"
                            key={suggestion}
                            disabled={isChatLoading}
                            className="rounded-md border border-zinc-700/70 px-3 py-2 text-left text-[11px] text-zinc-400 transition-all duration-150 hover:border-sky-500/35 hover:bg-sky-500/10 hover:text-sky-300"
                            onClick={() => {
                              void sendMessage(suggestion);
                            }}
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ maxWidth: "680px", margin: "0 auto", padding: "24px 32px" }}>
                      {messages.map((message, index) => {
                        const isUser = message.role === "user";
                        const isThinking = message.id.startsWith("local-thinking-");
                        const isError = message.text.startsWith("Error:") || message.text.startsWith("I encountered");

                        return (
                          <div key={message.id}>
                            <div
                              style={{
                                fontSize: "11px",
                                fontFamily: "var(--font-mono)",
                                color: isUser ? "var(--text-tertiary)" : "var(--text-primary)",
                                marginBottom: "6px",
                                fontWeight: 500,
                              }}
                            >
                              {isUser ? "you" : "neuron"}
                            </div>

                            <div
                              style={{
                                fontSize: "14px",
                                lineHeight: 1.7,
                                color: isUser ? "var(--text-secondary)" : "var(--text-primary)",
                                fontFamily: "var(--font-sans)",
                              }}
                            >
                              {isUser ? (
                                <p className="whitespace-pre-wrap" style={{ borderLeft: "2px solid var(--border-soft)", paddingLeft: "10px", fontFamily: "var(--font-mono)" }}>
                                  {message.text}
                                </p>
                              ) : isThinking ? (
                                <div className="flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
                                  <span
                                    style={{
                                      width: "6px",
                                      height: "6px",
                                      borderRadius: "50%",
                                      backgroundColor: "var(--text-primary)",
                                      animation: "pulse 1.2s ease-in-out infinite",
                                    }}
                                  />
                                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>thinking...</span>
                                </div>
                              ) : isError ? (
                                <p className="whitespace-pre-wrap" style={{ color: "var(--error)" }}>{message.text}</p>
                              ) : (
                                <div>
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                      p: ({ children }) => <p className="mb-3 text-[14px] leading-[1.7] last:mb-0">{children}</p>,
                                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                                      ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>,
                                      li: ({ children }) => <li className="text-[14px] leading-[1.7]">{children}</li>,
                                      code: ({ inline, children }: MarkdownCodeProps) =>
                                        inline ? (
                                          <code className="rounded-[4px] border px-1.5 py-0.5 font-mono text-[12px]" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-elevated)" }}>
                                            {children}
                                          </code>
                                        ) : (
                                          <pre className="my-3 overflow-x-auto rounded-[6px] border p-3" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-elevated)" }}>
                                            <code className="font-mono text-[12px] leading-relaxed">{children}</code>
                                          </pre>
                                        ),
                                      h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold">{children}</h1>,
                                      h2: ({ children }) => <h2 className="mb-2 mt-3 text-[14px] font-semibold">{children}</h2>,
                                      h3: ({ children }) => <h3 className="mb-1 mt-3 text-[13px] font-medium">{children}</h3>,
                                      blockquote: ({ children }) => (
                                        <blockquote className="my-2 border-l-2 pl-3 text-[13px] italic" style={{ borderColor: "var(--border-soft)", color: "var(--text-secondary)" }}>
                                          {children}
                                        </blockquote>
                                      ),
                                      hr: () => <hr className="my-4" style={{ borderColor: "var(--border-subtle)" }} />,
                                      a: ({ href, children }) => (
                                        <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: "var(--text-primary)" }}>
                                          {children}
                                        </a>
                                      ),
                                    }}
                                  >
                                    {message.text}
                                  </ReactMarkdown>
                                </div>
                              )}
                            </div>

                            {!isUser && index === lastAssistantIndex && (
                              <div className="mt-6 flex flex-wrap gap-2">
                                {buildFollowUps().slice(0, 4).map((chip) => (
                                  <button
                                    key={chip}
                                    type="button"
                                    disabled={isChatLoading}
                                    onClick={() => {
                                      void sendMessage(chip);
                                    }}
                                    className="rounded-[6px] border px-3 py-2 text-left text-[11px] transition-all duration-150"
                                    style={{
                                      borderColor: "var(--border-subtle)",
                                      color: "var(--text-secondary)",
                                      backgroundColor: "transparent",
                                    }}
                                  >
                                    {chip}
                                  </button>
                                ))}
                              </div>
                            )}

                            {index < messages.length - 1 && (
                              <div style={{ height: "1px", background: "var(--border-subtle)", margin: "20px 0" }} />
                            )}
                          </div>
                        );
                      })}

                    </div>
                  )}
                </div>

                <div
                  style={{
                    borderTop: "1px solid var(--border-subtle)",
                    padding: "12px 16px",
                    flexShrink: 0,
                  }}
                >
                  <div
                    onFocus={() => setIsComposerFocused(true)}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                        setIsComposerFocused(false);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "flex-end",
                      gap: "8px",
                      padding: "10px 12px",
                      border: `1px solid ${isComposerFocused ? "var(--border-strong)" : "var(--border-subtle)"}`,
                      borderRadius: "var(--radius-md)",
                      backgroundColor: "var(--bg-elevated)",
                      transition: "border-color 150ms",
                      opacity: !isIngested ? 0.45 : 1,
                    }}
                  >
                    <textarea
                      ref={textareaRef}
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void sendMessage(chatInput);
                        }
                      }}
                      disabled={!isIngested || isChatLoading || !sessionId}
                      placeholder={isIngested ? "Ask about the codebase..." : "Ingest a repository first"}
                      rows={1}
                      style={{
                        flex: 1,
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        resize: "none",
                        fontSize: "13px",
                        fontFamily: "var(--font-sans)",
                        color: "var(--text-primary)",
                        lineHeight: 1.6,
                        minHeight: "20px",
                        maxHeight: "160px",
                      }}
                    />

                    {chatInput.trim().length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          void sendMessage(chatInput);
                        }}
                        disabled={!isIngested || isChatLoading || !sessionId}
                        style={{
                          width: "24px",
                          height: "24px",
                          background: "var(--text-primary)",
                          border: "none",
                          borderRadius: "var(--radius-sm)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          flexShrink: 0,
                          opacity: !isIngested || isChatLoading || !sessionId ? 0.4 : 1,
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--bg-app)" strokeWidth="2.5">
                          <path d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                      </button>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginTop: "6px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "10px",
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-tertiary)",
                      }}
                    >
                      ↵ send · ⇧↵ newline
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-zinc-700/60 bg-[#111722]/95 shadow-[0_20px_60px_rgba(0,0,0,0.35)]" style={{ animation: "tab-in 180ms ease-out" }}>
                {graph ? (
                  <>
                    <div className="flex items-center gap-4 border-b border-zinc-800/40 px-4 py-2 font-mono text-[11px] text-zinc-600">
                      <span>{graph.nodes.length} files</span>
                      <span>·</span>
                      <span>{graph.edges.length} dependencies</span>
                      <span>·</span>
                      <span>click a node to ask about it</span>
                      <div className="ml-auto flex items-center gap-2">
                        <span>scroll to zoom</span>
                        <span>·</span>
                        <span>drag to pan</span>
                      </div>
                    </div>

                    <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(420px_220px_at_50%_20%,rgba(0,112,243,0.14),transparent_65%)]">
                      <div ref={graphRef} className="h-full w-full overflow-hidden" />
                      <div className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-2 text-[10px] text-zinc-400">
                        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-blue-500" />TS</div>
                        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-yellow-500" />JS</div>
                        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-green-500" />PY</div>
                        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-gray-500" />CFG</div>
                        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-purple-500" />CSS</div>
                        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-zinc-500" />Other</div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-[13px] text-zinc-600">
                    Ingest a repository to explore the dependency graph.
                  </div>
                )}
              </div>
            )
            )}
          </div>
        </section>

        <aside
          className="w-[220px] shrink-0 overflow-hidden border-l"
          style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}
        >
          <div
            style={{
              padding: "16px 12px 6px",
              fontSize: "11px",
              fontWeight: 500,
              color: "var(--text-tertiary)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontFamily: "var(--font-sans)",
            }}
          >
            Files
          </div>

          <div
            style={{
              margin: "8px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "0 8px",
              height: "28px",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--bg-elevated)",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              placeholder="Filter..."
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          <div className="h-[calc(100%-80px)] overflow-y-auto pb-2">
            {filteredFiles.length === 0 ? (
              <p className="px-3 py-2 text-[11px]" style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                {files.length === 0 ? "No files yet" : "No matches"}
              </p>
            ) : (
              filteredFiles.map((item) => {
                const isSelected = selectedFile === item.path;
                const langColor = getLangColor(item.language);
                const segments = item.path.split("/");
                const displayName = segments[segments.length - 1] || item.path;

                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => setSelectedFile(item.path)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "4px 12px",
                      background: isSelected ? "var(--bg-elevated)" : "transparent",
                      border: "none",
                      borderLeft: isSelected ? "2px solid var(--text-primary)" : "2px solid transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 100ms",
                    }}
                    title={item.path}
                  >
                    <span
                      style={{
                        width: "4px",
                        height: "4px",
                        borderRadius: "50%",
                        backgroundColor: langColor,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "12px",
                        fontFamily: "var(--font-mono)",
                        color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      {displayName}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </div>

      <footer
        style={{
          height: "24px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 12px",
          borderTop: "1px solid var(--border-subtle)",
          backgroundColor: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <span
            style={{
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              backgroundColor: isIngested ? "var(--success)" : "var(--text-tertiary)",
            }}
          />
          <span
            style={{
              fontSize: "11px",
              fontFamily: "var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            {isIngested ? `${repoDisplayName} · ${files.length} files` : "no repository"}
          </span>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: "12px" }}>
          <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }}>
            gemini 1.5 flash
          </span>
          <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }}>
            {messages.length} messages
          </span>
        </div>
      </footer>
    </main>
  );
}
