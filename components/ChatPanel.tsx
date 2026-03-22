"use client";

import { type ComponentPropsWithoutRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MessageRole = "user" | "assistant";

type ChatMessage = {
  role: MessageRole;
  text: string;
};

type ChatPanelProps = {
  repoUrl: string;
  isIngested: boolean;
  queuedQuestion?: string | null;
};

type AskApiSuccess = {
  answer: string;
};

type AskApiError = {
  error: string;
};

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
};

export default function ChatPanel({
  repoUrl,
  isIngested,
  queuedQuestion = null,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastQueuedQuestionRef = useRef<string | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  const inputDisabled = useMemo(() => !isIngested || isLoading, [isIngested, isLoading]);

  const sendQuestion = useCallback(async (question: string): Promise<void> => {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || !isIngested || isLoading) {
      return;
    }

    const userMessage: ChatMessage = { role: "user", text: trimmedQuestion };
    const placeholder: ChatMessage = { role: "assistant", text: "Thinking..." };

    setMessages((prev) => [...prev, userMessage, placeholder]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, question: trimmedQuestion }),
      });

      const payload = (await response.json()) as AskApiSuccess | AskApiError;
      const answer = "answer" in payload ? payload.answer : payload.error || "Failed to get answer";

      setMessages((prev) => {
        const updated = [...prev];
        const lastAssistantIdx = updated.length - 1;

        if (lastAssistantIdx >= 0 && updated[lastAssistantIdx]?.role === "assistant") {
          updated[lastAssistantIdx] = { role: "assistant", text: answer };
        }

        return updated;
      });
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        const lastAssistantIdx = updated.length - 1;

        if (lastAssistantIdx >= 0 && updated[lastAssistantIdx]?.role === "assistant") {
          updated[lastAssistantIdx] = {
            role: "assistant",
            text: "Error: failed to fetch answer",
          };
        }

        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }, [isIngested, isLoading, repoUrl]);

  const handleSend = async (): Promise<void> => {
    await sendQuestion(input);
  };

  useEffect(() => {
    if (!queuedQuestion || !isIngested || isLoading) {
      return;
    }

    if (queuedQuestion === lastQueuedQuestionRef.current) {
      return;
    }

    lastQueuedQuestionRef.current = queuedQuestion;
    void sendQuestion(queuedQuestion);
  }, [queuedQuestion, isIngested, isLoading, sendQuestion]);

  return (
    <section className="flex h-[480px] w-full max-w-3xl flex-col rounded-lg border border-slate-200 bg-white">
      <div ref={containerRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-slate-500">Ask questions about the ingested repository.</p>
        ) : (
          messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  message.role === "user"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-900"
                }`}
              >
                {message.role === "user" ? (
                  <p className="whitespace-pre-wrap">{message.text}</p>
                ) : (
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
                          className="underline-offset-2 text-violet-400 underline hover:text-violet-300"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {message.text}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-slate-200 p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void handleSend();
              }
            }}
            disabled={inputDisabled}
            placeholder={isIngested ? "Ask about the codebase..." : "Ingest a repo first"}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none ring-0 focus:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={inputDisabled || input.trim().length === 0}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
