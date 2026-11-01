-- Foundation: extensions, actor context, tamper-evident audit log, immutability helpers, outbox.

create extension if not exists btree_gist;
create extension if not exists ltree;

-- Who is making the change. Set per transaction by the application (db.tx(..., { actor })).
create function app_actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('app.actor', true), ''), 'system')
$$;

-- Every change to a protected table is recorded with before/after values.
-- Each entry carries the hash of the previous one, so any later tampering breaks the chain.
create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  entity     text not null,
  entity_id  text not null,
  action     text not null check (action in ('insert', 'update', 'delete')),
  before     jsonb,
  after      jsonb,
  prev_hash  text,
  hash       text not null
);

create function audit_row() returns trigger language plpgsql as $$
declare
  v_prev text; v_before jsonb; v_after jsonb; v_id text;
begin
  perform pg_advisory_xact_lock(424242);
  select hash into v_prev from audit_log order by id desc limit 1;
  if tg_op <> 'INSERT' then v_before := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_after := to_jsonb(new); end if;
  v_id := coalesce(v_after ->> 'id', v_before ->> 'id', '');
  insert into audit_log (actor, entity, entity_id, action, before, after, prev_hash, hash)
  values (app_actor(), tg_table_name, v_id, lower(tg_op), v_before, v_after, v_prev,
          encode(sha256(convert_to(coalesce(v_prev, '') || tg_table_name || v_id || lower(tg_op)
                 || coalesce(v_before::text, '') || coalesce(v_after::text, ''), 'UTF8')), 'hex'));
  return coalesce(new, old);
end $$;

-- Rows that are facts (receipts, ledger lines, demands, messages) can never be edited or deleted.
-- Mistakes are corrected with a new, reversing record.
create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% records are permanent; record a correcting entry instead', tg_table_name
    using errcode = 'check_violation';
end $$;

-- Optimistic locking: every mutable row carries a version that increases on each update.
create function bump_version() returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

-- Side effects (SMS, WhatsApp, push, email) are written here in the same transaction as the
-- change that causes them, then delivered by a dispatcher. A rolled-back change sends nothing.
create table outbox (
  id          bigserial primary key,
  topic       text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index outbox_pending on outbox (id) where sent_at is null;
