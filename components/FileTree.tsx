"use client";

import { useMemo, useState } from "react";

type FileTreeItem = {
  path: string;
  language: string;
};

type FileTreeProps = {
  files: FileTreeItem[];
  summaries: Record<string, string>;
  onFileClick: (path: string) => void;
};

type FolderGroup = {
  folder: string;
  files: FileTreeItem[];
};

function getLanguageBadge(language: string): string {
  const normalized = language.trim().toLowerCase();

  if (normalized.includes("typescript")) return "TS";
  if (normalized.includes("javascript")) return "JS";
  if (normalized.includes("python")) return "PY";
  if (normalized.includes("java")) return "JAVA";
  if (normalized.includes("go")) return "GO";
  if (normalized.includes("rust")) return "RS";
  if (normalized.includes("c++")) return "CPP";
  if (normalized === "c") return "C";
  if (normalized.includes("c#")) return "CS";

  return "TXT";
}

function getFileName(filePath: string): string {
  const filename = filePath.split("/").pop() || filePath;
  const isGenericName = [
    "index.js",
    "index.ts",
    "index.jsx",
    "index.tsx",
    "main.js",
    "main.ts",
    "app.js",
    "app.ts",
    "utils.js",
    "utils.ts",
  ].includes(filename);

  return isGenericName ? filePath.split("/").slice(-2).join("/") : filename;
}

function groupByTopLevelFolder(files: FileTreeItem[]): FolderGroup[] {
  const groups = new Map<string, FileTreeItem[]>();

  for (const file of files) {
    const [firstSegment] = file.path.split("/");
    const folder = firstSegment || "root";
    const current = groups.get(folder) ?? [];
    current.push(file);
    groups.set(folder, current);
  }

  return Array.from(groups.entries())
    .map(([folder, groupedFiles]) => ({
      folder,
      files: groupedFiles.sort((a: FileTreeItem, b: FileTreeItem) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

export default function FileTree({ files, summaries, onFileClick }: FileTreeProps) {
  const groupedFolders = useMemo(() => groupByTopLevelFolder(files), [files]);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const toggleFolder = (folder: string): void => {
    setCollapsedFolders((prev) => ({
      ...prev,
      [folder]: !prev[folder],
    }));
  };

  const handleFileClick = (path: string): void => {
    setSelectedPath(path);
    onFileClick(path);
  };

  return (
    <aside className="h-full w-full max-w-sm overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-3 text-slate-100">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">Files</h2>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
          {files.length}
        </span>
      </div>

      <div className="space-y-2">
        {groupedFolders.length === 0 ? (
          <p className="text-xs text-slate-400">No files available.</p>
        ) : (
          groupedFolders.map((group) => {
            const isCollapsed = collapsedFolders[group.folder] ?? false;

            return (
              <div key={group.folder} className="rounded border border-slate-800 bg-slate-950/50">
                <button
                  type="button"
                  onClick={() => toggleFolder(group.folder)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-300 hover:bg-slate-800"
                >
                  <span>{group.folder}</span>
                  <span className="text-slate-500">{isCollapsed ? "+" : "-"}</span>
                </button>

                {!isCollapsed && (
                  <ul className="space-y-1 px-2 pb-2">
                    {group.files.map((file) => {
                      const isSelected = selectedPath === file.path;
                      const summary = summaries[file.path] ?? "No summary available";

                      return (
                        <li key={file.path}>
                          <button
                            type="button"
                            title={file.path}
                            aria-label={`${getFileName(file.path)} - ${summary}`}
                            onClick={() => handleFileClick(file.path)}
                            className={`group flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition ${
                              isSelected
                                ? "bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/40"
                                : "text-slate-300 hover:bg-slate-800 hover:text-white"
                            }`}
                          >
                            <span className="truncate pr-2">{getFileName(file.path)}</span>
                            <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-bold text-slate-200 group-hover:bg-slate-600">
                              {getLanguageBadge(file.language)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
