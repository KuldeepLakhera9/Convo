import { Router, Response } from 'express';
import { eq, and, inArray } from 'drizzle-orm';
import { db, devicePrekeys, conversationMembers } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// Register or update public key bundles for a device
router.post('/prekeys', async (req: AuthenticatedRequest, res: Response) => {
  const { deviceId, identityKey, signedPrekey } = req.body;
  const userId = req.userId;

  if (!userId || !deviceId || !identityKey || !signedPrekey) {
    return res.status(400).json({ error: 'deviceId, identityKey, and signedPrekey are required' });
  }

  try {
    await db
      .insert(devicePrekeys)
      .values({
        userId,
        deviceId,
        identityKey,
        signedPrekey,
      })
      .onConflictDoUpdate({
        target: [devicePrekeys.userId, devicePrekeys.deviceId],
        set: {
          identityKey,
          signedPrekey,
          createdAt: new Date(),
        },
      });

    return res.status(200).json({ message: 'E2EE prekey bundle registered successfully' });
  } catch (err) {
    console.error('Failed to register prekey bundle:', err);
    return res.status(500).json({ error: 'Database error registering prekeys' });
  }
});

// Retrieve public key bundles for all active devices in a conversation
router.get('/conversations/:id/prekeys', async (req: AuthenticatedRequest, res: Response) => {
  const conversationId = req.params.id;
  const userId = req.userId;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Verify caller is a member
    const isMember = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId)
      ),
    });

    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: not a conversation member' });
    }

    // 2. Fetch all members of this conversation
    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
    });

    const memberIds = members.map((m) => m.userId);

    // 3. Fetch all prekey bundles for all devices of these members
    const bundles = await db
      .select({
        userId: devicePrekeys.userId,
        deviceId: devicePrekeys.deviceId,
        identityKey: devicePrekeys.identityKey,
        signedPrekey: devicePrekeys.signedPrekey,
      })
      .from(devicePrekeys)
      .where(inArray(devicePrekeys.userId, memberIds));

    return res.json(bundles);
  } catch (err) {
    console.error('Failed to query prekey bundles:', err);
    return res.status(500).json({ error: 'Database error retrieving prekeys' });
  }
});

export default router;
