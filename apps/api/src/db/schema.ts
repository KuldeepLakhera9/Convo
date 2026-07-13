import { pgTable, uuid, text, timestamp, integer, primaryKey, boolean, unique, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  token: text('token').notNull().unique(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  isRevoked: boolean('is_revoked').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversationMembers = pgTable('conversation_members', {
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.conversationId, table.userId] }),
  };
});

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  senderId: uuid('sender_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  sequenceId: integer('sequence_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  // E2EE encrypted payloads per device ID: { deviceId -> { ciphertext, iv, ephemeralPublicKey } }
  encryptedPayloads: jsonb('encrypted_payloads'),
}, (table) => {
  return {
    uniqueSeq: unique('unique_conversation_seq').on(table.conversationId, table.sequenceId),
  };
});

// Added for per-recipient delivery and read state tracking
export const messageStatuses = pgTable('message_statuses', {
  id: uuid('id').defaultRandom().primaryKey(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: text('status').notNull(), // 'sent' | 'delivered' | 'read'
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    uniqueMsgRecipient: unique('unique_message_recipient').on(table.messageId, table.recipientId),
  };
});

// E2EE public prekey bundles registered per device/session of a user
export const devicePrekeys = pgTable('device_prekeys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  deviceId: text('device_id').notNull(),
  identityKey: text('identity_key').notNull(), // SPKI base64 format public identity key
  signedPrekey: text('signed_prekey').notNull(), // SPKI base64 format public signed prekey
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    uniqueUserDevice: unique('unique_user_device').on(table.userId, table.deviceId),
  };
});
