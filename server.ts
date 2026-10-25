import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  getAIProviderStatus,
  streamTutorResponse,
  generateTutorActionText,
  transcribeStudentAudio,
  synthesizeTutorSpeech,
} from './server/aiProvider.ts';
import type { LearningContextSummary, ConversationTurnInput } from './server/aiProvider.ts';
import {
  getStore,
  UPLOADS_DIR,
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
} from './server/storage.ts';
import { registerGitHubRoutes, buildProgressExportMarkdown } from './server/githubOAuth.ts';
import { buildProjectZipBuffer } from './server/zipExporter.ts';
import { CMAT_SYLLABUS_TOPICS } from './src/data/cmatCurriculum.ts';
import type { ChatAttachment } from './src/types/mitra.ts';

const PORT = Number(process.env.PORT) || 3000;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      }
      cb(null, UPLOADS_DIR);
    },
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 18 * 1024 * 1024, // 18MB max per file
  },
});

function buildLearningContextFromStore(
  overrideCtx?: Partial<LearningContextSummary>
): LearningContextSummary {
  const store = getStore();
  const activeTopic =
    CMAT_SYLLABUS_TOPICS.find((t) => t.id === store.profile.currentTopicId) ||
    CMAT_SYLLABUS_TOPICS[2];

  const completedTopics = store.topicProgress
    .filter((t) => t.status === 'mastered' || t.status === 'quiz_passed')
    .map((t) => {
      const meta = CMAT_SYLLABUS_TOPICS.find((s) => s.id === t.topicId);
      return `${meta?.title || t.topicId} (${t.status}, ${t.bestScore}/${t.totalQuestions})`;
    });

  const pendingAssessments = store.topicProgress
    .filter((t) => t.status === 'viewed' || t.status === 'quiz_attempted')
    .map((t) => {
      const meta = CMAT_SYLLABUS_TOPICS.find((s) => s.id === t.topicId);
      return `${meta?.title || t.topicId} [status: ${t.status}, best: ${t.bestScore}/${t.totalQuestions}]`;
    });

  const quizSummary = store.quizAttempts
    .slice(0, 8)
    .map((q) => `${q.title}: ${q.score}/${q.total} (${q.accuracyPercent}%)`);

  const unresolvedMistakes = store.errorLog
    .filter((e) => !e.resolved)
    .slice(0, 6)
    .map((e) => `${e.subject}: "${e.questionText.slice(0, 90)}" (chose ${e.studentAnswer}, ans: ${e.correctAnswer})`);

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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // 1. AI Provider Health & Diagnostic Endpoint
  app.get('/api/ai/status', (_req: Request, res: Response) => {
    res.json(getAIProviderStatus());
  });

  // 2. Full Workspace State Snapshot
  app.get('/api/workspace', (_req: Request, res: Response) => {
    const store = getStore();
    res.json({
      ...store,
      aiStatus: getAIProviderStatus(),
    });
  });

  app.get('/api/workspace/export-markdown', (_req: Request, res: Response) => {
    const store = getStore();
    const md = buildProgressExportMarkdown(store);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(md);
  });

  app.get('/api/workspace/download-zip', (_req: Request, res: Response) => {
    try {
      const zipBuffer = buildProjectZipBuffer(process.cwd());
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="mitra-ai-tutor-source.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.setHeader('Cache-Control', 'no-store');
      res.send(zipBuffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to build project ZIP archive.';
      res.status(500).json({ error: msg });
    }
  });

  // 3. Profile & Study Session Updates
  app.patch('/api/profile', (req: Request, res: Response) => {
    const updated = updateProfile(req.body || {});
    res.json(updated);
  });

  // 4. Conversations CRUD
  app.post('/api/conversations', (req: Request, res: Response) => {
    const { title, subjectTag } = req.body || {};
    const conv = createConversation(title, subjectTag);
    res.json(conv);
  });

  app.patch('/api/conversations/:id', (req: Request, res: Response) => {
    const updated = updateConversationMeta(String(req.params.id), req.body || {});
    if (!updated) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json(updated);
  });

  app.delete('/api/conversations/:id', (req: Request, res: Response) => {
    const ok = deleteConversation(String(req.params.id));
    res.json({ deleted: ok });
  });

  // 5. Document Upload for Source-Aware Tutoring
  app.post('/api/documents/upload', upload.single('file'), (req: Request, res: Response) => {
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
    registerUploadedDocument(attachment);
    res.json(attachment);
  });

  // 6. Streaming Conversational AI Endpoint (SSE)
  app.post('/api/chat/stream', async (req: Request, res: Response) => {
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
      const store = getStore();
      let activeConvId = conversationId;
      if (!activeConvId || !store.conversations.some((c) => c.id === activeConvId)) {
        const created = createConversation();
        activeConvId = created.id;
      }

      if (editMessageId) {
        truncateConversationFromMessage(activeConvId, editMessageId);
      } else if (regenerateOnly) {
        const currentMsgs = store.messagesByConversation[activeConvId] || [];
        const lastMsg = currentMsgs[currentMsgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          truncateConversationFromMessage(activeConvId, lastMsg.id);
        }
      }

      let savedUserMsg = null;
      if (!regenerateOnly && typeof message === 'string' && message.trim().length > 0) {
        const attNames =
          attachments && attachments.length > 0
            ? attachments.map((a) => a.name).join(', ')
            : 'none';
        savedUserMsg = appendMessage(activeConvId, {
          role: 'user',
          content: message.trim(),
          sourceMode: 'user',
          modelUsed: 'user',
          attachmentName: attNames.slice(0, 200),
          attachments,
        });
      }

      const conversationMessages = getStore().messagesByConversation[activeConvId] || [];
      const historyForModel: ConversationTurnInput[] =
        Array.isArray(historyOverride) && historyOverride.length > 0
          ? historyOverride
          : conversationMessages.map((m) => ({
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

      const learningCtx = buildLearningContextFromStore(learningContextOverride);

      const streamResult = await streamTutorResponse({
        history: historyForModel,
        learningContext: learningCtx,
        uploadsDir: UPLOADS_DIR,
        modelTier,
        signal: abortController.signal,
        onChunk: (deltaText, modelUsed) => {
          sendEvent('chunk', { delta: deltaText, modelUsed });
        },
      });

      const finalContent =
        streamResult.fullText.trim() ||
        '*(Generation stopped before completion.)*';

      const savedAssistantMsg = appendMessage(activeConvId, {
        role: 'assistant',
        content: finalContent,
        sourceMode: streamResult.sourceMode,
        modelUsed: streamResult.modelUsed,
        attachmentName: 'none',
        errorReason: streamResult.errorReason,
      });

      const existingConv = getStore().conversations.find((c) => c.id === activeConvId);
      if (
        existingConv &&
        (existingConv.title === 'New Tutoring Session' || existingConv.title === 'New Chat') &&
        typeof message === 'string' &&
        message.trim().length > 0
      ) {
        const cleanTitle = message.trim().replace(/\s+/g, ' ').slice(0, 48);
        updateConversationMeta(activeConvId, {
          title: cleanTitle.length < message.trim().length ? `${cleanTitle}…` : cleanTitle,
        });
      }

      const updatedConv = getStore().conversations.find((c) => c.id === activeConvId);
      sendEvent('done', {
        conversation: updatedConv,
        assistantMessage: savedAssistantMsg,
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

  // 7. One-Shot AI Teaching Tool Endpoint (Generate Notes, Summarize PDF, Explain Mistake)
  app.post('/api/ai/tool', async (req: Request, res: Response) => {
    try {
      const { prompt, attachments, learningContextOverride } = req.body as {
        prompt?: string;
        attachments?: ChatAttachment[];
        learningContextOverride?: Partial<LearningContextSummary>;
      };
      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Prompt is required.' });
        return;
      }
      const learningCtx = buildLearningContextFromStore(learningContextOverride);
      const out = await generateTutorActionText({
        prompt: prompt.trim(),
        attachments,
        learningContext: learningCtx,
        uploadsDir: UPLOADS_DIR,
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 7b. Interactive Voice Input Transcription & Spoken Tutor TTS Endpoints
  app.post('/api/ai/transcribe', async (req: Request, res: Response) => {
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
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/ai/tts', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: string };
      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Text is required for speech synthesis.' });
        return;
      }
      const out = await synthesizeTutorSpeech({ text });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 8. Structured Learning Progress, Quiz Submission, Error Log & Notes Endpoints
  app.post('/api/learning/topic', (req: Request, res: Response) => {
    const updated = upsertTopicProgress(req.body);
    res.json(updated);
  });

  app.post('/api/learning/quiz-submit', (req: Request, res: Response) => {
    const result = recordQuizSubmission(req.body);
    res.json({
      ...result,
      profile: getStore().profile,
    });
  });

  app.patch('/api/learning/error-log/:id', (req: Request, res: Response) => {
    const updated = updateErrorLogItem(String(req.params.id), req.body || {});
    if (!updated) {
      res.status(404).json({ error: 'Error log entry not found' });
      return;
    }
    res.json(updated);
  });

  app.post('/api/learning/notes', (req: Request, res: Response) => {
    const saved = saveStudyNote(req.body);
    res.json(saved);
  });

  app.delete('/api/learning/notes/:id', (req: Request, res: Response) => {
    const ok = deleteStudyNote(String(req.params.id));
    res.json({ deleted: ok });
  });

  // 9. GitHub OAuth & Export Routes
  registerGitHubRoutes(app);

  // 10. Vite Middleware in Dev / Static Dist in Prod
  const distPath = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(distPath, 'index.html'));

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

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
