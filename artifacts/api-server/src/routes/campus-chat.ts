import { clerkClient, getAuth } from "@clerk/express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import {
  AddReactionBody,
  AddReactionParams,
  AddReactionResponse,
  DeleteMessageParams,
  EditMessageBody,
  EditMessageParams,
  EditMessageResponse,
  GetDashboardResponse,
  GetMeResponse,
  GetVerificationResponse,
  ListConversationsResponse,
  ListMessagesQueryParams,
  ListMessagesResponse,
  ListPeopleQueryParams,
  ListPeopleResponse,
  ListVerificationRequestsResponse,
  MarkConversationReadParams,
  MarkConversationReadResponse,
  RemoveReactionParams,
  ReviewVerificationBody,
  ReviewVerificationParams,
  ReviewVerificationResponse,
  SendMessageBody,
  SendMessageParams,
  SendMessageResponse,
  StartConversationBody,
  StartConversationResponse,
  SubmitVerificationBody,
  SubmitVerificationResponse,
  UpdateMeBody,
  UpdateMeResponse,
  UpdatePresenceResponse,
  SetTypingStatusBody,
  SetTypingStatusParams,
  SetTypingStatusResponse,
} from "@workspace/api-zod";
import {
  campusUsersTable,
  conversationsTable,
  db,
  messageReactionsTable,
  messagesTable,
  studentVerificationsTable,
  typingStatusesTable,
  type CampusConversation,
  type CampusMessage,
  type CampusUser,
  type StudentVerification,
} from "@workspace/db";
import { publishCampusEvent, addEventStream, hasOpenEventStream } from "../lib/campus-chat-events";

const router: IRouter = Router();

router.use((req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Sign in to use First Commit." });
    return;
  }
  next();
});

function safeUsername(userId: string): string {
  return `student_${userId.slice(-10).toLowerCase()}`.replace(
    /[^a-z0-9_]/g,
    "",
  );
}

async function getOrCreateCurrentUser(req: Request): Promise<CampusUser> {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) throw new Error("Authentication required");

  const [existing] = await db
    .select()
    .from(campusUsersTable)
    .where(eq(campusUsersTable.clerkUserId, clerkUserId))
    .limit(1);

  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const email =
    clerkUser.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
  const avatarUrl = clerkUser.imageUrl ?? null;

  if (existing) {
    const [updated] = await db
      .update(campusUsersTable)
      .set({ email, avatarUrl, updatedAt: new Date() })
      .where(eq(campusUsersTable.id, existing.id))
      .returning();
    return updated;
  }

  const fullName = [clerkUser.firstName, clerkUser.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const [created] = await db
    .insert(campusUsersTable)
    .values({
      id: clerkUserId,
      clerkUserId,
      displayName: fullName || "New student",
      username: safeUsername(clerkUserId),
      email,
      avatarUrl,
      isOnline: true,
      lastActiveAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [raced] = await db
    .select()
    .from(campusUsersTable)
    .where(eq(campusUsersTable.clerkUserId, clerkUserId))
    .limit(1);
  if (!raced) throw new Error("Could not create the student profile");
  return raced;
}

function toApiUser(user: CampusUser) {
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl,
    university: user.university,
    program: user.program,
    year: user.year,
    bio: user.bio,
    verificationStatus: user.verificationStatus,
    isOnline:
      user.isDemo ||
      Boolean(
        user.lastActiveAt &&
          user.lastActiveAt.getTime() > Date.now() - 90_000,
      ),
    lastActiveAt: user.lastActiveAt,
    isDemo: user.isDemo,
    createdAt: user.createdAt,
  };
}

function toApiVerification(
  verification: StudentVerification,
  applicantName: string,
) {
  return {
    id: verification.id,
    userId: verification.userId,
    university: verification.university,
    campusEmail: verification.campusEmail,
    studentIdLastFour: verification.studentIdLastFour,
    status: verification.status,
    submittedAt: verification.submittedAt,
    reviewedAt: verification.reviewedAt,
    reviewNote: verification.reviewNote,
    applicantName,
  };
}

function orderedParticipants(
  firstId: string,
  secondId: string,
): [string, string] {
  return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
}

async function ensureSampleChats(currentUser: CampusUser): Promise<void> {
  const namespace = createHash("sha256")
    .update(currentUser.id)
    .digest("hex")
    .slice(0, 8);
  const university = currentUser.university || "IIT Mandi";
  const samples = [
    {
      key: "asha",
      displayName: "Asha Iyer",
      username: `asha_${namespace}`,
      program: "Computer Science",
      year: 2,
      bio: "Always up for a study session or a good campus coffee.",
      initialIncoming: "Hey! Are you going to the project meetup this week?",
      initialOutgoing: "Yes, I have been looking forward to it. See you there!",
    },
    {
      key: "dev",
      displayName: "Devansh Rana",
      username: `dev_${namespace}`,
      program: "Electrical Engineering",
      year: 3,
      bio: "Building things, learning in public, and finding the best chai.",
      initialIncoming: "I found a quiet spot in the library for our group.",
      initialOutgoing: "Perfect. Send me the floor and I will meet you there.",
    },
    {
      key: "noor",
      displayName: "Noor Sheikh",
      username: `noor_${namespace}`,
      program: "Design & Technology",
      year: 1,
      bio: "New on campus and happy to meet people from other departments.",
      initialIncoming: "Hi! Do you know where the student centre is?",
      initialOutgoing: "I can point it out after class. It is near the main quad.",
    },
  ];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const demoUserId = `demo_${namespace}_${sample.key}`;
    const now = new Date();
    const [peer] = await db
      .insert(campusUsersTable)
      .values({
        id: demoUserId,
        clerkUserId: null,
        displayName: sample.displayName,
        username: sample.username,
        university,
        program: sample.program,
        year: sample.year,
        bio: sample.bio,
        verificationStatus: "verified",
        isOnline: true,
        lastActiveAt: now,
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const [existingPeer] = peer
      ? [peer]
      : await db
          .select()
          .from(campusUsersTable)
          .where(eq(campusUsersTable.id, demoUserId))
          .limit(1);
    if (!existingPeer) continue;

    const [participantOneId, participantTwoId] = orderedParticipants(
      currentUser.id,
      existingPeer.id,
    );
    const conversationId = `demo_chat_${namespace}_${sample.key}`;
    const [existingConversation] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId))
      .limit(1);
    if (existingConversation) continue;

    const lastMessageAt = new Date(now.getTime() - index * 90_000);
    const firstMessageAt = new Date(lastMessageAt.getTime() - 4 * 60_000);
    const [conversation] = await db
      .insert(conversationsTable)
      .values({
        id: conversationId,
        participantOneId,
        participantTwoId,
        isDemo: true,
        createdAt: firstMessageAt,
        updatedAt: lastMessageAt,
      })
      .returning();
    if (!conversation) continue;

    await db.insert(messagesTable).values([
      {
        id: `${conversation.id}_welcome`,
        conversationId: conversation.id,
        senderUserId: existingPeer.id,
        content: sample.initialIncoming,
        createdAt: firstMessageAt,
        readAt: index < 2 ? now : null,
      },
      {
        id: `${conversation.id}_reply`,
        conversationId: conversation.id,
        senderUserId: currentUser.id,
        content: sample.initialOutgoing,
        createdAt: lastMessageAt,
        readAt: null,
      },
    ]);
  }
}

async function getConversationForMember(
  conversationId: string,
  userId: string,
): Promise<CampusConversation | undefined> {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        or(
          eq(conversationsTable.participantOneId, userId),
          eq(conversationsTable.participantTwoId, userId),
        ),
      ),
    )
    .limit(1);
  if (conversation && !conversation.isDemo) {
    const participants = await db
      .select({
        id: campusUsersTable.id,
        verificationStatus: campusUsersTable.verificationStatus,
      })
      .from(campusUsersTable)
      .where(
        inArray(campusUsersTable.id, [
          conversation.participantOneId,
          conversation.participantTwoId,
        ]),
      );
    if (
      participants.length !== 2 ||
      participants.some((participant) => participant.verificationStatus !== "verified")
    ) {
      return undefined;
    }
  }
  return conversation;
}

async function mapMessages(
  messages: CampusMessage[],
  currentUserId: string,
) {
  if (messages.length === 0) return [];
  const senderIds = [...new Set(messages.map((message) => message.senderUserId))];
  const messageIds = messages.map((message) => message.id);
  const [senders, reactionRows] = await Promise.all([
    db
      .select({ id: campusUsersTable.id, displayName: campusUsersTable.displayName })
      .from(campusUsersTable)
      .where(inArray(campusUsersTable.id, senderIds)),
    db
      .select()
      .from(messageReactionsTable)
      .where(inArray(messageReactionsTable.messageId, messageIds)),
  ]);
  const senderNames = new Map(senders.map((sender) => [sender.id, sender.displayName]));
  const reactionsByMessage = new Map<
    string,
    Map<string, { count: number; reactedByMe: boolean }>
  >();
  for (const reaction of reactionRows) {
    const byEmoji = reactionsByMessage.get(reaction.messageId) ?? new Map();
    const current = byEmoji.get(reaction.emoji) ?? {
      count: 0,
      reactedByMe: false,
    };
    current.count += 1;
    current.reactedByMe ||= reaction.userId === currentUserId;
    byEmoji.set(reaction.emoji, current);
    reactionsByMessage.set(reaction.messageId, byEmoji);
  }

  return messages.map((message) => ({
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderUserId,
    senderName: senderNames.get(message.senderUserId) ?? "Campus student",
    content: message.isDeleted ? "Message deleted" : message.content,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    isDeleted: message.isDeleted,
    isRead: Boolean(message.readAt),
    replyToId: message.replyToId,
    reactions: [...(reactionsByMessage.get(message.id)?.entries() ?? [])].map(
      ([emoji, data]) => ({ emoji, ...data }),
    ),
  }));
}

async function conversationPreview(
  conversation: CampusConversation,
  currentUserId: string,
) {
  const peerId =
    conversation.participantOneId === currentUserId
      ? conversation.participantTwoId
      : conversation.participantOneId;
  const [peer] = await db
    .select()
    .from(campusUsersTable)
    .where(eq(campusUsersTable.id, peerId))
    .limit(1);
  if (!peer) return null;

  const [lastMessage] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversation.id))
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);
  const [unread] = await db
    .select({ value: count() })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.conversationId, conversation.id),
        ne(messagesTable.senderUserId, currentUserId),
        isNull(messagesTable.readAt),
      ),
    );
  const [previewMessage] = lastMessage
    ? await mapMessages([lastMessage], currentUserId)
    : [];

  return {
    id: conversation.id,
    peer: toApiUser(peer),
    lastMessage: previewMessage ?? null,
    unreadCount: unread?.value ?? 0,
    updatedAt: conversation.updatedAt,
    isDemo: conversation.isDemo,
  };
}

async function listConversationPreviews(currentUserId: string) {
  const [currentUser] = await db
    .select({ verificationStatus: campusUsersTable.verificationStatus })
    .from(campusUsersTable)
    .where(eq(campusUsersTable.id, currentUserId))
    .limit(1);
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(
      or(
        eq(conversationsTable.participantOneId, currentUserId),
        eq(conversationsTable.participantTwoId, currentUserId),
      ),
    )
    .orderBy(desc(conversationsTable.updatedAt));
  const visibleConversations =
    currentUser?.verificationStatus === "verified"
      ? conversations
      : conversations.filter((conversation) => conversation.isDemo);
  const previews = await Promise.all(
    visibleConversations.map((conversation) =>
      conversationPreview(conversation, currentUserId),
    ),
  );
  return previews.filter((conversation) => conversation !== null);
}

function getRouteId(request: Request, key: string): string | undefined {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] : value;
}

async function isReviewer(clerkUserId: string): Promise<boolean> {
  const account = await clerkClient.users.getUser(clerkUserId);
  const metadata = account.publicMetadata as Record<string, unknown>;
  return metadata.role === "admin";
}

async function notifyConversationParticipants(
  conversation: CampusConversation,
  event: { type: string; conversationId: string; [key: string]: unknown },
): Promise<void> {
  publishCampusEvent(conversation.participantOneId, event);
  publishCampusEvent(conversation.participantTwoId, event);
}

router.get("/me", async (req, res): Promise<void> => {
  const user = await getOrCreateCurrentUser(req);
  await ensureSampleChats(user);
  res.json(GetMeResponse.parse(toApiUser(user)));
});

router.patch("/me", async (req, res): Promise<void> => {
  const parsed = UpdateMeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const username = parsed.data.username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (username.length < 3) {
    res.status(400).json({ error: "Choose a username with at least 3 letters or numbers." });
    return;
  }

  try {
    const [updated] = await db
      .update(campusUsersTable)
      .set({
        displayName: parsed.data.displayName.trim(),
        username,
        university: parsed.data.university.trim(),
        program: parsed.data.program.trim(),
        year: parsed.data.year,
        bio: parsed.data.bio.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(campusUsersTable.id, user.id))
      .returning();
    if (!updated) {
      res.status(500).json({ error: "Could not save your profile." });
      return;
    }
    res.json(UpdateMeResponse.parse(toApiUser(updated)));
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "That username is already in use." });
      return;
    }
    throw error;
  }
});

router.get("/people", async (req, res): Promise<void> => {
  const query = ListPeopleQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const currentUser = await getOrCreateCurrentUser(req);
  const records = await db
    .select()
    .from(campusUsersTable)
    .where(ne(campusUsersTable.id, currentUser.id))
    .orderBy(asc(campusUsersTable.displayName));
  const term = (query.data.search ?? "").trim().toLowerCase();
  const people = records.filter((person) => {
    const visible =
      person.isDemo ||
      (currentUser.verificationStatus === "verified" &&
        person.verificationStatus === "verified" &&
        (!currentUser.university || person.university === currentUser.university));
    if (!visible) return false;
    if (!term) return true;
    return [
      person.displayName,
      person.username,
      person.university ?? "",
      person.program ?? "",
      person.bio ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(term);
  });
  res.json(ListPeopleResponse.parse(people.map(toApiUser)));
});

router.get("/verification", async (req, res): Promise<void> => {
  const user = await getOrCreateCurrentUser(req);
  const [verification] = await db
    .select()
    .from(studentVerificationsTable)
    .where(eq(studentVerificationsTable.userId, user.id))
    .orderBy(desc(studentVerificationsTable.submittedAt))
    .limit(1);
  if (!verification) {
    res.json(GetVerificationResponse.parse(null));
    return;
  }
  res.json(
    GetVerificationResponse.parse(
      toApiVerification(verification, user.displayName),
    ),
  );
});

router.post("/verification", async (req, res): Promise<void> => {
  const parsed = SubmitVerificationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const account = await clerkClient.users.getUser(user.clerkUserId ?? user.id);
  const verifiedEmail =
    account.primaryEmailAddress?.verification?.status === "verified"
      ? account.primaryEmailAddress.emailAddress.toLowerCase()
      : null;
  const campusEmail = parsed.data.campusEmail.trim().toLowerCase();
  if (!verifiedEmail || campusEmail !== verifiedEmail) {
    res.status(400).json({
      error: "Verify this email address in your account first, then use it as your campus email.",
    });
    return;
  }
  if (
    user.university &&
    user.university.trim().toLowerCase() !==
      parsed.data.university.trim().toLowerCase()
  ) {
    res.status(400).json({
      error: "Your verification request must use the university in your profile.",
    });
    return;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Student ID protection is not configured." });
    return;
  }

  const studentId = parsed.data.studentId.trim();
  const studentIdHash = createHmac("sha256", secret)
    .update(
      `${parsed.data.university.trim().toLowerCase()}:${studentId.toLowerCase()}`,
    )
    .digest("hex");
  const [alreadySubmitted] = await db
    .select()
    .from(studentVerificationsTable)
    .where(eq(studentVerificationsTable.studentIdHash, studentIdHash))
    .limit(1);
  if (alreadySubmitted) {
    if (alreadySubmitted.userId !== user.id) {
      res.status(409).json({ error: "This student ID already has a verification request." });
      return;
    }
    if (alreadySubmitted.status === "verified") {
      res.status(409).json({ error: "This student ID is already verified." });
      return;
    }
  }
  const [request] = alreadySubmitted
    ? await db
        .update(studentVerificationsTable)
        .set({
          university: parsed.data.university.trim(),
          campusEmail,
          studentIdLastFour: studentId.slice(-4),
          status: "pending",
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          reviewNote: null,
        })
        .where(eq(studentVerificationsTable.id, alreadySubmitted.id))
        .returning()
    : await db
        .insert(studentVerificationsTable)
        .values({
          id: randomUUID(),
          userId: user.id,
          university: parsed.data.university.trim(),
          campusEmail,
          studentIdHash,
          studentIdLastFour: studentId.slice(-4),
          status: "pending",
        })
        .returning();
  if (!request) {
    res.status(500).json({ error: "Could not submit your verification request." });
    return;
  }
  await db
    .update(campusUsersTable)
    .set({
      verificationStatus: "pending",
      university: parsed.data.university.trim(),
      updatedAt: new Date(),
    })
    .where(eq(campusUsersTable.id, user.id));
  const result = toApiVerification(request, user.displayName);
  publishCampusEvent(user.id, { type: "verification.updated" });
  res.status(201).json(SubmitVerificationResponse.parse(result));
});

router.get("/admin/verifications", async (req, res): Promise<void> => {
  const admin = await getOrCreateCurrentUser(req);
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId || !(await isReviewer(clerkUserId))) {
    res.status(403).json({ error: "Reviewer access is required." });
    return;
  }
  const pending = await db
    .select({
      verification: studentVerificationsTable,
      applicantName: campusUsersTable.displayName,
    })
    .from(studentVerificationsTable)
    .innerJoin(
      campusUsersTable,
      eq(studentVerificationsTable.userId, campusUsersTable.id),
    )
    .where(eq(studentVerificationsTable.status, "pending"))
    .orderBy(asc(studentVerificationsTable.submittedAt));
  void admin;
  res.json(
    ListVerificationRequestsResponse.parse(
      pending.map(({ verification, applicantName }) =>
        toApiVerification(verification, applicantName),
      ),
    ),
  );
});

router.patch("/admin/verifications/:verificationId", async (req, res): Promise<void> => {
  const params = ReviewVerificationParams.safeParse(req.params);
  const body = ReviewVerificationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: "Invalid request payload.",
    });
    return;
  }
  const reviewer = await getOrCreateCurrentUser(req);
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId || !(await isReviewer(clerkUserId))) {
    res.status(403).json({ error: "Reviewer access is required." });
    return;
  }
  const [request] = await db
    .select()
    .from(studentVerificationsTable)
    .where(
      and(
        eq(studentVerificationsTable.id, params.data.verificationId),
        eq(studentVerificationsTable.status, "pending"),
      ),
    )
    .limit(1);
  if (!request) {
    res.status(404).json({ error: "Pending verification request not found." });
    return;
  }
  const [updated] = await db
    .update(studentVerificationsTable)
    .set({
      status: body.data.status,
      reviewedAt: new Date(),
      reviewedBy: reviewer.id,
      reviewNote: body.data.reviewNote?.trim() || null,
    })
    .where(eq(studentVerificationsTable.id, request.id))
    .returning();
  await db
    .update(campusUsersTable)
    .set({
      verificationStatus: body.data.status,
      university: request.university,
      updatedAt: new Date(),
    })
    .where(eq(campusUsersTable.id, request.userId));
  const [applicant] = await db
    .select({ displayName: campusUsersTable.displayName })
    .from(campusUsersTable)
    .where(eq(campusUsersTable.id, request.userId))
    .limit(1);
  publishCampusEvent(request.userId, { type: "verification.updated" });
  res.json(
    ReviewVerificationResponse.parse(
      toApiVerification(updated, applicant?.displayName ?? "Campus student"),
    ),
  );
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const user = await getOrCreateCurrentUser(req);
  await ensureSampleChats(user);
  const conversations = await listConversationPreviews(user.id);
  const verified = await db
    .select({ value: count() })
    .from(campusUsersTable)
    .where(
      and(
        eq(campusUsersTable.verificationStatus, "verified"),
        user.university
          ? eq(campusUsersTable.university, user.university)
          : undefined,
      ),
    );
  const online = await db
    .select({ value: count() })
    .from(campusUsersTable)
    .where(
      and(
        gt(campusUsersTable.lastActiveAt, new Date(Date.now() - 90_000)),
        ne(campusUsersTable.id, user.id),
      ),
    );
  res.json(
    GetDashboardResponse.parse({
      conversationCount: conversations.length,
      unreadCount: conversations.reduce(
        (sum, conversation) => sum + conversation.unreadCount,
        0,
      ),
      verifiedCampusMembers: verified[0]?.value ?? 0,
      onlineMembers: online[0]?.value ?? 0,
      recentActivity: conversations.slice(0, 4),
    }),
  );
});

router.get("/conversations", async (req, res): Promise<void> => {
  const user = await getOrCreateCurrentUser(req);
  await ensureSampleChats(user);
  res.json(
    ListConversationsResponse.parse(
      await listConversationPreviews(user.id),
    ),
  );
});

router.post("/conversations", async (req, res): Promise<void> => {
  const parsed = StartConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const peerId = parsed.data.peerUserId;
  if (peerId === user.id) {
    res.status(400).json({ error: "You cannot start a conversation with yourself." });
    return;
  }
  const [peer] = await db
    .select()
    .from(campusUsersTable)
    .where(eq(campusUsersTable.id, peerId))
    .limit(1);
  if (
    !peer ||
    (!peer.isDemo && peer.verificationStatus !== "verified") ||
    (user.university && peer.university !== user.university)
  ) {
    res.status(404).json({ error: "Verified campus member not found." });
    return;
  }
  if (!peer.isDemo && user.verificationStatus !== "verified") {
    res.status(403).json({
      error: "Finish student verification before starting a campus conversation.",
    });
    return;
  }
  const [participantOneId, participantTwoId] = orderedParticipants(
    user.id,
    peer.id,
  );
  const [existing] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.participantOneId, participantOneId),
        eq(conversationsTable.participantTwoId, participantTwoId),
      ),
    )
    .limit(1);
  if (existing) {
    const conversation = await conversationPreview(existing, user.id);
    if (!conversation) {
      res.status(404).json({ error: "Conversation member not found." });
      return;
    }
    res.json(StartConversationResponse.parse(conversation));
    return;
  }
  const now = new Date();
  const [created] = await db
    .insert(conversationsTable)
    .values({
      id: randomUUID(),
      participantOneId,
      participantTwoId,
      isDemo: peer.isDemo,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const [conversation] = created
    ? [created]
    : await db
        .select()
        .from(conversationsTable)
        .where(
          and(
            eq(conversationsTable.participantOneId, participantOneId),
            eq(conversationsTable.participantTwoId, participantTwoId),
          ),
        )
        .limit(1);
  if (!conversation) {
    res.status(500).json({ error: "Could not open the conversation." });
    return;
  }
  const result = await conversationPreview(conversation, user.id);
  if (!result) {
    res.status(404).json({ error: "Conversation member not found." });
    return;
  }
  res.status(201).json(StartConversationResponse.parse(result));
});

router.get("/messages", async (req, res): Promise<void> => {
  const query = ListMessagesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const conversation = await getConversationForMember(
    query.data.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  const conditions = [eq(messagesTable.conversationId, conversation.id)];
  const term = query.data.search?.trim();
  if (term) conditions.push(ilike(messagesTable.content, `%${term}%`));
  const records = await db
    .select()
    .from(messagesTable)
    .where(and(...conditions))
    .orderBy(desc(messagesTable.createdAt))
    .limit(query.data.limit ?? 80);
  res.json(
    ListMessagesResponse.parse(
      await mapMessages(records.reverse(), user.id),
    ),
  );
});

router.post("/conversations/:conversationId/messages", async (req, res): Promise<void> => {
  const params = SendMessageParams.safeParse(req.params);
  const body = SendMessageBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: "Invalid request payload.",
    });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const conversation = await getConversationForMember(
    params.data.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  if (body.data.replyToId) {
    const [parent] = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.id, body.data.replyToId),
          eq(messagesTable.conversationId, conversation.id),
        ),
      )
      .limit(1);
    if (!parent) {
      res.status(400).json({ error: "Reply target is not in this conversation." });
      return;
    }
  }
  const [message] = await db
    .insert(messagesTable)
    .values({
      id: randomUUID(),
      conversationId: conversation.id,
      senderUserId: user.id,
      content: body.data.content.trim(),
      replyToId: body.data.replyToId ?? null,
    })
    .returning();
  const now = new Date();
  await db
    .update(conversationsTable)
    .set({ updatedAt: now })
    .where(eq(conversationsTable.id, conversation.id));
  const [result] = await mapMessages([message], user.id);
  await notifyConversationParticipants(conversation, {
    type: "message.created",
    conversationId: conversation.id,
    message: result,
  });
  res.status(201).json(SendMessageResponse.parse(result));
});

router.patch("/conversations/:conversationId/read", async (req, res): Promise<void> => {
  const params = MarkConversationReadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const conversation = await getConversationForMember(
    params.data.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  const readAt = new Date();
  const updated = await db
    .update(messagesTable)
    .set({ readAt })
    .where(
      and(
        eq(messagesTable.conversationId, conversation.id),
        ne(messagesTable.senderUserId, user.id),
        isNull(messagesTable.readAt),
      ),
    )
    .returning({ id: messagesTable.id });
  await notifyConversationParticipants(conversation, {
    type: "conversation.read",
    conversationId: conversation.id,
    readAt: readAt.toISOString(),
  });
  res.json(
    MarkConversationReadResponse.parse({
      conversationId: conversation.id,
      readAt,
      updatedMessages: updated.length,
    }),
  );
});

router.post("/conversations/:conversationId/typing", async (req, res): Promise<void> => {
  const params = SetTypingStatusParams.safeParse(req.params);
  const body = SetTypingStatusBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: "Invalid request payload.",
    });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const conversation = await getConversationForMember(
    params.data.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  const now = new Date();
  await db
    .insert(typingStatusesTable)
    .values({
      id: randomUUID(),
      conversationId: conversation.id,
      userId: user.id,
      isTyping: body.data.isTyping,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 8_000),
    })
    .onConflictDoUpdate({
      target: [typingStatusesTable.conversationId, typingStatusesTable.userId],
      set: {
        isTyping: body.data.isTyping,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 8_000),
      },
    });
  const result = {
    conversationId: conversation.id,
    userId: user.id,
    isTyping: body.data.isTyping,
    updatedAt: now,
  };
  await notifyConversationParticipants(conversation, {
    type: "conversation.typing",
    ...result,
  });
  res.json(SetTypingStatusResponse.parse(result));
});

router.patch("/messages/:messageId", async (req, res): Promise<void> => {
  const params = EditMessageParams.safeParse(req.params);
  const body = EditMessageBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: "Invalid request payload.",
    });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.messageId))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (existing.senderUserId !== user.id || existing.isDeleted) {
    res.status(403).json({ error: "You can only edit your own active messages." });
    return;
  }
  const conversation = await getConversationForMember(
    existing.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  const [updated] = await db
    .update(messagesTable)
    .set({ content: body.data.content.trim(), editedAt: new Date() })
    .where(eq(messagesTable.id, existing.id))
    .returning();
  const [result] = await mapMessages([updated], user.id);
  await notifyConversationParticipants(conversation, {
    type: "message.updated",
    conversationId: conversation.id,
    message: result,
  });
  res.json(EditMessageResponse.parse(result));
});

router.delete("/messages/:messageId", async (req, res): Promise<void> => {
  const params = DeleteMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.messageId))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (existing.senderUserId !== user.id || existing.isDeleted) {
    res.status(403).json({ error: "You can only remove your own active messages." });
    return;
  }
  const conversation = await getConversationForMember(
    existing.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  await db
    .update(messagesTable)
    .set({ content: "", isDeleted: true, editedAt: new Date() })
    .where(eq(messagesTable.id, existing.id));
  await notifyConversationParticipants(conversation, {
    type: "message.deleted",
    conversationId: conversation.id,
    messageId: existing.id,
  });
  res.sendStatus(204);
});

router.post("/messages/:messageId/reactions", async (req, res): Promise<void> => {
  const params = AddReactionParams.safeParse(req.params);
  const body = AddReactionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: "Invalid request payload.",
    });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const [message] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.messageId))
    .limit(1);
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const conversation = await getConversationForMember(
    message.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  await db
    .insert(messageReactionsTable)
    .values({
      id: randomUUID(),
      messageId: message.id,
      userId: user.id,
      emoji: body.data.emoji,
    })
    .onConflictDoNothing();
  const [result] = await mapMessages([message], user.id);
  await notifyConversationParticipants(conversation, {
    type: "message.reaction",
    conversationId: conversation.id,
    message: result,
  });
  res.json(AddReactionResponse.parse(result));
});

router.delete("/messages/:messageId/reactions/:emoji", async (req, res): Promise<void> => {
  const params = RemoveReactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const user = await getOrCreateCurrentUser(req);
  const [message] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.messageId))
    .limit(1);
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const conversation = await getConversationForMember(
    message.conversationId,
    user.id,
  );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  await db
    .delete(messageReactionsTable)
    .where(
      and(
        eq(messageReactionsTable.messageId, message.id),
        eq(messageReactionsTable.userId, user.id),
        eq(messageReactionsTable.emoji, params.data.emoji),
      ),
    );
  const [result] = await mapMessages([message], user.id);
  await notifyConversationParticipants(conversation, {
    type: "message.reaction",
    conversationId: conversation.id,
    message: result,
  });
  res.sendStatus(204);
});

router.post("/presence", async (req, res): Promise<void> => {
  const user = await getOrCreateCurrentUser(req);
  const now = new Date();
  const [updated] = await db
    .update(campusUsersTable)
    .set({ isOnline: true, lastActiveAt: now, updatedAt: now })
    .where(eq(campusUsersTable.id, user.id))
    .returning();
  const chats = await db
    .select()
    .from(conversationsTable)
    .where(
      or(
        eq(conversationsTable.participantOneId, user.id),
        eq(conversationsTable.participantTwoId, user.id),
      ),
    );
  for (const conversation of chats) {
    const peerId =
      conversation.participantOneId === user.id
        ? conversation.participantTwoId
        : conversation.participantOneId;
    publishCampusEvent(peerId, {
      type: "presence.updated",
      userId: user.id,
      isOnline: true,
      lastActiveAt: now.toISOString(),
    });
  }
  res.json(UpdatePresenceResponse.parse(toApiUser(updated)));
});

router.get("/events", async (req, res): Promise<void> => {
  const user = await getOrCreateCurrentUser(req);
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  res.write(`event: update\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);
  const removeStream = addEventStream(user.id, res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    removeStream();
    if (!hasOpenEventStream(user.id)) {
      const lastActiveAt = new Date();
      void db
        .update(campusUsersTable)
        .set({ isOnline: false, lastActiveAt, updatedAt: lastActiveAt })
        .where(eq(campusUsersTable.id, user.id))
        .then(async () => {
          const chats = await db
            .select()
            .from(conversationsTable)
            .where(
              or(
                eq(conversationsTable.participantOneId, user.id),
                eq(conversationsTable.participantTwoId, user.id),
              ),
            );
          for (const conversation of chats) {
            const peerId =
              conversation.participantOneId === user.id
                ? conversation.participantTwoId
                : conversation.participantOneId;
            publishCampusEvent(peerId, {
              type: "presence.updated",
              userId: user.id,
              isOnline: false,
              lastActiveAt: lastActiveAt.toISOString(),
            });
          }
        })
        .catch((error: unknown) => {
          req.log.warn({ error }, "Could not update presence after disconnect");
        });
    }
  });
});

export default router;
