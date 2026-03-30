# AI Chroney — AI Workspace Platform

## Overview

AI Chroney is a full-stack AI-powered customer engagement platform built for jewelry businesses. It provides an AI chatbot widget that can be embedded on e-commerce sites, with features including multi-channel support (WhatsApp, Instagram, Facebook), visual product search, customer journey management, and CRM integration.

## Architecture

- **Frontend**: React 18 + Vite, TypeScript, TailwindCSS, Radix UI, Wouter (client-side routing)
- **Backend**: Node.js + Express, TypeScript (tsx for development)
- **Database**: PostgreSQL (Neon serverless) with Drizzle ORM + pgvector extension
- **AI**: OpenAI (chat, embeddings), Google Gemini
- **Storage**: Cloudflare R2 / AWS S3 compatible

The frontend and backend are served together on port 5000. In development, Express serves the Vite dev server middleware.

## Project Structure

```
client/         React frontend
  src/
    App.tsx     Main app with routing
    pages/      Page components
    components/ Reusable UI components
    hooks/      Custom React hooks
    lib/        Utilities
server/         Express backend
  index.ts      App entrypoint
  routes.ts     Route registration
  routes/       Route handlers
  services/     Business logic services
  db.ts         Database connection (Neon + Drizzle)
  init.ts       Database initialization (default admin)
  storage.ts    Data access layer
shared/
  schema.ts     Drizzle schema (shared between client and server)
  dto/          Data transfer objects
public/         Static assets (widget scripts, avatars)
```

## Development

```bash
npm run dev       # Start development server (port 5000)
npm run build     # Production build
npm run db:push   # Push schema changes to database
```

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string
- `ENCRYPTION_KEY` — 32+ char key for encrypting third-party API credentials
- `COOKIE_SECRET` — (optional in dev) Secret for cookie signing
- `APP_DOMAIN` — **Required on AWS / custom servers.** Set to your production domain (e.g. `portal.aichroney.com`) — controls webhook URLs, CORS origins, and Caprion CRM callback URL. On Replit this is auto-resolved from `REPLIT_DEV_DOMAIN` so it is not needed there.
- Various third-party keys: `OPENAI_API_KEY`, `WHATSAPP_*`, `SHOPIFY_*`, etc.

### AWS Deployment — Required Env Vars
When hosting on AWS (or any non-Replit server), set these in addition to the standard vars above:
- `APP_DOMAIN` — e.g. `portal.aichroney.com` (no `https://` prefix)
- `NODE_ENV=production`
- `PORT=5000` (or whichever port Nginx proxies to)
- `COOKIE_SECRET` — strong random string, required in production
- `DATABASE_URL` — RDS PostgreSQL connection string with pgvector enabled
- `ENCRYPTION_KEY` — same key used on Replit (copy from Replit secrets)
- All other third-party API keys (copy from Replit secrets)

### AWS Health Check
`GET /health` → returns `{ status: "ok", timestamp }` — used by AWS ALB to verify the instance is alive.

## Default Credentials

On first startup, a default superadmin account is created:
- Username: `admin`
- Password: (check startup logs or set `SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD` env vars)

## Background Workers

- **Shopify Sync Scheduler** — Periodically syncs products from Shopify (every 5 min check)
- **LeadSquared Retry Worker** — Retries failed CRM syncs up to 3 times with exponential backoff (1 min, 5 min, 15 min). Runs every 2 minutes. Leads that fail all 3 attempts are marked as `permanently_failed`.
- **Backup Scheduler** — Daily database backup at 4:00 AM IST (`server/services/backupScheduler.ts`)

## Configurable Document Types

Per-business configurable document type system for WhatsApp flow document extraction.

- **Schema**: `document_types` and `document_type_prompt_history` tables in `shared/schema.ts`
- **Service**: `server/services/documentTypeService.ts` — CRUD, caching (5-min TTL), auto-seeding defaults (Aadhaar, PAN, Bank Statement, Driving License)
- **API**: `/api/whatsapp/document-types` — GET, POST, PUT/:id, DELETE/:id, GET/:id/history
- **Admin UI**: Document Type Editor at `/admin/document-type-editor` — manage doc types, extraction fields (with per-field format regex/description via shield icon), AI prompts, duplicate detection, lead field mappings
- **Runtime**: `documentIdentificationService.ts` builds AI prompts dynamically from DB-configured doc types per business; per-field format validation runs at extraction time
- **Lead Field Mapping**: `leadFieldMappings: { extractionFieldKey, leadFieldKey }[]` on each document type — config-driven auto-fill of lead fields from extracted data (replaces hardcoded PAN/Aadhaar logic). System defaults ship with PAN→customer_name/pan/date_of_birth and Aadhaar→aadhaar/permanent_address mappings
- **Data model**: `ExtractionField: { key, label, required, formatRegex?, formatDescription? }`; `ValidationRules: { duplicateCheck?, duplicateField? }`; `LeadFieldMapping: { extractionFieldKey, leadFieldKey }` (format rules are per-field, not document-level)
- **Flow Builder**: Upload step in WhatsApp flow builder dynamically loads configured doc types instead of hardcoded list
- **Document Extraction Confirmation**: When enabled, extracted fields are shown to users via WhatsApp buttons (Confirm/Update) before auto-filling lead data. Configurable per-business (`doc_confirmation_enabled`, `doc_confirmation_mode`, `doc_confirmation_header`, `doc_confirmation_footer` on `whatsapp_settings`) and per-document-type (`confirmation_required`: `null`=inherit, `always`, `never` on `document_types`). State machine in `whatsappFlowService.ts` handles awaiting_action→selecting_field→entering_value flow. Auto-confirms pending state when new upload arrives. Recovery guard skips sessions with active confirmation state.

## Custom CRM Integration (Caprion / Per-Store Auth)

Full CRM sync engine supporting per-store authentication (e.g., Caprion financial services).

- **Schema**: `crm_store_credentials` table — stores dealer_name, store_name, sid, encrypted secret per business account
- **Auth Types**: `checksum_caprion` (per-store HMAC: ksort→join `||`→append secret→HMAC-SHA256), `checksum_hmac` (standard), `api_key`, `bearer`, `none`
- **Store-aware sync**: On sync, looks up store credential by matching `store_name` from lead's extracted data (case-insensitive, trimmed). Uses per-store secret for checksum generation.
- **Document upload**: After successful CreateLead, automatically uploads collected documents (PAN, Aadhaar, Bank Statement) to CRM's UploadDocument endpoint
- **Auto-sync**: When enabled (`autoSyncEnabled` on CRM settings), triggers CRM sync automatically on WhatsApp flow completion via `completeSession()`
- **Webhook**: `POST /api/webhooks/crm/status` — receives loan status updates, verifies checksum, updates lead's extracted data with `_crmLoanStatus`, `_crmUrn`, etc.
- **Store Credentials UI**: At `/custom-crm-settings` → Store Credentials section. Add/edit/delete/toggle stores, bulk import from CSV
- **Field mapping source type `store`**: Maps CRM fields to store credential properties (store.sid, store.storeName, store.dealerName, store.storeId)
- **Service**: `server/services/customCrmService.ts` — `syncLead()`, `syncLeadWithDocuments()`, `uploadDocumentsToCaprion()`, `generateCaprionChecksum()`, `verifyCaprionWebhookChecksum()`

## Hybrid CRM Field Mapping Architecture

Hybrid system connecting lead field definitions to CRM mappings — any business, any CRM.

- **Schema change**: `whatsapp_lead_fields.default_crm_field_key` (nullable text) — optional CRM alias set when defining a lead field (e.g., "Company Name" → `"CompanyName"`). Default fields pre-set: `customer_name`→`"Name"`, `customer_phone`→`"Mobile"`, `customer_email`→`"Email"`.
- **Schema change**: `custom_crm_field_mappings.is_auto_managed` (boolean, default `false`) — marks mappings created by the auto-sync endpoint; cleared to `false` when user manually edits a mapping.
- **Sync endpoint**: `POST /api/custom-crm/field-mappings/sync-from-lead-fields` — idempotent. Reads all enabled lead fields with `defaultCrmFieldKey` set, skips any whose `sourceField` already has a mapping, bulk-inserts the rest as `isAutoManaged: true`. Returns `{ created, skipped, total }`.
- **UI – Lead Fields (WhatsApp.tsx)**: "Add Custom Field" dialog includes optional "Default CRM Field Key" input. Each field row shows its current CRM key in blue (`CRM key: Name`) with a pencil icon to open an inline edit dialog.
- **UI – CRM Field Mappings (CustomCrmSettings.tsx)**: "Sync from Lead Fields" button in mappings header calls the sync endpoint and shows toast with counts. Auto-managed mappings show a blue "Auto" badge. When a user manually edits an auto-managed mapping, `isAutoManaged` is set to `false` and the badge disappears.
- **Multi-CRM safe**: CRM mappings remain the execution source of truth. The `defaultCrmFieldKey` is only a suggestion/default; each mapping is independently editable for different CRM systems.

## K12 Education Mode (TopScholar)

K12 education chatbot platform as a Product Feature toggle (`k12EducationEnabled` boolean flag on business accounts, shown in Super Admin Product Features dialog alongside Chroney Chat, WhatsApp, etc.).

- **Schema**: `k12_subjects`, `k12_chapters`, `k12_topics`, `k12_questions`, `k12_topic_notes`, `k12_topic_videos` tables in `shared/schema.ts`. Business account fields: `k12_education_enabled` (text 'true'/'false'), `topscholar_api_base_url`, `topscholar_api_token`. Notes and videos are one-to-many from topics (multiple revision notes and videos per topic). Revision notes are plain text (not HTML).
- **Routes**: `server/routes/k12.ts` — full CRUD for subjects/chapters/topics/questions, content tree endpoint, sample data seeding, search.
- **AI Tools**: `fetch_k12_topic` and `fetch_k12_questions` in `server/aiTools.ts` + handlers in `server/services/toolExecutionService.ts`. Tools are ALWAYS included when `k12EducationEnabled` is true. Tool descriptions instruct the AI to ALWAYS call `fetch_k12_topic` before answering any academic question.
- **K12 Content Resolver**: `server/services/k12ContentResolver.ts` — abstraction layer (`K12ContentResolver` interface + `InternalK12ContentResolver` implementation) for searching curriculum content. Searches across subjects, chapters, AND topics (not just topics). Uses Unicode-safe keyword extraction with Hindi/Marathi Devanagari support. Scored matching with exact → fuzzy → keyword fallback. Designed for future extensibility: swap `InternalK12ContentResolver` with `ExternalK12ContentResolver` to query a client's external database.
- **K12 Tutor Prompt**: When `k12EducationEnabled` is true, `buildEnrichedContext` in `chatService.ts` injects a lean tutor system prompt (not cached, per-request) instructing the AI to act as an educational tutor, always call tools before answering academic questions, and offer practice questions proactively.
- **Routes (notes/videos)**: CRUD endpoints for notes (`/api/k12/topics/:topicId/notes`, `/api/k12/notes/:id`) and videos (`/api/k12/topics/:topicId/videos`, `/api/k12/videos/:id`). Note: transcript data lives in the `k12_topic_videos` table (as an optional `transcript` column per video), not in a separate transcripts table.
- **Data migration**: `server/scripts/migrateK12NotesVideos.ts` runs on startup — converts legacy `revisionNotesHtml` (HTML-stripped to plain text) and `videoUrl`/`videoTranscript` from `k12_topics` into `k12_topic_notes` and `k12_topic_videos` rows. Idempotent (skips if rows already exist).
- **Frontend**: K12 Content page (`client/src/pages/K12Content.tsx`) — tree view of subjects → chapters → topics with inline add/delete. Topic detail page (`client/src/pages/K12TopicDetail.tsx`) — content view (not form) with: revision notes section (add/edit/delete multiple plain-text notes), videos section (add/edit/delete multiple videos with URL + transcript), questions tab (MCQ viewer with solutions). AI reads video transcripts and shares video URLs in chat responses.
- **Sidebar**: When `k12EducationEnabled` is true, sidebar shows Education-specific nav (Content, Conversations, Students, Insights, Widget).
- **Super Admin**: K12 Education toggle in Product Features dialog (GraduationCap icon, indigo color). System Mode dropdown has only Full/Essential options.
- **Sample data**: POST `/api/k12/seed-sample-data` seeds Mathematics (Similarity), Science (Gravitation), and Hindi (भाषा) subjects with chapters, topics, revision notes, and MCQ questions.
- **Test account**: User `topscholar` linked to "TopScholar" business account with `k12EducationEnabled=true`, `systemMode=full`.

## Job Portal (Recruitment Vertical)

Job listing and applicant tracking platform as a Product Feature toggle (`jobPortalEnabled` boolean flag on business accounts).

- **Schema**: `jobs`, `job_applicants`, `job_applications` tables in `shared/schema.ts`. Business account field: `job_portal_enabled` (text 'true'/'false').
- **Routes**: `server/routes/jobPortal.ts` — full CRUD for jobs, applicants, and applications. All data scoped by `businessAccountId`.
- **Frontend**: Jobs page (`client/src/pages/JobPortalJobs.tsx`) — list/create/edit/delete job listings with title, description, requirements, location, salary range, job type, experience level, department, skills. Applicants page (`client/src/pages/JobPortalApplicants.tsx`) — list/create/edit/delete applicants with name, email, phone, skills, experience summary, detail view with applied jobs.
- **Sidebar**: When `jobPortalEnabled` is true, sidebar shows Recruitment-specific nav (Jobs, Applicants, Conversations, Leads, Insights, Widget).
- **Super Admin**: Job Portal toggle in Product Features dialog (Briefcase icon, cyan color).
- **Job types**: full-time, part-time, contract, internship, freelance
- **Application statuses**: new, reviewing, shortlisted, rejected, hired
- **Applicant sources**: manual, chat, import

### Job Portal Chatbot AI (Task #17)

AI-powered recruitment chatbot with resume upload, parsing, and job matching:

- **AI Tools**: `search_jobs` (semantic search via embeddings), `parse_resume_and_match` (GPT-4o-mini resume extraction + cosine similarity job matching), `apply_to_job` (creates application records). Defined in `server/aiTools.ts`, handlers in `server/services/toolExecutionService.ts`.
- **Tool Selection**: Tools conditionally included when `jobPortalEnabled` in `selectRelevantTools()` — follows K12 pattern.
- **System Prompt**: Recruitment assistant instructions added in `chatService.ts buildEnrichedContext` when `context.jobPortalEnabled`.
- **Context Flow**: `jobPortalEnabled` passed through ChatContext in all 5 chat entry points (widget, widget-stream, dashboard, dashboard-stream, public-chat-stream).
- **JobCarousel Component**: `client/src/components/JobCarousel.tsx` — displays job cards with title, location, salary, type, skills, match score, and apply button.
- **Resume Upload**: PDF upload button in PublicChat.tsx (Briefcase icon, visible when `jobPortalEnabled`). Backend endpoint `POST /api/public-chat/:token/resume-upload` extracts text via `pdfProcessingService`. Password-protected links enforced.
- **Streaming**: Jobs data sent via `type: 'jobs'` SSE event with `{items, applicantId}`.
- **Apply Flow**: JobCarousel "Apply Now" triggers chat message with jobId+applicantId, AI calls `apply_to_job` tool.

### Job Portal External API Import (Task #18)

Import job listings from external REST APIs into the Job Portal:

- **Schema**: `job_import_config` jsonb column on `business_accounts` stores API URL, auth header, field mapping, and sync status/stats.
- **Service**: `server/services/jobImportService.ts` — fetches jobs from configured external API, maps fields via dot-notation path mapping, deduplicates by `externalRefId`, creates/updates jobs with text embeddings.
- **Routes**: `server/routes/jobPortal.ts` — `GET/POST /api/job-import/config` (save/load config), `POST /api/job-import/test` (test connection), `POST /api/job-import/sync` (trigger import), `GET /api/job-import/status` (sync status).
- **Frontend**: "Import Jobs" button and dialog in `JobPortalJobs.tsx` — API endpoint config, optional auth header, field mapping form (12 mappable fields), test connection button, sync trigger, progress/error display. Imported jobs shown with "Imported" badge.
- **Duplicate Detection**: Uses `externalRefId` field on jobs table; `getJobByExternalRefId` storage method prevents re-importing same job.
- **Auto-detection**: API response can be a JSON array or an object with `data`, `results`, `items`, `jobs`, or `records` array field.

## ElevenLabs TTS Voice Integration

Optional premium TTS voices via ElevenLabs API, configured per business account.

- **Schema**: `elevenlabs_api_key` column on `business_accounts` table
- **Storage**: `updateBusinessAccountElevenLabsKey()` in `server/storage.ts`
- **API Routes**: PATCH/GET `/api/business-accounts/:id/api-settings` — includes `elevenlabsApiKey` (masked) and `hasElevenLabsKey` in response
- **Admin UI**: ElevenLabs API Key card in `SuperAdminApiKeys.tsx` (alongside OpenAI key card)
- **Voice Selection**: `WidgetSettings.tsx` — ElevenLabs voices listed under "Premium" section with `elevenlabs-` prefix IDs (e.g., `elevenlabs-rachel`, `elevenlabs-sarah`)
- **TTS Service**: `server/services/elevenlabsService.ts` — `synthesizeSpeechElevenLabs()` (REST, PCM16), `ElevenLabsStreamingTTS` (WebSocket streaming), voice ID mapping
- **Realtime Voice Integration**: `realtimeVoiceService.ts` — detects ElevenLabs voice selection, suppresses OpenAI audio output, synthesizes via ElevenLabs after transcript completes, streams PCM16 chunks to client
- **Fallback**: If ElevenLabs voice selected but API key missing, falls back to OpenAI shimmer voice

## Voice Mode Context Continuity

When a user switches from text chat to inline voice mode, the prior text conversation history is injected into the OpenAI Realtime voice session so the AI retains full context of what was discussed.

- **Flow**: `EmbedChat` passes `textConversationId` → `InlineVoiceMode` includes it in WebSocket URL → `routes.ts` extracts and forwards → `realtimeVoiceService.ts` loads messages and injects via `conversation.item.create`
- **Security**: Server validates `textConversationId` belongs to the same `businessAccountId` before loading messages
- **Injection**: Up to 20 most recent messages are injected as conversation items (user messages as `input_text`, assistant messages as `text`)
- **System instructions**: `CONVERSATION CONTINUITY` directive is only added to system instructions when history was actually injected successfully (`textHistoryInjected` flag)
- **Files**: `server/realtimeVoiceService.ts` (`injectTextChatHistory`, `buildSystemInstructions`), `client/src/components/InlineVoiceMode.tsx`, `client/src/pages/EmbedChat.tsx`, `server/routes.ts`

## Database Backup & Restore

- **New backups**: Created in `pg_dump -Fc` custom binary format (`.dump` extension, internally compressed). Stored in R2 at `database-backups/{daily|weekly|monthly}/backup_{date}.dump`.
- **Legacy backups**: Old `.sql.gz` plain-SQL backups in R2 continue to work. The restore path detects the file extension and routes accordingly.
- **Restore routing**: `.dump` files → `pg_restore --data-only --disable-triggers --no-owner --no-acl --no-data-for-failed-tables` (handles schema drift natively). `.sql.gz` files → schema-aware streaming parser (builds schema map from `information_schema.columns`, rewrites COPY headers with only current columns, filters row data by positional index).
- **Service**: `server/services/databaseBackupService.ts`

## Expand-Only Schema Policy

> **All new database columns must be nullable or have a server-side DEFAULT value. Columns are never physically removed — only logically deprecated (prefixed with `deprecated_` or similar, left in schema as nullable).** This ensures any backup taken at any past date can be restored into the current schema without errors: pg_restore and the legacy COPY parser both handle new columns (they get their DEFAULT) and removed columns (the backup's COPY header column is skipped automatically).

## Deployment

- Target: Autoscale
- Build: `npm run build`
- Run: `node dist/index.js`

## Replit Environment Setup

- Database: Replit built-in PostgreSQL with pgvector extension enabled
- `ENCRYPTION_KEY` set as a shared env var (64-char hex, auto-generated at import)
- `DATABASE_URL` and PG* vars managed by Replit
- Workflow: "Start application" runs `npm run dev` on port 5000 (webview)
- Default superadmin created on first startup (username: `admin`)
