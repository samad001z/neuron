import { NextResponse } from "next/server";
import { askGeminiRaw } from "@/lib/gemini";
import { jsonInternalError, logServerError } from "@/lib/apiErrors";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRouteSupabaseClient } from "@/lib/supabaseServer";

type SecurityRequestBody = {
  sessionId?: string;
};

type SecuritySummary = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  score: number;
  repoName: string;
  fileCount: number;
  generatedAt: string;
};

type SecuritySuccessResponse = {
  report: string;
  summary: SecuritySummary;
};

type SecurityErrorResponse = {
  error: string;
};

function isMissingUserIdColumnError(message?: string): boolean {
  if (!message) {
    return false;
  }

  const lower = message.toLowerCase();
  return lower.includes("user_id") && (lower.includes("schema cache") || lower.includes("column"));
}

function parseSeverityCounts(report: string): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  score: number;
} {
  const text = report.toUpperCase();

  const countOccurrences = (severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"): number => {
    const patterns = [
      new RegExp(`\\[SEVERITY:\\s*${severity}\\]`, "g"),
      new RegExp(`\\[${severity}\\]`, "g"),
      new RegExp(`\\*\\*${severity}\\*\\*`, "g"),
      new RegExp(`SEVERITY:\\s*${severity}`, "g"),
    ];

    // Deduplicate by line so one finding isn't counted multiple times.
    const lines = new Set<number>();
    const reportLines = text.split("\n");

    reportLines.forEach((line, idx) => {
      if (patterns.some((pattern) => pattern.test(line))) {
        lines.add(idx);
      }

      // Reset global regex cursors before the next line.
      patterns.forEach((pattern) => {
        pattern.lastIndex = 0;
      });
    });

    return lines.size;
  };

  const critical = countOccurrences("CRITICAL");
  const high = countOccurrences("HIGH");
  const medium = countOccurrences("MEDIUM");
  const low = countOccurrences("LOW");
  const total = critical + high + medium + low;

  const scoreMatches = report.match(/(\d+)\/10/g);
  const fallbackScore = Math.max(1, 10 - (critical * 3 + high * 2 + medium * 1 + low * 0.5));
  const parsedScore = scoreMatches
    ? Number.parseInt(scoreMatches[scoreMatches.length - 1].split("/")[0], 10)
    : fallbackScore;
  const normalizedScore = Math.min(10, Math.max(1, Math.round(parsedScore)));

  return {
    critical,
    high,
    medium,
    low,
    total,
    score: normalizedScore,
  };
}

export async function POST(request: Request) {
  try {
    const supabase = createRouteSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" } satisfies SecurityErrorResponse, { status: 401 });
    }

    const body = (await request.json()) as SecurityRequestBody;
    const sessionId = body?.sessionId?.trim();

    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId" } satisfies SecurityErrorResponse, { status: 400 });
    }

    const { data: sessionRow, error: sessionError } = await supabaseAdmin
      .from("sessions")
      .select("id, repo_name, file_count")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError && isMissingUserIdColumnError(sessionError.message)) {
      const fallbackSession = await supabaseAdmin
        .from("sessions")
        .select("id, repo_name, file_count")
        .eq("id", sessionId)
        .maybeSingle();

      if (fallbackSession.error || !fallbackSession.data) {
        return NextResponse.json({ error: "Session not found." } satisfies SecurityErrorResponse, { status: 404 });
      }

      const { data: cacheRow, error: cacheError } = await supabaseAdmin
        .from("codebase_cache")
        .select("codebase_text")
        .eq("session_id", sessionId)
        .maybeSingle();

      if (cacheError || !cacheRow?.codebase_text) {
        return NextResponse.json(
          { error: "Session not found. Please re-ingest the repository." } satisfies SecurityErrorResponse,
          { status: 404 },
        );
      }

      const prompt = `You are an expert security engineer performing a thorough security audit.
Analyze this codebase for security vulnerabilities.

CODEBASE:
${cacheRow.codebase_text.slice(0, 800000)}

Find ALL of the following vulnerability types:
1. XSS (Cross-Site Scripting) - unescaped user input rendered in HTML
2. SQL Injection - unsanitized input in database queries
3. Hardcoded Secrets - API keys, passwords, tokens in source code
4. Authentication Issues - weak auth, missing checks, session problems
5. Prototype Pollution - unsafe object merging or __proto__ manipulation
6. Path Traversal - unsanitized file paths
7. CSRF - missing CSRF protection on state-changing endpoints
8. Insecure Dependencies - known vulnerable package usage patterns
9. Information Disclosure - stack traces, debug info exposed to users
10. Injection Attacks - command injection, LDAP injection etc.

For EACH vulnerability found, provide EXACTLY this format:

### [SEVERITY: CRITICAL|HIGH|MEDIUM|LOW] Vulnerability Title
**File:** exact/file/path.ext
**Line:** line number or range
**Type:** vulnerability category
**Description:** what the vulnerability is and why it's dangerous
**Exploit:** how an attacker could exploit this
**Fix:** exact code change needed to fix it

After listing all vulnerabilities, add:

## Summary
- Total vulnerabilities found: X
- Critical: X | High: X | Medium: X | Low: X
- Overall security score: X/10
- Top priority fix: [most critical issue]`;

      const report = await askGeminiRaw(prompt);
      const { critical, high, medium, low, total, score } = parseSeverityCounts(report);

      return NextResponse.json({
        report,
        summary: {
          total,
          critical,
          high,
          medium,
          low,
          score,
          repoName: fallbackSession.data.repo_name ?? "unknown",
          fileCount: fallbackSession.data.file_count ?? 0,
          generatedAt: new Date().toISOString(),
        },
      } satisfies SecuritySuccessResponse);
    }

    if (sessionError || !sessionRow) {
      return NextResponse.json({ error: "Session not found." } satisfies SecurityErrorResponse, { status: 404 });
    }

    const { data: cacheRow, error: cacheError } = await supabaseAdmin
      .from("codebase_cache")
      .select("codebase_text")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (cacheError || !cacheRow?.codebase_text) {
      return NextResponse.json(
        { error: "Session not found. Please re-ingest the repository." } satisfies SecurityErrorResponse,
        { status: 404 },
      );
    }

    const prompt = `You are an expert security engineer performing a thorough security audit.
Analyze this codebase for security vulnerabilities.

CODEBASE:
${cacheRow.codebase_text.slice(0, 800000)}

Find ALL of the following vulnerability types:
1. XSS (Cross-Site Scripting) - unescaped user input rendered in HTML
2. SQL Injection - unsanitized input in database queries
3. Hardcoded Secrets - API keys, passwords, tokens in source code
4. Authentication Issues - weak auth, missing checks, session problems
5. Prototype Pollution - unsafe object merging or __proto__ manipulation
6. Path Traversal - unsanitized file paths
7. CSRF - missing CSRF protection on state-changing endpoints
8. Insecure Dependencies - known vulnerable package usage patterns
9. Information Disclosure - stack traces, debug info exposed to users
10. Injection Attacks - command injection, LDAP injection etc.

For EACH vulnerability found, provide EXACTLY this format:

### [SEVERITY: CRITICAL|HIGH|MEDIUM|LOW] Vulnerability Title
**File:** exact/file/path.ext
**Line:** line number or range
**Type:** vulnerability category
**Description:** what the vulnerability is and why it's dangerous
**Exploit:** how an attacker could exploit this
**Fix:** exact code change needed to fix it

After listing all vulnerabilities, add:

## Summary
- Total vulnerabilities found: X
- Critical: X | High: X | Medium: X | Low: X
- Overall security score: X/10
- Top priority fix: [most critical issue]`;

    const report = await askGeminiRaw(prompt);
    const { critical, high, medium, low, total, score } = parseSeverityCounts(report);

    return NextResponse.json({
      report,
      summary: {
        total,
        critical,
        high,
        medium,
        low,
        score,
        repoName: sessionRow.repo_name ?? "unknown",
        fileCount: sessionRow.file_count ?? 0,
        generatedAt: new Date().toISOString(),
      },
    } satisfies SecuritySuccessResponse);
  } catch (error: unknown) {
    logServerError("/api/security", error);
    return jsonInternalError();
  }
}
