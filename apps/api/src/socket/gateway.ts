import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import url from 'url';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { verifyAccessToken } from '../utils/auth';
import { db, messages, conversationMembers } from '../db';
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
        const payload: WsMessage = JSON.parse(data);
        if (payload.type === 'send_message') {
          const { id: tempId, conversationId, content } = payload.payload;

          if (!conversationId || !content.trim()) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Conversation ID and content are required', tempId },
            });
            return;
          }

          // Verify user belongs to conversation
          const memberRecord = await db.query.conversationMembers.findFirst({
            where: and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId)
            ),
          });

          if (!memberRecord) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Unauthorized conversation membership', tempId },
            });
            return;
          }

          // Database transaction with Row-Level Lock to ensure monotonic gapless sequence IDs
          let persistedMsg: Message | null = null;
          try {
            await db.transaction(async (tx) => {
              // 1. Lock the conversation row so concurrent messages block and wait for sequence assignment
              await tx.execute(
                sql`SELECT 1 FROM conversations WHERE id = ${conversationId} FOR UPDATE`
              );

              // 2. Fetch maximum current sequence ID in this conversation
              const maxSeqQuery = await tx.execute(
                sql`SELECT COALESCE(MAX(sequence_id), 0) as max_seq FROM messages WHERE conversation_id = ${conversationId}`
              );
              const nextSequenceId = Number(maxSeqQuery.rows[0]?.max_seq || 0) + 1;

              // 3. Insert new message
              const [insertedMsg] = await tx
                .insert(messages)
                .values({
                  conversationId,
                  senderId: userId,
                  content,
                  sequenceId: nextSequenceId,
                })
                .returning();

              persistedMsg = {
                id: insertedMsg.id,
                conversationId: insertedMsg.conversationId,
                senderId: insertedMsg.senderId,
                content: insertedMsg.content,
                sequenceId: insertedMsg.sequenceId,
                createdAt: insertedMsg.createdAt.toISOString(),
              };
            });
          } catch (txError: any) {
            console.error('Transaction error while inserting message:', txError);
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Database transaction error: failed to send message', tempId },
            });
            return;
          }

          if (!persistedMsg) {
            sendToSocket(ws, {
              type: 'error',
              payload: { message: 'Failed to persist message', tempId },
            });
            return;
          }

          // Fetch all conversation members to broadcast to
          const membersList = await db
            .select({ userId: conversationMembers.userId })
            .from(conversationMembers)
            .where(eq(conversationMembers.conversationId, conversationId));

          // Send Acknowledgement back to sender (on the active socket)
          sendToSocket(ws, {
            type: 'message_ack',
            payload: {
              tempId,
              message: persistedMsg,
            },
          });

          // Broadcast to other conversation members (excluding the sender's current active socket)
          for (const member of membersList) {
            const memberSockets = userSockets.get(member.userId);
            if (memberSockets) {
              for (const clientSocket of memberSockets) {
                // If it is the sender's current socket, we already sent message_ack.
                // However, if the sender has other sessions/tabs open, we broadcast new_message.
                if (clientSocket === ws) continue;

                if (clientSocket.readyState === WebSocket.OPEN) {
                  sendToSocket(clientSocket, {
                    type: 'new_message',
                    payload: persistedMsg,
                  });
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.error('Socket message handling error:', err);
        sendToSocket(ws, {
          type: 'error',
          payload: { message: 'Invalid socket request format' },
        });
      }
    });

    ws.on('close', () => {
      console.log(`User disconnected: ${userId}`);
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          userSockets.delete(userId);
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`Socket error for user ${userId}:`, err);
    });
  });
}

function sendToSocket(ws: WebSocket, message: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
