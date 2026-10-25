import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  getAIProviderStatus,
  verifyLiveModelAccess,
  streamTutorResponse,
  generateTutorActionText,
  transcribeStudentAudio,
  synthesizeTutorSpeech,
} from './server/aiProvider.ts';
import type { LearningContextSummary, ConversationTurnInput } from './server/aiProvider.ts';
import {
  requireAuth,
  issueIsolatedGuestToken,
  isValidResourceId,
} from './server/authMiddleware.ts';
import {
  ForbiddenOwnershipError,
  getStore,
  getPrincipalUploadsDir,
  updateProfile,
  createConversation,
  updateConversationMeta,
  deleteConversation,
  appendMessage,
  truncateConversationFromMessage,
  upsertTopicProgress,
  recordQuizSubmission,
  updateErrorLogItem,
  saveStudyNote,
  deleteStudyNote,
  registerUploadedDocument,
  assertConversationOwnership,
} from './server/storage.ts';
import { registerGitHubRoutes, buildProgressExportMarkdown } from './server/githubOAuth.ts';
import { buildProjectZipBuffer } from './server/zipExporter.ts';
import { CMAT_SYLLABUS_TOPICS } from './src/data/cmatCurriculum.ts';
import type { ChatAttachment } from './src/types/mitra.ts';

const PORT = Number(process.env.PORT) || 3000;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const principalId = req.principal?.principalId || 'guest:default';
      const destDir = getPrincipalUploadsDir(principalId);
      cb(null, destDir);
    },
    filename: (_req, file, cb) => {
      const safeBase = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      cb(null, `${Date.now()}_${safeBase}`);
    },
  }),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
});

function buildLearningContextFromStore(
  principalId: string,
  overrideCtx?: Partial<LearningContextSummary>
): LearningContextSummary {
  const store = getStore(principalId);
  const activeTopic =
    CMAT_SYLLABUS_TOPICS.find((t) => t.id === store.profile.currentTopicId) ||
    CMAT_SYLLABUS_TOPICS[2];

  const completedTopics = store.topicProgress
    .filter((t) => t.status === 'mastered' || t.status === 'quiz_passed')
    .map((t) => {
      const meta = CMAT_SYLLABUS_TOPICS.find((s) => s.id === t.topicId);
      return `${meta?.title || t.topicId} (${t.status})`;
    });

  const pendingAssessments = store.topicProgress
    .filter((t) => t.status === 'viewed' || t.status === 'quiz_attempted')
    .map((t) => {
      const meta = CMAT_SYLLABUS_TOPICS.find((s) => s.id === t.topicId);
      return `${meta?.title || t.topicId} [status: ${t.status}]`;
    });

  const quizSummary = store.quizAttempts
    .slice(0, 8)
    .map((q) => `${q.title}: ${q.score}/${q.total} (${q.accuracyPercent}%)`);

  const unresolvedMistakes = store.errorLog
    .filter((e) => !e.resolved)
    .slice(0, 6)
    .map(
      (e) =>
        `[${e.subject} · ${e.mistakeType}] Q: "${e.questionText.slice(0, 95)}..." -> Student answered: ${e.studentAnswer} | Correct: ${e.correctAnswer}`
    );

  return {
    preferredLanguage: overrideCtx?.preferredLanguage || store.profile.preferredLanguage,
    explanationDepth: overrideCtx?.explanationDepth || store.profile.explanationDepth,
    conversationTone: overrideCtx?.conversationTone || 'friend',
    currentDay: overrideCtx?.currentDay ?? store.profile.currentDay,
    currentSubject: overrideCtx?.currentSubject || store.profile.currentSubject,
    currentTopicTitle: overrideCtx?.currentTopicTitle || activeTopic.title,
    studyMinutesToday: overrideCtx?.studyMinutesToday ?? store.profile.studyMinutesToday,
    completedTopics: overrideCtx?.completedTopics || completedTopics,
    pendingAssessments: overrideCtx?.pendingAssessments || pendingAssessments,
    quizSummary: overrideCtx?.quizSummary || quizSummary,
    unresolvedMistakes: overrideCtx?.unresolvedMistakes || unresolvedMistakes,
  };
}

function handleRouteError(res: Response, err: unknown) {
  if (err instanceof ForbiddenOwnershipError) {
    res.status(403).json({ error: err.message, code: 'FORBIDDEN_OWNERSHIP' });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: msg });
}

export function createMitraApiApp(): Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // 0. Issue or Renew Per-Browser Isolated Guest Session Token
  app.post('/api/auth/guest-session', (req: Request, res: Response) => {
    const existingSessionId =
      typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
    const issued = issueIsolatedGuestToken(existingSessionId);
    res.json(issued);
  });

  // 1. AI Provider Health & Real Live Model Verification Probe
  app.get('/api/ai/status', async (req: Request, res: Response) => {
    try {
      const shouldVerify = req.query.verify === '1' || req.query.verify === 'true';
      const status = shouldVerify
        ? await verifyLiveModelAccess(false)
        : getAIProviderStatus();
      res.json(status);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/ai/verify', async (_req: Request, res: Response) => {
    try {
      const status = await verifyLiveModelAccess(true);
      res.json(status);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // Clean Source Code Archive Download (Strictly excludes runtime user data & .env secrets)
  app.get('/api/workspace/download-zip', (_req: Request, res: Response) => {
    try {
      const zipBuffer = buildProjectZipBuffer(process.cwd());
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="mitra-ai-tutor-source.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.setHeader('Cache-Control', 'no-store');
      res.send(zipBuffer);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 2. Authenticated & Per-User Isolated Workspace Snapshot
  app.get('/api/workspace', requireAuth, (req: Request, res: Response) => {
    try {
      const principalId = req.principal!.principalId;
      const store = getStore(principalId);
      res.json({
        ...store,
        authPrincipal: {
          principalId,
          authMode: req.principal!.authMode,
          uid: req.principal!.uid,
        },
        aiStatus: getAIProviderStatus(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/workspace/export-markdown', requireAuth, (req: Request, res: Response) => {
    try {
      const principalId = req.principal!.principalId;
      const store = getStore(principalId);
      const md = buildProgressExportMarkdown(store);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(md);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 3. Profile & Study Session Updates (Authenticated + Input Validated)
  app.patch('/api/profile', requireAuth, (req: Request, res: Response) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({ error: 'Profile update payload must be a JSON object.' });
        return;
      }
      const updated = updateProfile(req.principal!.principalId, req.body);
      res.json(updated);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 4. Conversations CRUD (Authenticated + Strict Ownership Check)
  app.post('/api/conversations', requireAuth, (req: Request, res: Response) => {
    try {
      const { title, subjectTag } = req.body || {};
      const conv = createConversation(
        req.principal!.principalId,
        typeof title === 'string' ? title : undefined,
        typeof subjectTag === 'string' ? subjectTag : undefined
      );
      res.json(conv);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/conversations/:id/messages', requireAuth, (req: Request, res: Response) => {
    try {
      const convId = String(req.params.id);
      if (!isValidResourceId(convId)) {
        res.status(400).json({ error: 'Invalid conversation ID format.' });
        return;
      }
      assertConversationOwnership(req.principal!.principalId, convId);
      const store = getStore(req.principal!.principalId);
      if (!store.conversations.some((c) => c.id === convId)) {
        res.status(404).json({ error: 'Conversation not found in your workspace.' });
        return;
      }
      res.json(store.messagesByConversation[convId] || []);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.patch('/api/conversations/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const convId = String(req.params.id);
      if (!isValidResourceId(convId)) {
        res.status(400).json({ error: 'Invalid conversation ID format.' });
        return;
      }
      const updated = updateConversationMeta(req.principal!.principalId, convId, req.body || {});
      if (!updated) {
        res.status(404).json({ error: 'Conversation not found in your workspace.' });
        return;
      }
      res.json(updated);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.delete('/api/conversations/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const convId = String(req.params.id);
      if (!isValidResourceId(convId)) {
        res.status(400).json({ error: 'Invalid conversation ID format.' });
        return;
      }
      const ok = deleteConversation(req.principal!.principalId, convId);
      if (!ok) {
        res.status(404).json({ error: 'Conversation not found in your workspace.' });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 5. Document Upload for Source-Aware Tutoring (Per-Principal Isolated Upload Dir)
  app.post(
    '/api/documents/upload',
    requireAuth,
    upload.single('file'),
    (req: Request, res: Response) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded.' });
          return;
        }
        const attachment: ChatAttachment = {
          id: `att_doc_${Date.now()}`,
          name: req.file.originalname,
          mimeType: req.file.mimetype || 'application/octet-stream',
          sizeBytes: req.file.size,
          uploadedFileId: req.file.filename,
        };
        registerUploadedDocument(req.principal!.principalId, attachment);
        res.json(attachment);
      } catch (err) {
        handleRouteError(res, err);
      }
    }
  );

  // 6. Streaming Conversational AI Endpoint (SSE, Authenticated & Per-User Scoped)
  app.post('/api/chat/stream', requireAuth, async (req: Request, res: Response) => {
    const principalId = req.principal!.principalId;
    const {
      conversationId,
      message,
      attachments,
      editMessageId,
      regenerateOnly,
      modelTier,
      historyOverride,
      learningContextOverride,
    } = req.body as {
      conversationId?: string;
      message?: string;
      attachments?: ChatAttachment[];
      editMessageId?: string;
      regenerateOnly?: boolean;
      modelTier?: 'fast' | 'thinking';
      historyOverride?: ConversationTurnInput[];
      learningContextOverride?: Partial<LearningContextSummary>;
    };

    // Ownership pre-check BEFORE opening 200 SSE stream so cross-user access gets a real 403!
    if (conversationId) {
      if (!isValidResourceId(conversationId)) {
        res.status(400).json({ error: 'Invalid conversationId.' });
        return;
      }
      try {
        assertConversationOwnership(principalId, conversationId);
      } catch (err) {
        handleRouteError(res, err);
        return;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const abortController = new AbortController();
    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 10000);

    res.on('close', () => {
      clearInterval(keepAliveTimer);
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const sendEvent = (event: string, payload: unknown) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      const store = getStore(principalId);
      let activeConvId = conversationId;
      if (!activeConvId) {
        const created = createConversation(principalId);
        activeConvId = created.id;
      }

      if (editMessageId && isValidResourceId(editMessageId)) {
        truncateConversationFromMessage(principalId, activeConvId, editMessageId);
      } else if (regenerateOnly) {
        const currentMsgs = store.messagesByConversation[activeConvId] || [];
        const lastMsg = currentMsgs[currentMsgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          truncateConversationFromMessage(principalId, activeConvId, lastMsg.id);
        }
      }

      // Persist user message BEFORE calling AI so history is never lost if live AI fails
      let savedUserMsg = null;
      if (!regenerateOnly && typeof message === 'string' && message.trim().length > 0) {
        savedUserMsg = appendMessage(principalId, activeConvId, {
          role: 'user',
          content: message.trim().slice(0, 32000),
          sourceMode: 'user',
          modelUsed: 'user',
          attachmentName:
            attachments && attachments.length > 0
              ? attachments.map((a) => a.name).join(', ')
              : 'none',
          attachments,
        });
      }

      const historyForModel: ConversationTurnInput[] =
        Array.isArray(historyOverride) && historyOverride.length > 0
          ? historyOverride
              .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
              .map((m) => ({
                role: m.role,
                content: String(m.content || '').slice(0, 32000),
                attachments: m.attachments,
              }))
          : (getStore(principalId).messagesByConversation[activeConvId] || []).map((m) => ({
              role: m.role,
              content: m.content,
              attachments: m.attachments,
            }));

      if (historyForModel.length === 0) {
        sendEvent('error', { message: 'Cannot stream response for an empty message.' });
        res.end();
        return;
      }

      sendEvent('meta', {
        conversationId: activeConvId,
        userMessage: savedUserMsg,
      });

      const learningCtx = buildLearningContextFromStore(principalId, learningContextOverride);
      const principalUploadsDir = getPrincipalUploadsDir(principalId);

      const streamResult = await streamTutorResponse({
        history: historyForModel,
        learningContext: learningCtx,
        uploadsDir: principalUploadsDir,
        modelTier,
        signal: abortController.signal,
        onChunk: (deltaText, modelUsed) => {
          sendEvent('chunk', { delta: deltaText, modelUsed });
        },
      });

      const finalContent =
        streamResult.fullText.trim() ||
        '*(Generation stopped before completion.)*';

      const savedAssistantMsg = appendMessage(principalId, activeConvId, {
        role: 'assistant',
        content: finalContent,
        sourceMode: streamResult.sourceMode,
        modelUsed: streamResult.modelUsed,
        attachmentName: 'none',
        errorReason: streamResult.errorReason,
        errorCategory: streamResult.errorCategory,
      });

      const existingConv = getStore(principalId).conversations.find((c) => c.id === activeConvId);
      if (
        existingConv &&
        (existingConv.title === 'New Tutoring Session' ||
          existingConv.title === 'New Chat' ||
          existingConv.title === 'Study Session') &&
        typeof message === 'string' &&
        message.trim().length > 0
      ) {
        const cleanTitle = message.trim().replace(/\s+/g, ' ').slice(0, 48);
        updateConversationMeta(principalId, activeConvId, {
          title: cleanTitle.length < message.trim().length ? `${cleanTitle}…` : cleanTitle,
        });
      }

      const updatedConv = getStore(principalId).conversations.find((c) => c.id === activeConvId);
      sendEvent('done', {
        conversation: updatedConv,
        assistantMessage: savedAssistantMsg,
        aiStatus: getAIProviderStatus(),
      });
      res.end();
    } catch (err) {
      if (abortController.signal.aborted || (err instanceof Error && err.message === 'ABORTED_BY_USER')) {
        res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      sendEvent('error', { message: msg });
      res.end();
    } finally {
      clearInterval(keepAliveTimer);
    }
  });

  // 7. One-Shot AI Teaching Tool Endpoint
  app.post('/api/ai/tool', requireAuth, async (req: Request, res: Response) => {
    try {
      const principalId = req.principal!.principalId;
      const { prompt, attachments, learningContextOverride } = req.body as {
        prompt?: string;
        attachments?: ChatAttachment[];
        learningContextOverride?: Partial<LearningContextSummary>;
      };
      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Prompt is required.' });
        return;
      }
      const learningCtx = buildLearningContextFromStore(principalId, learningContextOverride);
      const out = await generateTutorActionText({
        prompt: prompt.trim().slice(0, 16000),
        attachments,
        learningContext: learningCtx,
        uploadsDir: getPrincipalUploadsDir(principalId),
      });
      res.json(out);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 7b. Interactive Voice Input Transcription & Spoken Tutor TTS Endpoints
  app.post('/api/ai/transcribe', requireAuth, async (req: Request, res: Response) => {
    try {
      const { audioBase64, mimeType } = req.body as {
        audioBase64?: string;
        mimeType?: string;
      };
      if (!audioBase64) {
        res.status(400).json({ error: 'Audio data is required.' });
        return;
      }
      const out = await transcribeStudentAudio({
        audioBase64,
        mimeType: mimeType || 'audio/webm',
      });
      res.json(out);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/ai/tts', requireAuth, async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Text is required for speech synthesis.' });
        return;
      }
      const out = await synthesizeTutorSpeech({ text });
      res.json(out);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 8. Structured Learning Progress, Quiz Submission, Error Log & Notes Endpoints
  app.post('/api/learning/topic', requireAuth, (req: Request, res: Response) => {
    try {
      if (!req.body?.topicId || !isValidResourceId(req.body.topicId)) {
        res.status(400).json({ error: 'Valid topicId is required.' });
        return;
      }
      const updated = upsertTopicProgress(req.principal!.principalId, req.body);
      res.json(updated);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/learning/quiz-submit', requireAuth, (req: Request, res: Response) => {
    try {
      const principalId = req.principal!.principalId;
      if (!req.body?.attempt || typeof req.body.attempt.quizId !== 'string') {
        res.status(400).json({ error: 'Valid quiz attempt payload is required.' });
        return;
      }
      const result = recordQuizSubmission(principalId, {
        attempt: req.body.attempt,
        newErrors: Array.isArray(req.body.newErrors) ? req.body.newErrors : [],
        timeSpentMinutes: Number(req.body.timeSpentMinutes) || 1,
      });
      res.json({
        ...result,
        profile: getStore(principalId).profile,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.patch('/api/learning/error-log/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const errId = String(req.params.id);
      if (!isValidResourceId(errId)) {
        res.status(400).json({ error: 'Invalid error log ID.' });
        return;
      }
      const updated = updateErrorLogItem(req.principal!.principalId, errId, req.body || {});
      if (!updated) {
        res.status(404).json({ error: 'Error log entry not found in your workspace.' });
        return;
      }
      res.json(updated);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/learning/notes', requireAuth, (req: Request, res: Response) => {
    try {
      if (!req.body?.title || typeof req.body.content !== 'string') {
        res.status(400).json({ error: 'Note title and content are required.' });
        return;
      }
      const saved = saveStudyNote(req.principal!.principalId, req.body);
      res.json(saved);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.delete('/api/learning/notes/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const noteId = String(req.params.id);
      if (!isValidResourceId(noteId)) {
        res.status(400).json({ error: 'Invalid note ID.' });
        return;
      }
      const ok = deleteStudyNote(req.principal!.principalId, noteId);
      if (!ok) {
        res.status(404).json({ error: 'Study note not found in your workspace.' });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // 9. GitHub OAuth & Export Routes
  registerGitHubRoutes(app);

  return app;
}

async function startServer() {
  const app = createMitraApiApp();

  const distPath = path.resolve(process.cwd(), 'dist');
  const isProd =
    process.env.NODE_ENV === 'production' && fs.existsSync(path.join(distPath, 'index.html'));

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    const status = getAIProviderStatus();
    console.log(
      `Mitra AI Tutor server listening on http://0.0.0.0:${PORT} | AI: ${status.provider} (${status.activeModel}) | Live=${status.liveAvailable}`
    );
  });
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryArgPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFilePath === entryArgPath) {
  startServer().catch((err) => {
    console.error('Fatal server startup error:', err);
    process.exit(1);
  });
}
