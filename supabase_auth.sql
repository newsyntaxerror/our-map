-- =============================================================
-- 우리끼리 — 아이디 + 비밀번호 로그인 (이메일 없이)
-- =============================================================
-- · 닉네임만 쓰던 익명 프로필에 '아이디'와 '비밀번호'를 붙여,
--   기기를 바꾸거나 브라우저 저장소가 지워져도 친구·채팅·동선을 되찾을 수 있게 합니다.
-- · 비밀번호는 pgcrypto 의 bcrypt 해시로만 저장하고, 해시는 앱(클라이언트)으로 나가지 않습니다.
-- · 로그인에 성공하면 1년짜리 session_token 을 발급합니다.
--   기존 함수들이 쓰는 p_secret 자리에 session_token 을 넣어도 인증이 됩니다.
-- · 여러 번 실행해도 안전합니다(if not exists / create or replace).
-- · 기존 프로필(friend_profiles)과 친구·메시지·동선 데이터는 건드리지 않습니다.
-- =============================================================

-- 16-1) 확장 · 열 --------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

alter table public.friend_profiles add column if not exists username      text;
alter table public.friend_profiles add column if not exists password_hash text;
alter table public.friend_profiles add column if not exists username_at   timestamptz;

-- 아이디는 대소문자를 구분하지 않고 하나만 (소문자로 저장)
create unique index if not exists friend_profiles_username_uidx
  on public.friend_profiles (lower(username))
  where username is not null;

-- 16-2) 로그인 세션 -----------------------------------------------
create table if not exists public.auth_sessions (
  token        text primary key check (char_length(token) between 32 and 128),
  user_id      text not null references public.friend_profiles(user_id) on delete cascade,
  device       text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '365 days')
);

create index if not exists auth_sessions_user_idx   on public.auth_sessions (user_id);
create index if not exists auth_sessions_expiry_idx on public.auth_sessions (expires_at);

alter table public.auth_sessions enable row level security;
revoke all on public.auth_sessions from anon, authenticated;

-- 16-3) 도우미 함수 -----------------------------------------------
create or replace function public._urikkiri_username(p text)
returns text language sql immutable as $$
  select lower(btrim(coalesce(p, '')));
$$;

-- 비밀번호(또는 세션 토큰) 확인 — 기존 secret 과 새 session_token 을 모두 받아들입니다.
create or replace function public._urikkiri_ok(p_user text, p_secret text)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.friend_profiles
    where user_id = p_user and secret = p_secret
  ) or exists (
    select 1 from public.auth_sessions
    where token = p_secret and user_id = p_user and expires_at > now()
  );
$$;

create or replace function public._urikkiri_profile_json(p public.friend_profiles)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'user_id', p.user_id,
    'friend_code', p.friend_code,
    'nickname', p.nickname,
    'emoji', p.emoji,
    'status_text', p.status_text,
    'color', p.color,
    'username', p.username,
    'created_at', p.created_at
  );
$$;

create or replace function public._urikkiri_new_token()
returns text language sql as $$
  select replace(gen_random_uuid()::text, '-', '') || encode(extensions.gen_random_bytes(16), 'hex');
$$;

-- 16-4) 친구 프로필 부트스트랩: session_token 도 인정 ----------------
create or replace function public.friend_bootstrap(p_user text, p_secret text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prof public.friend_profiles;
  nick text := left(btrim(coalesce(p_nickname, '')), 12);
begin
  if p_user is null or char_length(p_user) < 8 or p_secret is null or char_length(p_secret) < 16 then
    raise exception 'invalid_credentials';
  end if;

  select * into prof from public.friend_profiles where user_id = p_user;

  if prof.user_id is not null then
    if not public._urikkiri_ok(p_user, p_secret) then
      raise exception 'unauthorized';
    end if;
    if nick <> '' and nick <> prof.nickname then
      update public.friend_profiles
         set nickname = nick, updated_at = now()
       where user_id = p_user
       returning * into prof;
    end if;
    return public._urikkiri_profile_json(prof);
  end if;

  -- 세션 토큰으로는 새 프로필을 만들지 않습니다.
  if exists (select 1 from public.auth_sessions where token = p_secret) then
    raise exception 'unauthorized';
  end if;

  if nick = '' then nick := '친구'; end if;

  insert into public.friend_profiles (user_id, secret, nickname, friend_code, color)
  values (p_user, p_secret, nick, public._urikkiri_code(nick), public._urikkiri_color(p_user))
  returning * into prof;

  return public._urikkiri_profile_json(prof);
end $$;

-- 16-5) 회원가입 (아이디 + 비밀번호) --------------------------------
--  p_link_user / p_link_secret 을 주면 그 프로필에 아이디를 붙입니다(기존 친구·채팅 보존).
--  주지 않으면 새 프로필을 만듭니다.
create or replace function public.auth_register(
  p_username text, p_password text, p_nickname text,
  p_link_user text default null, p_link_secret text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uname text := public._urikkiri_username(p_username);
  pw    text := coalesce(p_password, '');
  nick  text := left(btrim(coalesce(p_nickname, '')), 12);
  prof  public.friend_profiles;
  uid   text := gen_random_uuid()::text;
  tok   text;
  linked boolean := false;
begin
  if uname !~ '^[a-z][a-z0-9_]{3,19}$' then
    raise exception 'invalid_username';
  end if;
  if octet_length(pw) < 6 or octet_length(pw) > 72 then
    raise exception 'invalid_password';
  end if;
  if exists (select 1 from public.friend_profiles where lower(username) = uname) then
    raise exception 'username_taken';
  end if;

  if coalesce(p_link_user, '') <> '' and coalesce(p_link_secret, '') <> ''
     and public._urikkiri_ok(p_link_user, p_link_secret) then
    select * into prof from public.friend_profiles where user_id = p_link_user for update;
    if prof.user_id is not null then
      if prof.username is not null then
        raise exception 'already_has_username';
      end if;
      update public.friend_profiles
         set username      = uname,
             password_hash = extensions.crypt(pw, extensions.gen_salt('bf', 10)),
             username_at   = now(),
             nickname      = case when nick <> '' then nick else nickname end,
             updated_at    = now()
       where user_id = p_link_user
       returning * into prof;
      linked := true;
    end if;
  end if;

  if not linked then
    if nick = '' then nick := '새 친구'; end if;
    insert into public.friend_profiles
      (user_id, secret, nickname, friend_code, color, username, password_hash, username_at)
    values
      (uid, encode(extensions.gen_random_bytes(24), 'hex'), nick,
       public._urikkiri_code(nick), public._urikkiri_color(uid),
       uname, extensions.crypt(pw, extensions.gen_salt('bf', 10)), now())
    returning * into prof;
  end if;

  tok := public._urikkiri_new_token();
  insert into public.auth_sessions (token, user_id) values (tok, prof.user_id);

  return jsonb_build_object(
    'profile', public._urikkiri_profile_json(prof),
    'session_token', tok,
    'linked', linked
  );
end $$;

-- 기존 프로필에 아이디를 붙이는 전용 함수(회원가입과 같은 동작)
create or replace function public.auth_link_existing(
  p_username text, p_password text, p_user text, p_secret text
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public._urikkiri_ok(p_user, p_secret) then
    raise exception 'unauthorized';
  end if;
  return public.auth_register(p_username, p_password, null, p_user, p_secret);
end $$;

-- 16-6) 로그인 ----------------------------------------------------
create or replace function public.auth_login(p_username text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uname text := public._urikkiri_username(p_username);
  prof  public.friend_profiles;
  tok   text;
begin
  if uname = '' then
    perform pg_sleep(0.35);
    raise exception 'invalid_login';
  end if;

  select * into prof from public.friend_profiles where lower(username) = uname;
  if prof.user_id is null then
    perform pg_sleep(0.35);
    raise exception 'invalid_login';
  end if;
  if prof.password_hash is null then
    raise exception 'no_password';
  end if;
  if extensions.crypt(coalesce(p_password, ''), prof.password_hash) <> prof.password_hash then
    perform pg_sleep(0.35);
    raise exception 'invalid_login';
  end if;

  delete from public.auth_sessions where user_id = prof.user_id and expires_at <= now();

  tok := public._urikkiri_new_token();
  insert into public.auth_sessions (token, user_id) values (tok, prof.user_id);

  return jsonb_build_object(
    'profile', public._urikkiri_profile_json(prof),
    'session_token', tok
  );
end $$;

-- 로그아웃: 지금 쓰는 세션 토큰만 폐기
create or replace function public.auth_logout(p_user text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public._urikkiri_ok(p_user, p_secret) then
    raise exception 'unauthorized';
  end if;
  delete from public.auth_sessions where user_id = p_user and token = p_secret;
  get diagnostics n = row_count;
  return jsonb_build_object('revoked', n);
end $$;

-- 아이디를 쓸 수 있는지 미리 확인(화면 안내용)
create or replace function public.auth_username_state(p_username text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'username', public._urikkiri_username(p_username),
    'valid', public._urikkiri_username(p_username) ~ '^[a-z][a-z0-9_]{3,19}$',
    'available', not exists (
      select 1 from public.friend_profiles
      where lower(username) = public._urikkiri_username(p_username)
    )
  );
$$;

-- 16-7) 권한 -----------------------------------------------------
grant execute on function public.auth_register(text, text, text, text, text) to anon, authenticated;
grant execute on function public.auth_link_existing(text, text, text, text)  to anon, authenticated;
grant execute on function public.auth_login(text, text)                      to anon, authenticated;
grant execute on function public.auth_logout(text, text)                     to anon, authenticated;
grant execute on function public.auth_username_state(text)                   to anon, authenticated;
