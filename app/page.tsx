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
  error?: string;
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

type OnboardingResponse = {
  brief?: string;
  persona?: "fullstack" | "backend" | "frontend";
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
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "graph">("chat");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [panelOpen, setPanelOpen] = useState<boolean>(false);
  const [chatInput, setChatInput] = useState<string>("");
  const [statusText, setStatusText] = useState<string>("idle");
  const [analysisText, setAnalysisText] = useState<string>("");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [indexedAt, setIndexedAt] = useState<Date | null>(null);
  const [repoNameMeta, setRepoNameMeta] = useState<string>("");
  const [progress, setProgress] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string>("resolving");
  const [lastQuestion, setLastQuestion] = useState<string>("");
  const [isOnboardingLoading, setIsOnboardingLoading] = useState<boolean>(false);
  const [onboardingPersona, setOnboardingPersona] = useState<"fullstack" | "backend" | "frontend">("fullstack");

  const messageContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const progressRef = useRef<NodeJS.Timeout | null>(null);
  const messageCacheRef = useRef<Record<string, AppMessage[]>>({});

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

      setIsChatLoading(true);
      setChatInput("");
      setLastQuestion(trimmed);

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
          setMessages((prev) => [
            ...prev,
            {
              id: `${Date.now()}-local-error`,
              sessionId,
              role: "assistant",
              text: `Error: ${payload.error || "Request failed"}`,
              fileRef: null,
              createdAt: new Date(),
            },
          ]);
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-fetch-error`,
            sessionId,
            role: "assistant",
            text: "Error: Failed to fetch answer. Please try again.",
            fileRef: null,
            createdAt: new Date(),
          },
        ]);
      } finally {
        setIsChatLoading(false);
      }
    },
    [isChatLoading, isIngested, sessionId],
  );

  const generateOnboardingBrief = useCallback(async (): Promise<void> => {
    if (!sessionId || !isIngested || isOnboardingLoading) {
      return;
    }

    setIsOnboardingLoading(true);
    setActiveTab("chat");

    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, persona: onboardingPersona }),
      });

      const payload = (await response.json()) as OnboardingResponse;

      if (!response.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-onboarding-error`,
            sessionId,
            role: "assistant",
            text: `Error: ${payload.error || "Failed to generate onboarding brief"}`,
            fileRef: null,
            createdAt: new Date(),
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-onboarding-fetch-error`,
          sessionId,
          role: "assistant",
          text: "Error: Could not generate onboarding brief right now.",
          fileRef: null,
          createdAt: new Date(),
        },
      ]);
    } finally {
      setIsOnboardingLoading(false);
    }
  }, [isIngested, isOnboardingLoading, onboardingPersona, sessionId]);

  const handleAnalyze = async (): Promise<void> => {
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
    setAnalysisText("Analyzing files...");
    setProgress(0);

    if (progressRef.current) {
      clearInterval(progressRef.current);
      progressRef.current = null;
    }

    progressRef.current = setInterval(() => {
      setProgress((value) => {
        if (value >= 85) {
          if (progressRef.current) {
            clearInterval(progressRef.current);
            progressRef.current = null;
          }

          return 85;
        }

        return value + Math.random() * 4;
      });
    }, 400);

    try {
      const ingestResponse = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: trimmedUrl }),
      });
      const ingestPayload = (await ingestResponse.json()) as IngestResponse;

      if (!ingestResponse.ok || !ingestPayload.success || !ingestPayload.sessionId) {
        throw new Error(ingestPayload.error || "Failed to ingest repository");
      }

      setAnalysisText(`Analyzing ${ingestPayload.fileCount ?? 0} files...`);

      const nextSessionId = ingestPayload.sessionId;
      setSessionId(nextSessionId);
      setRepoNameMeta(getRepoName(trimmedUrl));
      window.history.pushState({}, "", `/session/${nextSessionId}`);

      await loadGraphState(nextSessionId);
      await loadInitialMessages(nextSessionId);
      await loadSessionHistory();

      setIndexedAt(new Date());
      setIsIngested(true);
      setStatusText("ready");
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
  const statusLeftText =
    statusText === "error"
      ? "error - check console"
      : isIngesting
      ? `analyzing ${repoDisplayName}...`
      : isIngested
      ? `${repoDisplayName} - ${files.length} files - indexed ${formatTimeAgo(indexedAt, nowTick)}`
      : "ready";

  if (!authReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#080809]">
        <p className="font-mono text-[32px] text-zinc-600 animate-pulse">neuron</p>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-[#080809] text-[#f4f4f5] [background:radial-gradient(1200px_500px_at_80%_-10%,rgba(124,58,237,0.18),transparent_55%),radial-gradient(900px_420px_at_0%_0%,rgba(56,189,248,0.08),transparent_45%),#080809]">
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&display=swap');
        html, body {
          font-family: 'Geist Mono', monospace;
        }
        * {
          scrollbar-color: #3f3f46 #0b0b0f;
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
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-zinc-800/60 bg-[#0a0a0b]/90 backdrop-blur-xl animate-in slide-in-from-left duration-300">
          <div className="p-3">
            <button
              type="button"
              onClick={startNewChat}
              className="flex h-9 w-full items-center gap-2 rounded-md border border-zinc-700/60 px-3 text-[13px] text-zinc-300 transition hover:bg-zinc-800/40"
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
                              ? "border-l-2 border-violet-500 bg-zinc-800"
                              : "text-zinc-400 hover:bg-zinc-800/50"
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
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">
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

        <section className="flex min-w-0 flex-1 flex-col bg-[#080809] animate-in fade-in duration-500">
          {(sessionId || isIngesting) && (
          <div className="sticky top-0 z-10">
            <header className="flex h-14 min-w-0 flex-shrink-0 items-center gap-3 border-b border-zinc-800/60 bg-zinc-950/70 px-5 backdrop-blur-xl animate-in slide-in-from-top duration-300">
              <div className="flex flex-shrink-0 items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full bg-emerald-400"
                  style={isIngested ? { boxShadow: "0 0 6px #34d399" } : {}}
                />
                <span
                  className="text-[13px] font-medium tracking-widest text-zinc-300"
                  style={{ fontFamily: "monospace" }}
                >
                  NEURON
                </span>
              </div>

              <div className="h-4 w-px flex-shrink-0 bg-zinc-800" />

              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 h-9 transition-colors duration-200 focus-within:border-violet-500/40">
                  <svg className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                  </svg>

                  <input
                    ref={urlInputRef}
                    type="text"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleAnalyze();
                      }
                    }}
                    placeholder="github.com/owner/repo"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-zinc-300 placeholder-zinc-700 outline-none"
                  />

                  {isIngested && (
                    <div className="hidden flex-shrink-0 items-center gap-2 md:flex">
                      <span className="font-mono text-[10px] text-zinc-600">{files.length} files</span>
                      <span className="text-[10px] text-zinc-700">·</span>
                      <span className="text-[10px] text-zinc-700">
                        indexed {indexedAt ? formatTimeAgo(indexedAt, nowTick) : "-"}
                      </span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    void handleAnalyze();
                  }}
                  disabled={!repoUrl.trim() || isIngesting}
                  className="h-9 flex-shrink-0 rounded-md bg-violet-600 px-5 text-[12px] font-semibold text-white transition-all duration-200 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
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

              <span className="hidden flex-shrink-0 font-mono text-[10px] text-zinc-700 lg:block">⌘K</span>
            </header>

            <div className="h-[2px] flex-shrink-0 overflow-hidden bg-zinc-900">
              <div
                className="h-full bg-violet-500 transition-all duration-500 ease-out"
                style={{
                  width: `${progress}%`,
                  opacity: progress === 0 ? 0 : 1,
                  boxShadow: progress > 0 ? "0 0 8px rgba(139,92,246,0.6)" : "none",
                }}
              />
            </div>

            {isIngesting && (
              <p className="px-5 pt-1 text-[11px] text-zinc-600">{analysisText || "Analyzing..."}</p>
            )}

            <div className="mt-1 flex h-10 items-end justify-between px-1">
              <div className="flex items-end gap-4">
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1.5 text-[12px] transition-all duration-200 ${
                    activeTab === "chat"
                      ? "bg-zinc-800 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.35)]"
                      : "text-zinc-500 hover:bg-zinc-900/70 hover:text-zinc-300"
                  }`}
                  onClick={() => setActiveTab("chat")}
                >
                  Chat
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1.5 text-[12px] transition-all duration-200 ${
                    activeTab === "graph"
                      ? "bg-zinc-800 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.35)]"
                      : "text-zinc-500 hover:bg-zinc-900/70 hover:text-zinc-300"
                  }`}
                  onClick={() => setActiveTab("graph")}
                >
                  Graph
                </button>
              </div>
              <div className="mb-1 flex items-center gap-2">
                {isIngested && sessionId && (
                  <>
                    <select
                      value={onboardingPersona}
                      onChange={(event) => {
                        const value = event.target.value as "fullstack" | "backend" | "frontend";
                        setOnboardingPersona(value);
                      }}
                      className="h-7 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[10px] text-zinc-300 outline-none"
                    >
                      <option value="fullstack">fullstack</option>
                      <option value="backend">backend</option>
                      <option value="frontend">frontend</option>
                    </select>

                    <button
                      type="button"
                      onClick={() => {
                        void generateOnboardingBrief();
                      }}
                      disabled={isOnboardingLoading}
                      className="h-7 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 text-[10px] font-medium text-violet-300 transition hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isOnboardingLoading ? "Generating..." : "Generate Brief"}
                    </button>
                  </>
                )}

                {messages.length > 0 && (
                  <div className="rounded-[6px] border border-white/10 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">
                    {messages.length}
                  </div>
                )}
                </div>
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
                <p className="font-mono text-[48px] text-zinc-800">neuron</p>
                <p className="mt-2 text-[14px] text-zinc-600">What codebase do you want to explore?</p>

                <div className="mt-6 flex w-full max-w-lg items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 h-10">
                  <input
                    ref={urlInputRef}
                    type="text"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleAnalyze();
                      }
                    }}
                    placeholder="github.com/owner/repo"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-zinc-300 placeholder-zinc-700 outline-none"
                  />

                  <button
                    type="button"
                    onClick={() => {
                      void handleAnalyze();
                    }}
                    disabled={!repoUrl.trim() || isIngesting}
                    className="h-7 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
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
                      className="rounded-md border border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500 transition hover:border-violet-500/30 hover:text-violet-300"
                    >
                      {exampleRepo}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
            activeTab === "chat" ? (
              <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#0f0f11]/95 shadow-[0_20px_60px_rgba(0,0,0,0.35)]" style={{ animation: "tab-in 180ms ease-out" }}>
                {sessionId && (
                  <div className="border-b border-zinc-800/60 px-8 py-3">
                    <p className="font-mono text-[13px] text-zinc-400">{repoDisplayName}</p>
                    <p className="text-[11px] text-zinc-600">
                      ingested {indexedAt ? formatTimeAgo(indexedAt, nowTick) : "-"} · {files.length} files
                    </p>
                  </div>
                )}
                <div
                  ref={messageContainerRef}
                  className="min-h-0 flex-1 overflow-y-auto px-8 py-6 space-y-8 scrollbar-thin"
                >
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
                            className="rounded-md border border-zinc-800 px-3 py-2 text-left text-[11px] text-zinc-500 transition-all duration-150 hover:border-violet-500/40 hover:bg-violet-500/5 hover:text-violet-400"
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
                    <div className="space-y-8">
                      {messages.map((message, index) => {
                        const isUser = message.role === "user";
                        const isError = message.text.startsWith("Error:") || message.text.startsWith("I encountered");
                        const timeAgo = formatTimeAgo(message.createdAt, nowTick);

                        return (
                          <div
                            key={message.id}
                            className={`group relative space-y-3 ${isUser ? "flex flex-col items-end" : ""}`}
                          >
                            <div className={`flex items-center gap-2 ${isUser ? "justify-end" : ""}`}>
                              <span
                                className={`text-[10px] font-medium uppercase tracking-widest ${
                                  isUser
                                    ? "rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 text-emerald-300"
                                    : "text-violet-500"
                                }`}
                              >
                                {isUser ? "you" : "neuron"}
                              </span>
                              <span className="text-[10px] text-zinc-700">{timeAgo}</span>
                            </div>

                            <div
                              className={`relative max-w-[85%] rounded-2xl border px-4 py-3 text-[13px] leading-7 ${
                                isUser
                                  ? "ml-auto border-emerald-400/25 bg-emerald-500/[0.10] text-right text-zinc-100 shadow-[0_8px_30px_rgba(16,185,129,0.10)]"
                                  : "border-zinc-800/80 bg-zinc-900/40 text-zinc-200"
                              }`}
                            >
                              {!isUser && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await navigator.clipboard.writeText(message.text);
                                    setCopiedId(message.id);
                                    window.setTimeout(() => {
                                      setCopiedId((prev) => (prev === message.id ? null : prev));
                                    }, 2000);
                                  }}
                                  className="absolute right-0 -top-6 hidden text-[10px] text-zinc-600 hover:text-zinc-300 group-hover:block"
                                >
                                  {copiedId === message.id ? "Copied!" : "Copy"}
                                </button>
                              )}

                              {isUser ? (
                                <p className="whitespace-pre-wrap text-zinc-100">{message.text}</p>
                              ) : isError ? (
                                <p className="whitespace-pre-wrap text-red-400">{`⚠ ${message.text}`}</p>
                              ) : (
                                <div className="text-zinc-200">
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                      p: ({ children }) => (
                                        <p className="mb-3 text-[13px] leading-7 text-zinc-200 last:mb-0">{children}</p>
                                      ),
                                      strong: ({ children }) => (
                                        <strong className="font-semibold text-zinc-100">{children}</strong>
                                      ),
                                      ul: ({ children }) => (
                                        <ul className="mb-3 list-none space-y-1.5 pl-0">{children}</ul>
                                      ),
                                      li: ({ children }) => (
                                        <li className="flex gap-2 text-[13px] leading-6 text-zinc-300">
                                          <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-violet-400" />
                                          <span>{children}</span>
                                        </li>
                                      ),
                                      code: ({ inline, children }: MarkdownCodeProps) =>
                                        inline ? (
                                          <code className="rounded border border-zinc-700/50 bg-zinc-800 px-1.5 py-0.5 font-mono text-[12px] text-violet-300">
                                            {children}
                                          </code>
                                        ) : (
                                          <pre className="my-3 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                                            <code className="font-mono text-[12px] leading-relaxed text-zinc-300">
                                              {children}
                                            </code>
                                          </pre>
                                        ),
                                      h1: ({ children }) => (
                                        <h1 className="mb-2 mt-4 text-base font-semibold text-zinc-100">{children}</h1>
                                      ),
                                      h2: ({ children }) => (
                                        <h2 className="mb-2 mt-3 text-[13px] font-semibold text-zinc-200">{children}</h2>
                                      ),
                                      h3: ({ children }) => (
                                        <h3 className="mb-1 mt-3 text-[13px] font-medium text-zinc-300">{children}</h3>
                                      ),
                                      blockquote: ({ children }) => (
                                        <blockquote className="my-2 border-l-2 border-violet-500/40 pl-3 text-[13px] italic text-zinc-400">
                                          {children}
                                        </blockquote>
                                      ),
                                      hr: () => <hr className="my-4 border-zinc-800" />,
                                      a: ({ href, children }) => (
                                        <a
                                          href={href}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-violet-400 underline underline-offset-2 hover:text-violet-300"
                                        >
                                          {children}
                                        </a>
                                      ),
                                    }}
                                  >
                                    {message.text}
                                  </ReactMarkdown>
                                </div>
                              )}

                              {isError && (
                                <button
                                  type="button"
                                  className="mt-2 text-[10px] text-zinc-500 hover:text-zinc-300"
                                  onClick={() => {
                                    const retryText =
                                      [...messages]
                                        .reverse()
                                        .find((item) => item.role === "user")?.text || lastQuestion;

                                    if (retryText) {
                                      void sendMessage(retryText);
                                    }
                                  }}
                                >
                                  Try again
                                </button>
                              )}

                              {!isUser && index === lastAssistantIndex && (
                                <div className="mt-6 flex flex-wrap gap-2">
                                  {buildFollowUps().slice(0, 4).map((chip) => (
                                    <button
                                      key={chip}
                                      type="button"
                                      onClick={() => {
                                        void sendMessage(chip);
                                      }}
                                      className="rounded-md border border-zinc-800 px-3 py-2 text-left text-[11px] text-zinc-500 transition-all duration-150 hover:border-violet-500/40 hover:bg-violet-500/5 hover:text-violet-400"
                                    >
                                      {chip}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {index < messages.length - 1 && <hr className="border-zinc-800/50" />}
                          </div>
                        );
                      })}

                      {isChatLoading && (
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-widest text-violet-500">
                              neuron
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex h-4 items-end gap-[3px]">
                              {[0, 1, 2, 3, 4].map((i) => (
                                <div
                                  key={i}
                                  className="w-[3px] rounded-full bg-violet-400"
                                  style={{
                                    height: `${Math.random() * 100}%`,
                                    animation: `equalizer 0.8s ease-in-out ${i * 0.1}s infinite alternate`,
                                    minHeight: "4px",
                                  }}
                                />
                              ))}
                            </div>
                            <span className="text-[12px] text-zinc-500">Analyzing codebase...</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex-shrink-0 border-t border-zinc-800/50 px-8 py-4">
                  <div
                    className={`flex items-end gap-3 rounded-xl border px-4 py-3 transition-all duration-200 ${
                      isIngested
                        ? "border-zinc-700/60 bg-zinc-900/40 focus-within:border-violet-500/30"
                        : "cursor-not-allowed border-zinc-800/40 opacity-40"
                    }`}
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
                      placeholder={isIngested ? "Message neuron..." : "Ingest a repository first"}
                      rows={1}
                      className="min-h-[24px] max-h-[160px] flex-1 resize-none bg-transparent py-0 font-mono text-[13px] leading-relaxed text-zinc-200 outline-none placeholder-zinc-700"
                    />

                    <button
                      type="button"
                      onClick={() => {
                        void sendMessage(chatInput);
                      }}
                      disabled={chatInput.trim().length === 0 || !isIngested || isChatLoading || !sessionId}
                      className="mb-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-violet-500 transition-all duration-150 hover:bg-violet-400 disabled:pointer-events-none disabled:opacity-0"
                    >
                      <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2.5}
                          d="M5 12h14M12 5l7 7-7 7"
                        />
                      </svg>
                    </button>
                  </div>

                  <div className="mt-2 flex justify-between px-1">
                    <span className="text-[10px] text-zinc-800">{isIngested ? `${messages.length} messages` : ""}</span>
                    <span className="font-mono text-[10px] text-zinc-800">↵ send · ⇧↵ newline</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#0f0f11]/95 shadow-[0_20px_60px_rgba(0,0,0,0.35)]" style={{ animation: "tab-in 180ms ease-out" }}>
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

                    <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(400px_220px_at_50%_20%,rgba(124,58,237,0.08),transparent_60%)]">
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
          className={`overflow-hidden border-l border-white/10 bg-[#0f0f11] transition-all duration-300 ${
            panelOpen ? "w-[300px]" : "w-0"
          }`}
        >
          {panelOpen && selectedFile && (
            <div className="h-full px-4 py-4">
              <div className="mb-4 flex items-start justify-between">
                <p className="pr-3 text-[11px] text-zinc-500">{selectedFile}</p>
                <button
                  type="button"
                  className="text-zinc-600 hover:text-zinc-300"
                  onClick={() => setPanelOpen(false)}
                >
                  ×
                </button>
              </div>

              <p className="text-[13px] leading-[1.8] text-zinc-300">
                {summaries[selectedFile] || "No summary available."}
              </p>

              <button
                type="button"
                className="mt-6 text-[11px] text-violet-400"
                onClick={() => {
                  void sendMessage(`Explain file \`${selectedFile}\` in more detail`);
                  setActiveTab("chat");
                }}
              >
                Ask about this file →
              </button>
            </div>
          )}
        </aside>
      </div>

      <footer className="flex h-6 items-center justify-between border-t border-white/5 px-3 text-[11px]">
        <div className="flex items-center gap-2 text-zinc-600">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              statusText === "error"
                ? "bg-red-500"
                : isIngesting
                ? "animate-pulse bg-violet-400"
                : isIngested
                ? "bg-emerald-400"
                : "bg-zinc-500"
            }`}
          />
          <span>{statusLeftText}</span>
        </div>
        <div className="text-zinc-700">
          {currentModel} · {messages.length} messages · session: {sessionId ? sessionId.slice(0, 8) : "-"}
        </div>
      </footer>
    </main>
  );
}
