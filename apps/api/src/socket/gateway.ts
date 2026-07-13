import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import url from 'url';
import { sql, eq, and, ne, inArray, gt } from 'drizzle-orm';
import { verifyAccessToken } from '../utils/auth';
import { db, messages, conversationMembers, messageStatuses } from '../db';
import { WsMessage, Message } from '@convo/shared';

// Tracks active connections: userId -> Set of WebSockets
const userSockets = new Map<string, Set<WebSocket>>();

export function initWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade and authenticate using JWT in query params
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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, userId: string) => {
    console.log(`User connected: ${userId}`);

    // Store socket
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(ws);

    ws.on('message', async (data: string) => {
      try {
        const parsedData: WsMessage = JSON.parse(data);
        
        // 1. SEND MESSAGE
        if (parsedData.type === 'send_message') {
          const { id: messageId, conversationId, content } = parsedData.payload;

          if (!messageId || !conversationId || !content.trim()) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Message ID, Conversation ID, and content are required', tempId: messageId },
            });
            return;
          }

          // DEDUPLICATION
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
                },
              },
            });
            return;
          }

          // Verify membership
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

          const recipientSockets = userSockets.get(otherMember.userId);
          const isRecipientOnline = recipientSockets && recipientSockets.size > 0;
          const initialStatus: 'sent' | 'delivered' = isRecipientOnline ? 'delivered' : 'sent';

          let persistedMsg: Message | null = null;
          
          try {
            await db.transaction(async (tx) => {
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

          // ACK back to sender (active socket)
          sendToSocket(ws, {
            type: 'message_ack',
            payload: {
              tempId: messageId,
              message: persistedMsg,
            },
          });

          // Forward to recipient's active sessions
          if (isRecipientOnline) {
            for (const clientSocket of recipientSockets!) {
              if (clientSocket.readyState === WebSocket.OPEN) {
                sendToSocket(clientSocket, {
                  type: 'new_message',
                  payload: persistedMsg,
                });
              }
            }
          }

          // Forward to sender's OTHER active sessions/tabs (multi-session sync)
          const senderOtherSockets = userSockets.get(userId);
          if (senderOtherSockets) {
            for (const sSocket of senderOtherSockets) {
              if (sSocket !== ws && sSocket.readyState === WebSocket.OPEN) {
                sendToSocket(sSocket, {
                  type: 'new_message',
                  payload: persistedMsg,
                });
              }
            }
          }
        }
        
        // 2. SYNC REQUEST (Resumable Sync on reconnect)
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

            // Update status to 'delivered' for messages sent by others
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
                const senderSockets = userSockets.get(senderId);
                if (senderSockets) {
                  for (const sSocket of senderSockets) {
                    sendToSocket(sSocket, {
                      type: 'message_status_update',
                      payload: {
                        conversationId,
                        status: 'delivered',
                        userId,
                        upToSequenceId: Math.max(...missedList.filter((m) => m.senderId === senderId).map((m) => m.sequenceId)),
                      },
                    });
                  }
                }
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
        
        // 3. UPDATE STATUS (Delivery / Read state logs)
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
            // Bulk update ensuring database one-way state transitions (never downgrade from read -> delivered)
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

            // MULTI-SESSION STATUS SYNC: Broadcast to both the partner and reader's own other active sessions
            const targets = [userId, otherMember.userId];
            for (const targetId of targets) {
              const sockets = userSockets.get(targetId);
              if (sockets) {
                for (const socket of sockets) {
                  // Skip the specific socket tab that initiated this read update
                  if (targetId === userId && socket === ws) continue;

                  sendToSocket(socket, {
                    type: 'message_status_update',
                    payload: {
                      conversationId,
                      status,
                      userId, // Reader ID
                      upToSequenceId,
                    },
                  });
                }
              }
            }
          } else if (messageId) {
            // Update single message status
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
              const sockets = userSockets.get(targetId);
              if (sockets) {
                for (const socket of sockets) {
                  if (targetId === userId && socket === ws) continue;

                  sendToSocket(socket, {
                    type: 'message_status_update',
                    payload: {
                      conversationId,
                      status,
                      userId,
                      messageId,
                    },
                  });
                }
              }
            }
          }
        }

        // 4. EDIT MESSAGE (Verify sender, update DB, broadcast message_edited)
        else if (parsedData.type === 'edit_message') {
          const { messageId, conversationId, content } = parsedData.payload;

          if (!messageId || !conversationId || !content.trim()) {
            return;
          }

          // Verify message sender is the current user
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

          // Fetch recipient of the conversation
          const otherMember = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              ne(conversationMembers.userId, userId)
            ),
          });

          if (!otherMember) return;

          // Broadcast message_edited to both members (all active sessions/tabs)
          const membersToNotify = [userId, otherMember.userId];
          for (const memberId of membersToNotify) {
            const sockets = userSockets.get(memberId);
            if (sockets) {
              for (const socket of sockets) {
                if (socket.readyState === WebSocket.OPEN) {
                  sendToSocket(socket, {
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
            }
          }
        }
      } catch (err: any) {
        console.error('Socket message parsing error:', err);
      }
    });

    ws.onclose = () => {
      console.log(`User disconnected: ${userId}`);
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          userSockets.delete(userId);
        }
      }
    };

    ws.onerror = (err) => {
      console.error(`Socket error for user ${userId}:`, err);
    };
  });
}

function sendToSocket(ws: WebSocket, message: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
