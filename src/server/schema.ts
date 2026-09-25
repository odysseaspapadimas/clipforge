import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false), image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(), expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"), userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("session_user_idx").on(table.userId)]);
export const accounts = sqliteTable("account", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"), password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
export const rateLimits = sqliteTable("rateLimit", {
  id: text("id").primaryKey(), key: text("key").notNull().unique(),
  count: integer("count").notNull(), lastRequest: integer("lastRequest").notNull(),
});
export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }), updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const projects = sqliteTable("project", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  title: text("title").notNull(), sourceKey: text("source_key").notNull().unique(),
  uploadId: text("upload_id"), fileSize: integer("file_size").notNull(), mimeType: text("mime_type").notNull(),
  durationMs: integer("duration_ms"), width: integer("width"), height: integer("height"),
  transcriptChunks: integer("transcript_chunks").notNull().default(0),
  transcriptChunksDone: integer("transcript_chunks_done").notNull().default(0),
  transcriptionBackend: text("transcription_backend", { enum: ["workers-ai", "deepgram"] }),
  status: text("status", { enum: ["uploading", "queued", "processing", "ready", "failed"] }).notNull().default("uploading"),
  error: text("error"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("project_owner_idx").on(table.userId, table.createdAt)]);
export const uploadParts = sqliteTable("upload_part", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  partNumber: integer("part_number").notNull(), etag: text("etag").notNull(), size: integer("size").notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.partNumber] })]);
export const words = sqliteTable("word", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  index: integer("word_index").notNull(), text: text("text").notNull(),
  startMs: integer("start_ms").notNull(), endMs: integer("end_ms").notNull(),
  speaker: integer("speaker"), confidence: integer("confidence"),
}, (table) => [primaryKey({ columns: [table.projectId, table.index] })]);
export const clips = sqliteTable("clip", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id), title: text("title").notNull(),
  startMs: integer("start_ms").notNull(), endMs: integer("end_ms").notNull(),
  cropX: integer("crop_x").notNull().default(500), cropY: integer("crop_y").notNull().default(500),
  zoom: integer("zoom").notNull().default(1000), captions: text("captions", { mode: "json" }).notNull().$type<Array<{ text: string; startMs: number; endMs: number }>>(),
  rationale: text("rationale"), score: integer("score"),
  revision: integer("revision").notNull().default(1), status: text("status", { enum: ["draft", "rendering", "ready", "failed"] }).notNull().default("draft"),
  outputKey: text("output_key"), renderedRevision: integer("rendered_revision"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("clip_owner_idx").on(table.userId, table.projectId)]);
export const renderJobs = sqliteTable("render_job", {
  id: text("id").primaryKey(), clipId: text("clip_id").notNull().references(() => clips.id),
  userId: text("user_id").notNull().references(() => users.id), revision: integer("revision").notNull(),
  status: text("status", { enum: ["queued", "running", "ready", "failed"] }).notNull().default("queued"),
  error: text("error"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("render_clip_revision_idx").on(table.clipId, table.revision)]);
export const subscriptions = sqliteTable("subscription", {
  userId: text("user_id").primaryKey().references(() => users.id), customerId: text("customer_id").notNull().unique(),
  subscriptionId: text("subscription_id").unique(), status: text("status").notNull(),
  periodStart: integer("period_start"), periodEnd: integer("period_end"), currentInvoice: text("current_invoice"),
  checkoutUrl: text("checkout_url"), checkoutCreatedAt: integer("checkout_created_at"),
  lastEventCreated: integer("last_event_created").notNull().default(0),
});
export const billingEvents = sqliteTable("billing_event", {
  id: text("id").primaryKey(), createdAt: integer("created_at").notNull(),
});
export const minuteLedger = sqliteTable("minute_ledger", {
  key: text("key").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  periodKey: text("period_key").notNull(), delta: integer("delta").notNull(),
  kind: text("kind", { enum: ["grant", "reserve", "release", "adjustment"] }).notNull(),
  projectId: text("project_id"), createdAt: integer("created_at").notNull(),
}, (table) => [index("ledger_user_idx").on(table.userId)]);
