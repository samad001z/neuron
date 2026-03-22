create extension if not exists vector;

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  repo_url    text not null,
  repo_name   text,
  file_count  int default 0,
  graph       jsonb,
  created_at  timestamptz default now()
);

create table messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references sessions(id) on delete cascade,
  role        text check (role in ('user', 'assistant')),
  content     text not null,
  file_ref    text,
  created_at  timestamptz default now()
);

create table file_chunks (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references sessions(id) on delete cascade,
  file_path   text not null,
  language    text,
  chunk_text  text not null,
  summary     text,
  embedding   vector(768),
  created_at  timestamptz default now()
);

create table codebase_cache (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid references sessions(id) on delete cascade,
  codebase_text   text not null,
  cached_at       timestamptz default now()
);

create or replace function match_chunks(
  query_embedding vector(768),
  match_session_id uuid,
  match_count int default 8
)
returns table (
  id uuid,
  file_path text,
  chunk_text text,
  summary text,
  similarity float
)
language sql stable
as $$
  select
    id, file_path, chunk_text, summary,
    1 - (embedding <=> query_embedding) as similarity
  from file_chunks
  where session_id = match_session_id
  order by embedding <=> query_embedding
  limit match_count;
$$;

alter publication supabase_realtime add table messages;

alter table sessions enable row level security;
alter table messages enable row level security;
alter table file_chunks enable row level security;
alter table codebase_cache enable row level security;

create policy "public read sessions" on sessions for select using (true);
create policy "public read messages" on messages for select using (true);

create policy "service write sessions" on sessions for insert with check (true);
create policy "service write messages" on messages for insert with check (true);
create policy "service write chunks" on file_chunks for insert with check (true);
create policy "service write cache" on codebase_cache for insert with check (true);

-- Auth migration: user-owned sessions, message visibility by session owner, and user profiles.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

DROP POLICY IF EXISTS "public read sessions" ON sessions;
CREATE POLICY "users read own sessions" ON sessions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users insert own sessions" ON sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users delete own sessions" ON sessions
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "public read messages" ON messages;
CREATE POLICY "users read own messages" ON messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.user_id = auth.uid())
  );

CREATE TABLE IF NOT EXISTS profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own profile" ON profiles;
CREATE POLICY "users read own profile" ON profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "users update own profile" ON profiles;
CREATE POLICY "users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
