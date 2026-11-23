-- Этап 6 «Пуши». Подписки iPhone, журнал отправленных пушей, ключи в Vault, расписание раз в 15 минут.
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subs(user_id);
alter table public.push_subs enable row level security;
-- подписку видит и меняет только сам человек (из списка семьи); остальным её не видно
create policy push_subs_own_select on public.push_subs for select to authenticated using (user_id = auth.uid() and public.is_member());
create policy push_subs_own_insert on public.push_subs for insert to authenticated with check (user_id = auth.uid() and public.is_member());
create policy push_subs_own_update on public.push_subs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member());
create policy push_subs_own_delete on public.push_subs for delete to authenticated using (user_id = auth.uid());

create table if not exists public.push_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  ref text,
  local_day text not null,
  sent_at timestamptz not null default now()
);
create index if not exists push_log_user_time on public.push_log(user_id, sent_at desc);
alter table public.push_log enable row level security;  -- без политик: только сервер (сервисный ключ)

-- ключи для функции push: читает только сервисная роль
create or replace function public.push_config() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'pub',  (select decrypted_secret from vault.decrypted_secrets where name = 'zal_vapid_public'),
    'priv', (select decrypted_secret from vault.decrypted_secrets where name = 'zal_vapid_private'),
    'cron', (select decrypted_secret from vault.decrypted_secrets where name = 'zal_cron_secret'));
$$;
revoke all on function public.push_config() from public, anon, authenticated;
grant execute on function public.push_config() to service_role;

create extension if not exists pg_net;
create extension if not exists pg_cron;
