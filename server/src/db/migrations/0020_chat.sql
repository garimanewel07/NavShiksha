-- Staff chat, end-to-end encrypted: one person to another, groups, school staff groups,
-- principals across the Navy schools, and NES or Command announcement channels.
--
-- The server never sees a message, an image or a document. Each person has a key pair made on
-- their device; the private key is stored here only encrypted with a key derived from their chat
-- PIN, so a new phone or laptop can restore it. Each conversation has a key for each "epoch"; it is
-- wrapped separately for every member with that member's public key. Whenever someone joins or
-- leaves, the next message starts a new epoch, so a person who left cannot read what follows and
-- a person who joins cannot read what came before. What the server does see: who is in which
-- conversation, who sent something when, and how large it was.

create table chat_identity (
  user_id            uuid primary key references app_user (id),
  public_key         text not null,                                  -- ECDH P-256, SPKI, base64
  key_backup         text not null,                                  -- PKCS#8 private key, AES-GCM under the PIN key
  backup_salt        text not null,
  backup_iv          text not null,
  backup_iterations  int not null check (backup_iterations >= 200000),
  fingerprint        text not null,                                  -- shown so two people can compare keys
  key_version        int not null default 1,                         -- goes up when a forgotten PIN is reset
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger chat_identity_audit after insert or update on chat_identity for each row execute function audit_row();

create table chat_conversation (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('DIRECT', 'GROUP', 'CHANNEL')),
  title            text check (title is null or length(title) between 1 and 80),
  -- Groups the system keeps up to date: all staff of a school, all principals, everyone in NES,
  -- or a Command's schools. Their members follow the staff lists; nobody adds or removes by hand.
  auto             text check (auto in ('SCHOOL_STAFF', 'PRINCIPALS', 'NES_ALL', 'COMMAND')),
  unit_id          uuid references org_unit (id),
  direct_pair      text unique,                                     -- "smaller-id:larger-id" for one-to-one chats
  created_by       uuid references app_user (id),
  created_at       timestamptz not null default now(),
  epoch            int not null default 0,                          -- the key in use (0: none yet)
  needs_epoch      int not null default 1,                          -- the key the next message must use
  last_message_at  timestamptz,
  check ((kind = 'DIRECT') = (direct_pair is not null)),
  check (kind = 'DIRECT' or title is not null),
  check (auto is null or unit_id is not null),
  check (needs_epoch >= epoch and needs_epoch >= 1)
);
create unique index chat_conversation_auto on chat_conversation (auto, unit_id) where auto is not null;

create table chat_member (
  conversation_id  uuid not null references chat_conversation (id),
  user_id          uuid not null references app_user (id),
  role             text not null default 'MEMBER' check (role in ('ADMIN', 'MEMBER')),
  can_post         boolean not null default true,
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  primary key (conversation_id, user_id),
  check (left_at is null or left_at >= joined_at)
);
create index chat_member_user on chat_member (user_id) where left_at is null;

-- A conversation key, wrapped for one member. wrapped_by names whose public key opens it.
create table chat_key (
  conversation_id        uuid not null references chat_conversation (id),
  epoch                  int not null check (epoch >= 1),
  user_id                uuid not null references app_user (id),
  wrapped_key            text not null,
  iv                     text not null,
  wrapped_by             uuid not null references app_user (id),
  wrapper_public_key     text not null,                            -- copied from the wrapper's identity when stored
  recipient_key_version  int not null,
  created_at             timestamptz not null default now(),
  primary key (conversation_id, epoch, user_id, recipient_key_version)
);

create table chat_attachment (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references chat_conversation (id),
  uploaded_by      uuid not null references app_user (id),
  size_bytes       int not null check (size_bytes between 1 and 26214400),
  data             bytea not null,                                  -- ciphertext only
  created_at       timestamptz not null default now()
);

create table chat_message (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references chat_conversation (id),
  sender_id        uuid references app_user (id),                   -- null for notes the system adds
  kind             text not null check (kind in ('TEXT', 'FILE', 'SYSTEM')),
  epoch            int,
  iv               text,
  ciphertext       text check (length(ciphertext) <= 200000),
  system_text      text,                                            -- "Priya added Rahul": never message content
  attachment_id    uuid references chat_attachment (id),
  reply_to         uuid references chat_message (id),
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check ((kind = 'SYSTEM') = (sender_id is null and system_text is not null)),
  check (kind = 'SYSTEM' or deleted_at is not null or (epoch is not null and iv is not null and ciphertext is not null)),
  check ((kind = 'FILE') = (attachment_id is not null) or deleted_at is not null)
);
create index chat_message_conversation on chat_message (conversation_id, created_at);

create table chat_read (
  conversation_id  uuid not null references chat_conversation (id),
  user_id          uuid not null references app_user (id),
  read_at          timestamptz not null,
  primary key (conversation_id, user_id)
);

-- A sent message is never edited; the sender may delete it for everyone (its content is erased).
create function chat_message_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'messages are deleted by erasing them, not removing the row' using errcode = 'check_violation'; end if;
  if old.deleted_at is not null then raise exception 'this message was deleted' using errcode = 'check_violation'; end if;
  if new.deleted_at is null then raise exception 'a sent message cannot be edited' using errcode = 'check_violation'; end if;
  if (new.id, new.conversation_id, new.sender_id, new.created_at) is distinct from (old.id, old.conversation_id, old.sender_id, old.created_at) then
    raise exception 'a sent message cannot be edited' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger chat_message_guard before update or delete on chat_message for each row execute function chat_message_guard();
