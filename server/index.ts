import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import crypto from "crypto";
import path from "path";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializeDatabase } from "./init";
import { initializePgVector } from "./db";
import { migrateK12NotesAndVideos } from "./scripts/migrateK12NotesVideos";
import { shopifySyncScheduler } from "./services/shopifySyncScheduler";
import { leadsquaredRetryWorker } from "./services/leadsquaredRetryWorker";
import { aiUsageLogger } from "./services/aiUsageLogger";
import { backupScheduler } from "./services/backupScheduler";

const app = express();

// Enable gzip compression for all responses (reduces bandwidth by 70-80%)
app.use(compression());

// Serve uploaded files (business photos for visual product search)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Serve public static files (widget scripts, avatars, etc.)
app.use(express.static(path.join(process.cwd(), 'public')));

// Generate or use cookie secret - MUST be set in production via env var
const COOKIE_SECRET = process.env.COOKIE_SECRET || (() => {
  const randomSecret = crypto.randomBytes(32).toString('hex');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('COOKIE_SECRET environment variable must be set in production');
  }
  console.warn('[Security] Using randomly generated cookie secret. Set COOKIE_SECRET env var for production.');
  return randomSecret;
})();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
// Enable CORS for widget embedding - separate configuration for widget vs authenticated routes
// Widget routes don't use credentials (no cookies), so no CSRF risk
app.use((req, res, next) => {
  // Specific widget endpoints that need cross-origin access from embedded sites
  const isWidgetRoute = req.path.startsWith('/widget') || 
                       req.path.startsWith('/api/chat/widget') || 
                       req.path.startsWith('/api/widget/') ||
                       req.path === '/api/widget-settings/public' ||
                       req.path === '/api/behavior-events' ||
                       req.path.startsWith('/api/public/proactive-guidance-rules') ||
                       req.path.startsWith('/api/journeys/public/') ||
                       req.path.match(/^\/api\/journeys\/[^\/]+\/intro$/) ||
                       req.path === '/api/chat/prewarm' ||
                       req.path.startsWith('/api/idle-timeout-settings/public') ||
                       req.path.startsWith('/api/exit-intent-settings/public');
  
  if (isWidgetRoute) {
    // Widget routes: allow all origins but NO credentials
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With, Cache-Control');
  } else {
    // Authenticated routes: same-origin only (credentials allowed)
    const origin = req.headers.origin;
    const allowedOrigins = [
      process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : null,
      process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null,
      process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : null,
      'http://localhost:5000',
      'http://localhost:5173'
    ].filter(Boolean);
    
    // In production, if no origin header (same-origin request), allow it
    if (!origin || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');
    }
  }
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(express.json({
  limit: '50mb', // Increased limit for try-on feature (base64 images can be 25MB+)
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));
app.use(cookieParser(COOKIE_SECRET));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // CRITICAL: Validate encryption key is configured for secure credential storage
  // This is required for encrypting third-party API keys (LeadSquared, Shopify, etc.)
  if (!process.env.ENCRYPTION_KEY) {
    console.error('[Security] CRITICAL ERROR: ENCRYPTION_KEY environment variable is not set.');
    console.error('[Security] This is REQUIRED for secure credential storage in production.');
    console.error('[Security] Please set a strong encryption key (min 32 characters) in your environment variables.');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be set in production for secure credential storage');
    } else {
      console.warn('[Security] WARNING: Running in development without ENCRYPTION_KEY. LeadSquared and other integrations requiring encryption will fail.');
    }
  } else if (process.env.ENCRYPTION_KEY.length < 32) {
    console.error('[Security] CRITICAL ERROR: ENCRYPTION_KEY must be at least 32 characters long.');
    throw new Error(`ENCRYPTION_KEY is too short (${process.env.ENCRYPTION_KEY.length} chars). Minimum: 32 characters.`);
  } else {
    console.log('[Security] ✓ ENCRYPTION_KEY validated successfully');
  }
  
  // Initialize database (create default superadmin if needed)
  await initializeDatabase();
  
  // Initialize pgvector extension for vector similarity search
  await initializePgVector();

  // Migrate legacy K12 topic data (revisionNotesHtml → k12_topic_notes, videoUrl/transcript → k12_topic_videos)
  await migrateK12NotesAndVideos().catch(err => console.error('[K12 Migration] Error:', err));
  
  // Initialize AI usage pricing
  await aiUsageLogger.initializePricing();
  
  // Normalize existing phone numbers to 10 digits (strips country codes)
  const { normalizeExistingPhones } = await import("./services/customerProfileService");
  await normalizeExistingPhones();
  
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error(`[Error] ${status} - ${message}`, err);
    res.status(status).json({ message });
  });

  // Serve test-widget.html directly (for testing widget URL tracking)
  // Must be before Vite's catch-all route
  app.get('/test-widget.html', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'test-widget.html'));
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
    
    // Start Shopify auto-sync scheduler
    shopifySyncScheduler.start();
    
    // Start LeadSquared retry worker for failed syncs
    leadsquaredRetryWorker.start();
    
    // Start daily database backup scheduler (4:00 AM IST)
    backupScheduler.start();
  });
})();
