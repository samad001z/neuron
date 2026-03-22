import { NextResponse } from "next/server";

type ErrorPayload = {
  error: string;
};

export function logServerError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}]`, message);
}

export function jsonInternalError(message = "Internal server error") {
  return NextResponse.json({ error: message } satisfies ErrorPayload, { status: 500 });
}
