import {
	createBrowserClient as createSupabaseBrowserClient,
	createServerClient as createSupabaseServerClient,
} from "@supabase/auth-helpers-nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Use this in React components and page.tsx
export const createBrowserClient = (): SupabaseClient => {
	if (!supabaseUrl || !supabaseAnonKey) {
		throw new Error("Missing Supabase environment variables");
	}

	return createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey);
};

// Use this in Server Components and API routes
export const createServerClient = async (): Promise<SupabaseClient> => {
	if (!supabaseUrl || !supabaseAnonKey) {
		throw new Error("Missing Supabase environment variables");
	}

	const { cookies } = await import("next/headers");
	const cookieStore = cookies();

	return createSupabaseServerClient(supabaseUrl, supabaseAnonKey, {
		cookies: {
			getAll() {
				return cookieStore.getAll();
			},
			setAll(cookiesToSet) {
				try {
					cookiesToSet.forEach(({ name, value, options }) => {
						cookieStore.set(name, value, options);
					});
				} catch {
					// Some server runtimes disallow setting cookies here.
				}
			},
		},
	});
};

export const supabase: SupabaseClient | null =
	supabaseUrl && supabaseAnonKey
		? createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey)
		: null;
