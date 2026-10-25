# Mitra AI Tutor — Zero-Trust Firestore Security Specification

## 1. Data Invariants

1. **Master User Ownership Gate**: Every document across `/users/{userId}` and all subcollections (`conversations`, `messages`, `topicProgress`, `quizAttempts`, `errorLog`, `notes`) belongs exclusively to `userId == request.auth.uid`, and its `ownerId` field must equal `request.auth.uid`.
2. **Verified Email Requirement**: Every write (`create`, `update`, `delete`) requires `request.auth != null && request.auth.token.email_verified == true`.
3. **PII Zero-Exposure**: No PII (`email`, `phone`, `address`) is stored in `/users/{userId}` or any subcollection, and reads are strictly gated to `request.auth.uid == userId`.
4. **Parent Existence Invariant (Master Gate)**:
   - Creating or accessing a subcollection item under `/users/{userId}/...` requires `exists(/databases/$(database)/documents/users/$(userId))` and `get(/databases/$(database)/documents/users/$(userId)).data.ownerId == request.auth.uid`.
   - Creating or reading `/users/{userId}/conversations/{conversationId}/messages/{messageId}` additionally requires `exists(/databases/$(database)/documents/users/$(userId)/conversations/$(conversationId))` and `incoming().conversationId == conversationId`.
5. **Terminal State Locking**: `QuizAttempt` documents are created in terminal state `status == 'completed'` and forbid any `update` operations. `ChatMessage` documents only permit updating `content` when editing a user message (owner-gated, immutable `createdAt`, `role == 'user'`).
6. **Temporal Integrity**: All `createdAt` fields must match `request.time` on `create` and remain immutable on `update`. All `updatedAt` fields must match `request.time` on `create` and `update`.
7. **Strict Key & Size Boundaries**: Every write validates `keys().hasAll(...)` and `keys().hasOnly(...)` to block shadow fields, enforces `isValidId()` (`^[a-zA-Z0-9_\-]+$`, max 128 chars) on path variables, and enforces `.size()` limits on every string.
8. **Secure List Queries**: Every `allow list` rule validates `request.auth.uid == userId && resource.data.ownerId == request.auth.uid` without calling `get()` or `exists()`.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts to create `/users/uid1`. -> `PERMISSION_DENIED`
2. **Cross-User Profile Read**: Authenticated user `uid2` attempts `get` on `/users/uid1`. -> `PERMISSION_DENIED`
3. **Identity Spoofing on Create**: User `uid1` creates `/users/uid1/conversations/conv1` with `ownerId: "uid2"`. -> `PERMISSION_DENIED`
4. **Shadow Field Injection**: User `uid1` updates `/users/uid1` with extra key `isAdmin: true`. -> `PERMISSION_DENIED`
5. **Path ID Poisoning**: User `uid1` creates `/users/uid1/notes/bad$id!@#` failing `^[a-zA-Z0-9_\-]+$`. -> `PERMISSION_DENIED`
6. **Orphaned Message Write**: User `uid1` creates `/users/uid1/conversations/nonexistent/messages/msg1` when parent conversation does not exist. -> `PERMISSION_DENIED`
7. **Forged Client Timestamp**: User `uid1` creates `/users/uid1/notes/note1` with hardcoded past `createdAt` instead of `request.time`. -> `PERMISSION_DENIED`
8. **Immutable Field Mutation**: User `uid1` updates `/users/uid1/conversations/conv1` changing `createdAt` or `ownerId`. -> `PERMISSION_DENIED`
9. **Terminal Quiz Score Tampering**: User `uid1` attempts `update` on completed `/users/uid1/quizAttempts/att1` to inflate `score` from `4` to `10`. -> `PERMISSION_DENIED`
10. **Value Poisoning on Update**: User `uid1` updates whitelisted `title` on `/users/uid1/conversations/conv1` with a 10,000-character string or integer `999`. -> `PERMISSION_DENIED`
11. **Invalid Topic Status Enum**: User `uid1` creates `/users/uid1/topicProgress/ratio_prop` with `status: "hacked_mastery"`. -> `PERMISSION_DENIED`
12. **Unauthorized Cross-User List Scrape**: User `uid2` executes `list` query on `/users/uid1/conversations`. -> `PERMISSION_DENIED`
