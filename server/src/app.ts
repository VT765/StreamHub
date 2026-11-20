import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { errorHandler } from './lib/http.js';
import { router as authRouter } from './modules/auth/routes.js';
import { router as commentsRouter } from './modules/comments/routes.js';
import { router as downloadsRouter } from './modules/downloads/routes.js';
import { router as meetingsRouter } from './modules/meetings/routes.js';
import { router as securityRouter } from './modules/security/routes.js';
import { router as subscriptionsRouter, webhookRouter } from './modules/subscriptions/routes.js';
import { router as usersRouter } from './modules/users/routes.js';
import { router as videosRouter } from './modules/videos/routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: config.clientUrl, credentials: true }));
  // Razorpay webhooks need the raw body for signature verification — mount before express.json.
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRouter);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/videos', videosRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  app.use('/api/downloads', downloadsRouter);
  app.use('/api/comments', commentsRouter);
  app.use('/api/meetings', meetingsRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
