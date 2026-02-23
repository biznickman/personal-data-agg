create table if not exists public.slack_messages (
  slack_message_id text primary key,
  channel_id text not null,
  channel_name text,
  message_ts text not null,
  message_ts_numeric double precision not null,
  message_time timestamptz not null,
  thread_ts text,
  user_id text,
  bot_id text,
  message_type text,
  subtype text,
  is_thread_parent boolean not null default false,
  reply_count integer not null default 0,
  latest_reply_ts text,
  message_text text,
  raw jsonb not null,
  ingested_at timestamptz not null default now()
);

create unique index if not exists slack_messages_channel_ts_unique
  on public.slack_messages (channel_id, message_ts);

create index if not exists slack_messages_message_time_idx
  on public.slack_messages (message_time desc);

create index if not exists slack_messages_thread_idx
  on public.slack_messages (channel_id, thread_ts);

create index if not exists slack_messages_user_time_idx
  on public.slack_messages (user_id, message_time desc);
