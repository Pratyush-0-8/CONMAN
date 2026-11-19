// Representative legacy schema, used only by disposable PostgreSQL tests.
export async function createLegacyFixture(db) {
  await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public,auth to anon,authenticated,service_role;
create table public.profiles(id uuid primary key references auth.users(id),username text unique not null,elo integer not null default 500,wins integer not null default 0,losses integer not null default 0,created_at timestamptz not null default now());
create table public.matches(id uuid primary key default gen_random_uuid(),player1_id uuid references profiles(id),player2_id uuid references profiles(id),mode text check(mode in ('voice','typing')),opponent_type text check(opponent_type in ('human','bot')),bot_name text,bot_elo integer,bot_skill_tier text,question text,status text not null check(status = ANY (ARRAY['waiting','brainstorming','speaking','judging','completed'])),winner_id uuid,created_at timestamptz default now());
create table public.match_answers(id uuid primary key default gen_random_uuid(),match_id uuid references matches(id),player_id uuid references profiles(id),is_bot boolean default false,answer_text text,submitted_at timestamptz default now());
grant all on public.profiles,public.matches,public.match_answers to anon,authenticated,service_role;
create policy existing_profile_select on public.profiles for select using(true);
create policy existing_match_select on public.matches for select using(true);
create policy existing_answer_select on public.match_answers for select using(true);
`);
}
