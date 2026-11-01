# Staff chat

Staff talk to each other inside NavShiksha, so no other messaging app is needed for school work: one-to-one, groups they make, their school's staff group, the principals of all the Navy schools, and announcement channels from NES and from each Command. Text, photos and documents are **end-to-end encrypted**. Parents are not part of chat; they use Messages.

## Conversations

| Kind | Who is in it | Who can post |
|---|---|---|
| One-to-one | Any two members of staff, in any school, NES or a Command | Both |
| Group | Made by any member of staff; up to 500 people; admins add and remove people, rename it, make others admins | Everyone in it |
| All staff · *school* | Every active member of staff of that school (kept automatically) | Everyone; the principal is admin |
| Principals of the Navy schools | Every principal, NES and Command officers (kept automatically) | Everyone |
| NES announcements | All staff everywhere (kept automatically) | NES officers only |
| *Command* · announcements | Staff of that Command's schools and its officers (kept automatically) | Command officers and NES |

The automatic groups follow the staff lists: a teacher posted in joins their new school's group and leaves the old one, without anyone doing anything.

Files: photos (JPG, PNG, WEBP, GIF) show in the chat; documents (PDF, Word, Excel, PowerPoint, text, CSV, ODF) open or save on a tap. Up to 25 MB each. A sender can delete a message for everyone; its content and file are erased.

## How the encryption works

All of it runs in the browser with the built-in WebCrypto (`web/src/lib/chatCrypto.ts`); nothing is added to the server to make it work.

1. **Each person has a key pair** (ECDH P-256), made on their device the first time they open Chat.
2. **The chat PIN protects the private key.** It is sent to the server only sealed with AES-256-GCM under a key derived from the PIN (PBKDF2-SHA-256, 310,000 rounds). On a new phone or computer the person types the PIN once; the device then keeps the key in its own storage in a form scripts can use but not read out. "Lock on this device" removes it.
3. **Each conversation has a key** (AES-256-GCM). It is wrapped separately for every member: ECDH between the wrapper's private key and the member's public key, then HKDF bound to the conversation, the key's number and the member, then AES-GCM.
4. **The key changes whenever someone joins or leaves.** The server refuses a message under an old key, so whoever sends next makes a new one and wraps it for the current members. Someone who left cannot read what follows; someone who joins cannot read what came before.
5. **Messages are sealed with the conversation key**, bound to the conversation, the key number and the sender, so a message cannot be moved to another chat or passed off as someone else's.
6. **Files are sealed with their own one-time key**, which travels inside the (sealed) message. The server stores only the sealed file.
7. **Someone who has not set up chat yet** is still a member. When they set up, the next device of any member that is open shares the current key with them.

What the server knows: who is in which conversation, who sent something and when, and how large it was. What it never knows: what was said, what a photo shows, what a document contains, or anyone's PIN.

## Checking you are talking to the right person

Each person has a **security code** (Chat → Info). Two people compare their codes in person or on a call; if they match, nobody is in between. When someone's code changes (a reset PIN), everyone in their chats sees a note.

## Forgotten PIN

"Forgot the PIN?" makes a new key with a new PIN. **Earlier messages to that person cannot be read again**, by design: nobody, including NES, holds a copy that could open them. New messages reach them as usual.

## Rules the server enforces

- Only active staff (not parents) can use chat; a person reads only conversations they are in, and only from the time they joined.
- A message must use the conversation's current key; a new key must be shared with every member who has set up chat.
- A file goes with exactly one message, in the conversation it was uploaded to, and only members can fetch it.
- Messages are never edited; deletion erases the content. Channels accept posts only from the people who run them.

These are tested in `server/test/chat.test.ts`, which runs real devices' encryption (key pairs, PIN backup, wrapping, sealing, files) against the server.

## For production

- **Push notifications** for new messages go through the outbox (planned with SMS/push, R7); until then the menu shows unread counts and the app checks every few seconds.
- **Records:** because chat is end-to-end encrypted, NES cannot produce message content for an inquiry. Formal orders and circulars belong in Notices (which are kept and can be produced); chat is for coordination.
