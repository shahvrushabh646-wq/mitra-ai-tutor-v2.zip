# Mitra AI Tutor — Conversational Personal Tutor & CMAT 2026 Platform

Mitra is a full-stack conversational AI personal tutor and structured **CMAT 2026** learning system built with **React 19**, **Tailwind CSS 4**, **Express**, **Google Gemini (`@google/genai`)**, and **Firebase (Firestore + Google Auth)**.

## 1. Architecture & AI Provider Fix

- **Root Cause Addressed:** Legacy/unsupported model identifiers cause provider `404 NOT_FOUND` failures that force the application into offline fallback mode.
- **Provider Adapter (`server/aiProvider.ts`):**
  - Uses the official `@google/genai` SDK strictly on the server (`POST /api/chat/stream` via Server-Sent Events and `POST /api/ai/tool`).
  - Defaults to `gemini-3.8-flash` and automatically normalizes deprecated model names (such as `gemini-1.5-flash` or `gemini-2.0-flash`) to supported Gemini 3/4 models (`gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.1-flash-lite`).
  - Supports multimodal PDF and image grounding, including one-click attachment of the bundled **NTA CMAT Jan 2025 Slot 1 & Slot 2** official papers (`/public/assets/aistudio/`).
  - Keeps **Offline Tutor Fallback** clearly labelled whenever `GEMINI_API_KEY` is absent or the upstream network is unreachable — never masquerading offline content as live model output.

## 2. Environment Variables & Setup

Configure secrets in AI Studio (**Settings > Secrets**) or `.env` for local development (never in client code):

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes (for Live AI) | Server-side Gemini API key injected by AI Studio |
| `GEMINI_MODEL` | Optional | Model override (default: `gemini-3.8-flash`) |
| `APP_URL` | Auto-injected | Hosted Cloud Run URL used for OAuth callbacks |
| `GITHUB_CLIENT_ID` | Optional | GitHub OAuth App Client ID for Gist Vault sync |
| `GITHUB_CLIENT_SECRET` | Optional | GitHub OAuth App Client Secret for Gist Vault sync |

### Optional GitHub OAuth Configuration
To connect GitHub for one-click Gist export of study progress, notes, and error logs:
1. Create an OAuth App at `https://github.com/settings/developers`.
2. Add the exact callback URLs:
   - Development: `https://ais-dev-pxlxkw6vdfysz4u2v6kkrj-963375776424.asia-east1.run.app/auth/github/callback`
   - Shared/Deployed: `https://ais-pre-pxlxkw6vdfysz4u2v6kkrj-963375776424.asia-east1.run.app/auth/github/callback`
3. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in AI Studio Secrets.

## 3. Persistence & Security

- **Dual-Layer Persistence:**
  - **Firebase Firestore (`firebase-applet-config.json` + `firestore.rules`):** User-scoped real-time persistence across devices when signed in with Google (`users/{userId}` with subcollections `conversations`, `messages`, `topicProgress`, `quizAttempts`, `errorLog`, and `notes`).
  - **Server Store (`data/mitra-store.json`):** Server-side persistence seeded with the student's preserved **Day 1 CMAT session** so progress survives page refreshes and restarts even prior to cloud sign-in.
- **Security Note:** `firestore.rules` enforces verified ownership, schema key allowlists, size bounds, and immutable completed quiz attempts. Review and audit rules in your Firebase Console before sharing broadly.

## 4. Verification & Commands

```bash
npm run lint     # TypeScript type-check (tsc --noEmit)
npm test         # Firestore Dirty-Dozen rule audit + Mitra domain/provider unit tests
npm run build    # Production Vite frontend bundle
npm run dev      # Full-stack Express + Vite server on port 3000
```

## 5. Known Limitations

- Cloud cross-device user isolation uses Google Sign-In (`signInWithPopup`); unauthenticated preview sessions persist to the container's server store (`data/mitra-store.json`).
- Uploaded PDF/image attachments are capped at 18 MB per file for fast multimodal streaming.
