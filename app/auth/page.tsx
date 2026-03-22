"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase";

type AuthMode = "signin" | "signup";

export default function AuthPage() {
  const router = useRouter();
  const supabase = useMemo(() => createBrowserClient(), []);

  const [mode, setMode] = useState<AuthMode>("signin");
  const [fullName, setFullName] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string>("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErrorText("");
    setIsLoading(true);

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
            },
          },
        });

        if (error) {
          setErrorText(error.message);
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
          setErrorText(error.message);
          return;
        }
      }

      router.push("/");
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogle = async (): Promise<void> => {
    setErrorText("");
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setErrorText(error.message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#080809] px-4 text-zinc-100">
      <section className="w-full max-w-[380px] rounded-xl border border-zinc-800 bg-zinc-900/60 p-8">
        <div className="text-center">
          <h1 className="text-[20px] text-zinc-200" style={{ fontFamily: "monospace" }}>
            neuron
          </h1>
          <p className="mt-1 text-[12px] text-zinc-600">understand any codebase instantly</p>
        </div>

        <div className="mt-6 grid grid-cols-2">
          <button
            type="button"
            onClick={() => setMode("signin")}
            className={`border-b pb-2 text-[13px] transition ${
              mode === "signin" ? "border-violet-500 text-zinc-100" : "border-transparent text-zinc-600"
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => setMode("signup")}
            className={`border-b pb-2 text-[13px] transition ${
              mode === "signup" ? "border-violet-500 text-zinc-100" : "border-transparent text-zinc-600"
            }`}
          >
            Sign up
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          {mode === "signup" && (
            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-zinc-600">full name</span>
              <input
                type="text"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-zinc-700/60 bg-zinc-800/60 px-3 font-mono text-[13px] text-zinc-200 outline-none focus:border-violet-500/40"
              />
            </label>
          )}

          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-zinc-600">email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 h-10 w-full rounded-md border border-zinc-700/60 bg-zinc-800/60 px-3 font-mono text-[13px] text-zinc-200 outline-none focus:border-violet-500/40"
            />
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-zinc-600">password</span>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 h-10 w-full rounded-md border border-zinc-700/60 bg-zinc-800/60 px-3 font-mono text-[13px] text-zinc-200 outline-none focus:border-violet-500/40"
            />
          </label>

          <button
            type="submit"
            disabled={isLoading}
            className="flex h-10 w-full items-center justify-center rounded-md bg-violet-600 text-[13px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Loading...
              </span>
            ) : (
              "Continue"
            )}
          </button>

          {errorText && <p className="text-[12px] text-red-400">{errorText}</p>}
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-zinc-700" />
          <span className="text-[11px] text-zinc-600">or continue with</span>
          <div className="h-px flex-1 bg-zinc-700" />
        </div>

        <button
          type="button"
          onClick={() => {
            void handleGoogle();
          }}
          disabled={isLoading}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-700 bg-transparent text-[13px] text-zinc-300 transition hover:bg-zinc-800/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.73 1.22 9.24 3.6l6.9-6.9C35.95 2.33 30.38 0 24 0 14.62 0 6.51 5.38 2.56 13.22l8.04 6.24C12.53 13.75 17.84 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.5 24.5c0-1.68-.15-3.3-.43-4.85H24v9.2h12.67c-.55 2.98-2.24 5.5-4.78 7.2l7.35 5.7C43.84 37.56 46.5 31.58 46.5 24.5z"/>
            <path fill="#FBBC05" d="M10.6 28.54A14.4 14.4 0 0 1 9.8 24c0-1.58.28-3.1.8-4.54l-8.04-6.24A24 24 0 0 0 0 24c0 3.86.92 7.5 2.56 10.78l8.04-6.24z"/>
            <path fill="#34A853" d="M24 48c6.38 0 11.74-2.1 15.66-5.7l-7.35-5.7c-2.04 1.37-4.66 2.2-8.31 2.2-6.16 0-11.47-4.25-13.4-9.96l-8.04 6.24C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>

        <p className="mt-5 text-center text-[10px] text-zinc-700">By continuing you agree to our Terms</p>
      </section>
    </main>
  );
}
