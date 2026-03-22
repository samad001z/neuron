import type { ChatSession, GroupedSessions } from "@/types";

export function groupSessionsByDate(sessions: ChatSession[]): GroupedSessions[] {
  const now = new Date();
  const groups: Record<string, ChatSession[]> = {};

  sessions.forEach((session) => {
    const created = new Date(session.createdAt);
    const diffDays = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));

    let label: string;
    if (diffDays === 0) label = "Today";
    else if (diffDays === 1) label = "Yesterday";
    else if (diffDays <= 7) label = "Previous 7 days";
    else if (diffDays <= 30) label = "Previous 30 days";
    else label = created.toLocaleString("default", { month: "long", year: "numeric" });

    if (!groups[label]) groups[label] = [];
    groups[label].push(session);
  });

  const order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days"];
  return Object.entries(groups)
    .sort(([a], [b]) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return new Date(b).getTime() - new Date(a).getTime();
    })
    .map(([label, grouped]) => ({ label, sessions: grouped }));
}
