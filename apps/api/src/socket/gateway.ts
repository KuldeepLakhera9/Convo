import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import url from 'url';
import { randomUUID } from 'crypto';
import { sql, eq, and, ne, inArray, gt } from 'drizzle-orm';
import { verifyAccessToken } from '../utils/auth';
import { db, messages, conversationMembers, messageStatuses } from '../db';
import { redisPublisher, redisSubscriber } from '../utils/redis';
import { WsMessage, Message } from '@convo/shared';

// Type definitions for Redis Pub/Sub envelope wrapping
interface RedisEnvelope {
  wsMessage: WsMessage;
  excludeSocketId?: string;
}

// Tracks local connections on THIS specific instance: userId -> Set of WebSockets
const localUserSockets = new Map<string, Set<WebSocket>>();

// Global handler for Redis Pub/Sub incoming messages
redisSubscriber.on('message', (channel, messageStr) => {
  if (channel.startsWith('user_channel:')) {
    const targetUserId = channel.split(':')[1];
    try {
      const envelope: RedisEnvelope = JSON.parse(messageStr);
      const sockets = localUserSockets.get(targetUserId);
      if (sockets) {
        for (const ws of sockets) {
          // Prevent sending updates back to the specific tab/socket that initiated the action
          if (envelope.excludeSocketId && (ws as any).socketId === envelope.excludeSocketId) {
            continue;
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(envelope.wsMessage));
          }
        }
      }
    } catch (err) {
      console.error('Failed to parse Redis Pub/Sub envelope:', err);
    }
  }
});

// Helper to publish a WebSocket message to a user channel via Redis
async function publishToUser(targetUserId: string, wsMessage: WsMessage, excludeSocketId?: string) {
  const envelope: RedisEnvelope = { wsMessage, excludeSocketId };
  await redisPublisher.publish(`user_channel:${targetUserId}`, JSON.stringify(envelope));
}

export function initWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Start Presence Heartbeat Timer
  // Runs every 15 seconds to extend the TTL (to 30s) of all users currently connected to this instance
  setInterval(async () => {
    try {
      const activeUsers = Array.from(localUserSockets.keys());
      if (activeUsers.length === 0) return;

      const pipeline = redisPublisher.pipeline();
      for (const userId of activeUsers) {
        pipeline.expire(`presence:${userId}`, 30);
      }
      await pipeline.exec();
    } catch (err) {
      console.error('Failed to run presence heartbeats:', err);
    }
  }, 15 * 1000);

  // Upgrade HTTP connections and authenticate via token query params
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    try {
      const parsedUrl = url.parse(req.url || '', true);
      const token = parsedUrl.query.token as string;

      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const decoded = verifyAccessToken(token);

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, decoded.userId);
      });
    } catch (error) {
      console.error('WebSocket upgrade authentication failed:', error);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage, userId: string) => {
    const socketId = randomUUID();
    (ws as any).socketId = socketId;
    console.log(`User connected on local instance: ${userId} (socket ID: ${socketId})`);

    // Track local socket
    if (!localUserSockets.has(userId)) {
      localUserSockets.set(userId, new Set());
      // First connection for this user on this instance: Subscribe to Redis channel
      await redisSubscriber.subscribe(`user_channel:${userId}`);
    }
    localUserSockets.get(userId)!.add(ws);

    // Track distributed presence in Redis
    try {
      await redisPublisher.incr(`presence:${userId}`);
      await redisPublisher.expire(`presence:${userId}`, 30);
    } catch (presenceErr) {
      console.error('Failed to track user connection in Redis:', presenceErr);
    }

    ws.on('message', async (data: string) => {
      try {
        const parsedData: WsMessage = JSON.parse(data);
        
        // 1. SEND MESSAGE
        if (parsedData.type === 'send_message') {
          const { id: messageId, conversationId, content, encryptedPayloads } = parsedData.payload;

          if (!messageId || !conversationId || !content.trim()) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Message ID, Conversation ID, and content are required', tempId: messageId },
            });
            return;
          }

          // DEDUPLICATION Check
          const existingMsg = await db.query.messages.findFirst({
            where: eq(messages.id, messageId),
          });

          if (existingMsg) {
            console.log(`Deduplication: Message ${messageId} already exists. Sending ACK.`);
            const statusRecord = await db.query.messageStatuses.findFirst({
              where: eq(messageStatuses.messageId, messageId),
            });
            const statusVal = (statusRecord?.status as 'sent' | 'delivered' | 'read') || 'sent';

            sendToSocket(ws, {
              type: 'message_ack',
              payload: {
                tempId: messageId,
                message: {
                  id: existingMsg.id,
                  conversationId: existingMsg.conversationId,
                  senderId: existingMsg.senderId,
                  content: existingMsg.content,
                  sequenceId: existingMsg.sequenceId,
                  createdAt: existingMsg.createdAt.toISOString(),
                  updatedAt: existingMsg.updatedAt?.toISOString(),
                  status: statusVal,
                  encryptedPayloads: existingMsg.encryptedPayloads as any,
                },
              },
            });
            return;
          }

          // Verify conversation membership
          const memberRecord = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId)
            ),
          });

          if (!memberRecord) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Unauthorized conversation membership', tempId: messageId },
            });
            return;
          }

          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });

          if (!otherMember) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Conversation recipient not found', tempId: messageId },
            });
            return;
          }

          // Check presence status in Redis (distributed presence checking)
          const isRecipientOnline = (await redisPublisher.exists(`presence:${otherMember.userId}`)) === 1;
          const initialStatus: 'sent' | 'delivered' = isRecipientOnline ? 'delivered' : 'sent';

          let persistedMsg: Message | null = null;
          
          try {
            await db.transaction(async (tx) => {
              // Lock the conversation row to secure sequential ordering
              await tx.execute(
                sql`SELECT 1 FROM conversations WHERE id = ${conversationId} FOR UPDATE`
              );

              const maxSeqQuery = await tx.execute(
                sql`SELECT COALESCE(MAX(sequence_id), 0) as max_seq FROM messages WHERE conversation_id = ${conversationId}`
              );
              const nextSequenceId = Number(maxSeqQuery.rows[0]?.max_seq || 0) + 1;

              const [insertedMsg] = await tx
                .insert(messages)
                .values({
                  id: messageId,
                  conversationId,
                  senderId: userId,
                  content,
                  sequenceId: nextSequenceId,
                  encryptedPayloads,
                })
                .returning();

              await tx.insert(messageStatuses).values({
                messageId: insertedMsg.id,
                recipientId: otherMember.userId,
                status: initialStatus,
              });

              persistedMsg = {
                id: insertedMsg.id,
                conversationId: insertedMsg.conversationId,
                senderId: insertedMsg.senderId,
                content: insertedMsg.content,
                sequenceId: insertedMsg.sequenceId,
                createdAt: insertedMsg.createdAt.toISOString(),
                status: initialStatus,
                encryptedPayloads: insertedMsg.encryptedPayloads as any,
              };
            });
          } catch (txError: any) {
            console.error('Transaction error:', txError);
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Database error: failed to send message', tempId: messageId },
            });
            return;
          }

          if (!persistedMsg) return;

          // ACK back to sender directly (on the active connection)
          sendToSocket(ws, {
            type: 'message_ack',
            payload: {
              tempId: messageId,
              message: persistedMsg,
            },
          });

          // Forward to recipient's active sessions (via Redis Pub/Sub)
          await publishToUser(otherMember.userId, {
            type: 'new_message',
            payload: persistedMsg,
          });

          // Forward to sender's other tabs/devices (via Redis Pub/Sub, skipping the current initiating socket ID)
          await publishToUser(userId, {
            type: 'new_message',
            payload: persistedMsg,
          }, socketId);
        }
        
        // 2. SYNC REQUEST (Reconnection sync cursors)
        else if (parsedData.type === 'sync_request') {
          const { conversations: syncItems } = parsedData.payload;
          const allMissedMessages: Message[] = [];

          for (const item of syncItems) {
            const { conversationId, lastSequenceId } = item;

            const missedList = await db
              .select({
                id: messages.id,
                conversationId: messages.conversationId,
                senderId: messages.senderId,
                content: messages.content,
                sequenceId: messages.sequenceId,
                createdAt: messages.createdAt,
                updatedAt: messages.updatedAt,
                encryptedPayloads: messages.encryptedPayloads,
                status: sql<'sent' | 'delivered' | 'read'>`COALESCE(${messageStatuses.status}, 'sent')`,
              })
              .from(messages)
              .leftJoin(messageStatuses, eq(messages.id, messageStatuses.messageId))
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  gt(messages.sequenceId, lastSequenceId)
                )
              )
              .orderBy(messages.sequenceId);

            // Update status to 'delivered' for missed messages sent by others
            const pendingDeliveredMsgIds = missedList
              .filter((m) => m.senderId !== userId && m.status === 'sent')
              .map((m) => m.id);

            if (pendingDeliveredMsgIds.length > 0) {
              await db
                .update(messageStatuses)
                .set({ status: 'delivered', updatedAt: new Date() })
                .where(
                  and(
                    inArray(messageStatuses.messageId, pendingDeliveredMsgIds),
                    eq(messageStatuses.recipientId, userId)
                  )
                );

              const senderIds = Array.from(new Set(missedList.filter((m) => m.senderId !== userId).map((m) => m.senderId)));
              for (const senderId of senderIds) {
                // Report delivery back to the sender (via Redis Pub/Sub)
                await publishToUser(senderId, {
                  type: 'message_status_update',
                  payload: {
                    conversationId,
                    status: 'delivered',
                    userId,
                    upToSequenceId: Math.max(...missedList.filter((m) => m.senderId === senderId).map((m) => m.sequenceId)),
                  },
                });
              }
              
              for (const m of missedList) {
                if (m.senderId !== userId && m.status === 'sent') {
                  m.status = 'delivered';
                }
              }
            }

            const mappedList: Message[] = missedList.map((m) => ({
              id: m.id,
              conversationId: m.conversationId,
              senderId: m.senderId,
              content: m.content,
              sequenceId: m.sequenceId,
              createdAt: m.createdAt.toISOString(),
              updatedAt: m.updatedAt?.toISOString(),
              status: m.status,
              encryptedPayloads: m.encryptedPayloads as any,
            }));

            allMissedMessages.push(...mappedList);
          }

          sendToSocket(ws, {
            type: 'sync_response',
            payload: {
              messages: allMissedMessages,
            },
          });
        }
        
        // 3. UPDATE STATUS (Delivery / Read event sync)
        else if (parsedData.type === 'update_status') {
          const { conversationId, status, messageId, upToSequenceId } = parsedData.payload;

          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });

          if (!otherMember) return;

          if (upToSequenceId) {
            // Update ensuring database status transitions only progress forward
            await db.execute(sql`
              UPDATE message_statuses
              SET status = ${status}, updated_at = NOW()
              FROM messages
              WHERE message_statuses.message_id = messages.id
                AND messages.conversation_id = ${conversationId}
                AND message_statuses.recipient_id = ${userId}
                AND messages.sender_id = ${otherMember.userId}
                AND messages.sequence_id <= ${upToSequenceId}
                AND (
                  (message_statuses.status = 'sent' AND ${status} IN ('delivered', 'read')) OR
                  (message_statuses.status = 'delivered' AND ${status} = 'read')
                )
            `);

            // Broadcast message_status_update via Redis Pub/Sub to reader's other tabs & conversation partner
            const targets = [userId, otherMember.userId];
            for (const targetId of targets) {
              const excludeId = targetId === userId ? socketId : undefined;
              await publishToUser(targetId, {
                type: 'message_status_update',
                payload: {
                  conversationId,
                  status,
                  userId,
                  upToSequenceId,
                },
              }, excludeId);
            }
          } else if (messageId) {
            // Update single message
            await db
              .update(messageStatuses)
              .set({ status, updatedAt: new Date() })
              .where(
                and(
                  eq(messageStatuses.messageId, messageId),
                  eq(messageStatuses.recipientId, userId)
                )
              );

            const targets = [userId, otherMember.userId];
            for (const targetId of targets) {
              const excludeId = targetId === userId ? socketId : undefined;
              await publishToUser(targetId, {
                type: 'message_status_update',
                payload: {
                  conversationId,
                  status,
                  userId,
                  messageId,
                },
              }, excludeId);
            }
          }
        }

        // 4. EDIT MESSAGE (Distributed message editing)
        else if (parsedData.type === 'edit_message') {
          const { messageId, conversationId, content } = parsedData.payload;

          if (!messageId || !conversationId || !content.trim()) {
            return;
          }

          // Verify sender ownership
          const msgRecord = await db.query.messages.findFirst({
            where: and(
              eq(messages.id, messageId),
              eq(messages.senderId, userId)
            ),
          });

          if (!msgRecord) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Unauthorized message edit' },
            });
            return;
          }

          const updatedAtTime = new Date();
          await db
            .update(messages)
            .set({
              content: content.trim(),
              updatedAt: updatedAtTime,
            })
            .where(eq(messages.id, messageId));

          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });

          if (!otherMember) return;

          // Publish message_edited broadcast to both members' sub-channels
          const membersToNotify = [userId, otherMember.userId];
          for (const memberId of membersToNotify) {
            await publishToUser(memberId, {
              type: 'message_edited',
              payload: {
                messageId,
                conversationId,
                content: content.trim(),
                updatedAt: updatedAtTime.toISOString(),
              },
            });
          }
        }

        // 5. WebRTC VIDEO CALLING SIGNALS
        else if (parsedData.type === 'call_user') {
          const { conversationId, offer } = parsedData.payload;
          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });

          if (!otherMember) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Conversation partner not found' },
            });
            return;
          }

          // Check if partner is online in Redis
          const isOnline = await redisPublisher.exists(`presence:${otherMember.userId}`);
          
          if (isOnline === 0) {
            // Callee is offline: register a Missed Call message
            let persistedMsg: Message | null = null;
            const messageId = randomUUID();
            try {
              await db.transaction(async (tx) => {
                await tx.execute(sql`SELECT 1 FROM conversations WHERE id = ${conversationId} FOR UPDATE`);
                const maxSeqQuery = await tx.execute(sql`SELECT COALESCE(MAX(sequence_id), 0) as max_seq FROM messages WHERE conversation_id = ${conversationId}`);
                const nextSequenceId = Number(maxSeqQuery.rows[0]?.max_seq || 0) + 1;

                const [insertedMsg] = await tx.insert(messages).values({
                  id: messageId,
                  conversationId,
                  senderId: userId,
                  content: '📞 Missed Call',
                  sequenceId: nextSequenceId,
                }).returning();

                await tx.insert(messageStatuses).values({
                  messageId: insertedMsg.id,
                  recipientId: otherMember.userId,
                  status: 'sent',
                });

                persistedMsg = {
                  id: insertedMsg.id,
                  conversationId: insertedMsg.conversationId,
                  senderId: insertedMsg.senderId,
                  content: insertedMsg.content,
                  sequenceId: insertedMsg.sequenceId,
                  createdAt: insertedMsg.createdAt.toISOString(),
                  status: 'sent',
                };
              });
            } catch (dbErr) {
              console.error('Failed to save missed call message:', dbErr);
            }

            if (persistedMsg) {
              // Notify caller with message_ack & error
              sendToSocket(ws, {
                type: 'new_message',
                payload: persistedMsg,
              });
              
              // Publish new missed call message to callee's Redis channel so it shows on reconnect
              await publishToUser(otherMember.userId, {
                type: 'new_message',
                payload: persistedMsg,
              });
            }

            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'User is offline. Registered a missed call.' },
            });
          } else {
            // Callee is online: forward the incoming call offer
            await publishToUser(otherMember.userId, {
              type: 'call_incoming',
              payload: { conversationId, offer, fromUserId: userId },
            });
          }
        }

        else if (parsedData.type === 'call_accepted') {
          const { conversationId, answer } = parsedData.payload;
          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });
          if (otherMember) {
            await publishToUser(otherMember.userId, {
              type: 'call_accepted',
              payload: { conversationId, answer },
            });
          }
        }

        else if (parsedData.type === 'call_rejected') {
          const { conversationId } = parsedData.payload;
          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });
          if (otherMember) {
            await publishToUser(otherMember.userId, {
              type: 'call_rejected',
              payload: { conversationId },
            });
          }
        }

        else if (parsedData.type === 'call_hangup') {
          const { conversationId } = parsedData.payload;
          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });
          if (otherMember) {
            await publishToUser(otherMember.userId, {
              type: 'call_hangup',
              payload: { conversationId },
            });
          }
        }

        else if (parsedData.type === 'ice_candidate') {
          const { conversationId, candidate, toUserId } = parsedData.payload;
          await publishToUser(toUserId, {
            type: 'ice_candidate',
            payload: { conversationId, candidate, toUserId },
          });
        }
      } catch (err: any) {
        console.error('Socket parsing error:', err);
      }
    });

    ws.onclose = async () => {
      console.log(`User disconnected locally: ${userId} (socket ID: ${socketId})`);
      const sockets = localUserSockets.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          localUserSockets.delete(userId);
          // Last active socket for this user on this instance closed: unsubscribe from Redis channel
          await redisSubscriber.unsubscribe(`user_channel:${userId}`);
        }
      }

      // Decrement distributed presence count
      try {
        const remaining = await redisPublisher.decr(`presence:${userId}`);
        if (remaining <= 0) {
          await redisPublisher.del(`presence:${userId}`);
        }
      } catch (presenceCloseErr) {
        console.error('Failed to clean presence in Redis on close:', presenceCloseErr);
      }
    };

    ws.onerror = (err) => {
      console.error(`Socket error for ${userId}:`, err);
    };
  });
}

function sendToSocket(ws: WebSocket, message: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
