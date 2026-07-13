import { Router, Response } from 'express';
import { eq, and, ne, inArray, sql } from 'drizzle-orm';
import { db, users, conversations, conversationMembers, messages, messageStatuses } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// 1. Fetch other users to start chats with
router.get('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.userId!;
    const otherUsersList = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(ne(users.id, currentUserId));

    return res.json(otherUsersList);
  } catch (error: any) {
    console.error('Fetch users error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Fetch conversations
router.get('/conversations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.userId!;

    const myMemberships = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, currentUserId));

    if (myMemberships.length === 0) {
      return res.json([]);
    }

    const conversationIds = myMemberships.map((m) => m.conversationId);

    // Get all other members for these conversations
    const otherMembers = await db
      .select({
        conversationId: conversationMembers.conversationId,
        user: {
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
        },
      })
      .from(conversationMembers)
      .innerJoin(users, eq(conversationMembers.userId, users.id))
      .where(
        and(
          inArray(conversationMembers.conversationId, conversationIds),
          ne(conversationMembers.userId, currentUserId)
        )
      );

    // Map to response format
    const results = otherMembers.map((m) => ({
      id: m.conversationId,
      otherUser: m.user,
    }));

    return res.json(results);
  } catch (error: any) {
    console.error('Fetch conversations error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Create or get existing 1:1 conversation
router.post('/conversations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.userId!;
    const { otherUserId } = req.body;

    if (!otherUserId) {
      return res.status(400).json({ error: 'otherUserId is required' });
    }

    if (currentUserId === otherUserId) {
      return res.status(400).json({ error: 'Cannot start conversation with yourself' });
    }

    // Verify other user exists
    const otherUser = await db.query.users.findFirst({
      where: eq(users.id, otherUserId),
    });

    if (!otherUser) {
      return res.status(404).json({ error: 'Recipient user not found' });
    }

    // Check if conversation already exists
    const myMemberships = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, currentUserId));

    let existingConversationId: string | null = null;

    if (myMemberships.length > 0) {
      const myConvIds = myMemberships.map((m) => m.conversationId);
      const sharedMembership = await db
        .select({ conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.userId, otherUserId),
            inArray(conversationMembers.conversationId, myConvIds)
          )
        );

      if (sharedMembership.length > 0) {
        existingConversationId = sharedMembership[0].conversationId;
      }
    }

    if (existingConversationId) {
      return res.json({
        id: existingConversationId,
        otherUser: {
          id: otherUser.id,
          email: otherUser.email,
          createdAt: otherUser.createdAt,
        },
      });
    }

    // Create a new conversation and members
    const [newConv] = await db.insert(conversations).values({}).returning();

    await db.insert(conversationMembers).values([
      { conversationId: newConv.id, userId: currentUserId },
      { conversationId: newConv.id, userId: otherUserId },
    ]);

    return res.status(201).json({
      id: newConv.id,
      otherUser: {
        id: otherUser.id,
        email: otherUser.email,
        createdAt: otherUser.createdAt,
      },
    });
  } catch (error: any) {
    console.error('Create conversation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Fetch message history
router.get('/conversations/:id/messages', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUserId = req.userId!;
    const conversationId = req.params.id;

    // Check membership
    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, currentUserId)
      ),
    });

    if (!membership) {
      return res.status(403).json({ error: 'Unauthorized access to conversation' });
    }

    const messagesList = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderId: messages.senderId,
        content: messages.content,
        sequenceId: messages.sequenceId,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
        status: sql<'sent' | 'delivered' | 'read'>`COALESCE(${messageStatuses.status}, 'sent')`,
      })
      .from(messages)
      .leftJoin(messageStatuses, eq(messages.id, messageStatuses.messageId))
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.sequenceId);

    return res.json(messagesList);
  } catch (error: any) {
    console.error('Fetch messages error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
