"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    const next = typeof window === "undefined" ? "/" : new URLSearchParams(window.location.search).get("next") || "/";
    router.replace(`/auth?next=${encodeURIComponent(next)}`);
  }, [router]);

  return null;
}
