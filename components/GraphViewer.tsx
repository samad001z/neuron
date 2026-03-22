"use client";

import type { DependencyGraph } from "@/types";

type GraphViewerProps = {
  graph: DependencyGraph | null;
  onNodeClick: (nodeId: string) => void;
};

export default function GraphViewer({ graph, onNodeClick }: GraphViewerProps) {
  if (!graph) {
    return (
      <section className="flex h-[560px] items-center justify-center rounded-lg border border-slate-800 bg-slate-950 text-sm text-slate-400">
        Ingest a repository to view its dependency graph.
      </section>
    );
  }

  return (
    <section className="h-[560px] overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-semibold">Dependency Graph</h3>
        <p className="mt-1 text-xs text-slate-400">
          Nodes: {graph.nodes.length} | Edges: {graph.edges.length}
        </p>
      </header>

      <div className="grid h-[calc(560px-65px)] grid-cols-1 gap-0 lg:grid-cols-2">
        <div className="overflow-y-auto border-b border-slate-800 p-3 lg:border-b-0 lg:border-r">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Files</p>
          <ul className="space-y-1">
            {graph.nodes.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => onNodeClick(node.id)}
                  className="w-full rounded px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-800"
                >
                  {node.label}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="overflow-y-auto p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Edges</p>
          <ul className="space-y-1 text-xs text-slate-300">
            {graph.edges.map((edge, index) => (
              <li key={`${edge.source}-${edge.target}-${index}`} className="rounded bg-slate-900/70 px-2 py-1">
                {edge.source} {"->"} {edge.target}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
