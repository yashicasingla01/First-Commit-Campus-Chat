import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const campusUsersTable = pgTable(
  "campus_users",
  {
    id: text("id").primaryKey(),
    clerkUserId: text("clerk_user_id").unique(),
    displayName: text("display_name").notNull(),
    username: text("username").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    university: text("university"),
    program: text("program"),
    year: integer("year"),
    bio: text("bio"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    isOnline: boolean("is_online").notNull().default(false),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("campus_users_username_idx").on(table.username),
    index("campus_users_university_idx").on(table.university),
  ],
);

export const conversationsTable = pgTable(
  "campus_conversations",
  {
    id: text("id").primaryKey(),
    participantOneId: text("participant_one_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    participantTwoId: text("participant_two_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("campus_conversation_participants_idx").on(
      table.participantOneId,
      table.participantTwoId,
    ),
    index("campus_conversation_recent_idx").on(table.updatedAt),
  ],
);

export const messagesTable = pgTable(
  "campus_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    replyToId: text("reply_to_id"),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("campus_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("campus_messages_sender_idx").on(table.senderUserId),
  ],
);

export const messageReactionsTable = pgTable(
  "campus_message_reactions",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("campus_reaction_user_message_emoji_idx").on(
      table.messageId,
      table.userId,
      table.emoji,
    ),
    index("campus_reaction_message_idx").on(table.messageId),
  ],
);

export const studentVerificationsTable = pgTable(
  "campus_student_verifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    university: text("university").notNull(),
    campusEmail: text("campus_email").notNull(),
    studentIdHash: text("student_id_hash").notNull(),
    studentIdLastFour: text("student_id_last_four").notNull(),
    status: text("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by").references(() => campusUsersTable.id, {
      onDelete: "set null",
    }),
    reviewNote: text("review_note"),
  },
  (table) => [
    uniqueIndex("campus_verifications_student_id_hash_idx").on(
      table.studentIdHash,
    ),
    index("campus_verifications_status_idx").on(table.status),
    index("campus_verifications_user_idx").on(table.userId),
  ],
);

export const typingStatusesTable = pgTable(
  "campus_typing_statuses",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    isTyping: boolean("is_typing").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("campus_typing_conversation_user_idx").on(
      table.conversationId,
      table.userId,
    ),
    index("campus_typing_expiry_idx").on(table.expiresAt),
  ],
);

export type CampusUser = typeof campusUsersTable.$inferSelect;
export type CampusConversation = typeof conversationsTable.$inferSelect;
export type CampusMessage = typeof messagesTable.$inferSelect;
export type StudentVerification = typeof studentVerificationsTable.$inferSelect;
