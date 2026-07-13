import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, Conversation, WsMessage } from '@convo/shared';
import { localDb } from '../utils/db';

interface UseChatProps {
  accessToken: string | null;
  currentUserId: string | null;
  onTokenExpired: () => Promise<string | null>;
}

export function useChat({ accessToken, currentUserId, onTokenExpired }: UseChatProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);
  const onTokenExpiredRef = useRef(onTokenExpired);
  
  // Ref to track conversations without triggering WS reconnects
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    onTokenExpiredRef.current = onTokenExpired;
  }, [onTokenExpired]);

  // 1. Initial Local Cache Load
  useEffect(() => {
    const loadLocalCache = async () => {
      try {
        await localDb.init();
        const cachedConvs = await localDb.getConversations();
        setConversations(cachedConvs);

        const messagesMap: Record<string, Message[]> = {};
        for (const conv of cachedConvs) {
          const cachedMsgs = await localDb.getMessagesForConversation(conv.id);
          messagesMap[conv.id] = cachedMsgs;
        }
        setMessages(messagesMap);
      } catch (err) {
        console.error('Failed to load local IndexedDB cache:', err);
      }
    };
    loadLocalCache();
  }, [currentUserId]);

  // Fetch conversations from REST and cache them
  const fetchConversations = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/chat/conversations', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: Conversation[] = await res.json();
        setConversations(data);
        await localDb.saveConversations(data);
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    }
  }, []);

  // Fetch messages from REST and cache them
  const fetchMessages = useCallback(async (conversationId: string, token: string) => {
    try {
      const res = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: Message[] = await res.json();
        setMessages((prev) => ({
          ...prev,
          [conversationId]: data,
        }));
        await localDb.saveMessages(data);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  }, []);

  // Bulk update message status in local state and IndexedDB
  const updateLocalMessageStatus = useCallback(async (
    conversationId: string,
    status: 'delivered' | 'read',
    senderId?: string,
    upToSequenceId?: number,
    messageId?: string
  ) => {
    setMessages((prev) => {
      const list = prev[conversationId] || [];
      const updatedList = list.map((msg) => {
        const matchMessageId = messageId ? msg.id === messageId : true;
        const matchSender = senderId ? msg.senderId === senderId : true;
        const matchSeq = upToSequenceId ? msg.sequenceId <= upToSequenceId : true;

        if (matchMessageId && matchSender && matchSeq) {
          const currentStatus = msg.status || 'sent';
          if (
            (currentStatus === 'sent' && (status === 'delivered' || status === 'read')) ||
            (currentStatus === 'delivered' && status === 'read')
          ) {
            const updatedMsg = { ...msg, status };
            localDb.saveMessage(updatedMsg);
            return updatedMsg;
          }
        }
        return msg;
      });

      return {
        ...prev,
        [conversationId]: updatedList,
      };
    });
  }, []);

  // Send status update event to server
  const sendStatusUpdate = useCallback((
    conversationId: string,
    status: 'delivered' | 'read',
    messageId?: string,
    upToSequenceId?: number
  ) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'update_status',
        payload: { conversationId, status, messageId, upToSequenceId },
      }));
    }
  }, []);

  // Connect WebSocket with Exponential Backoff
  const connectWs = useCallback(async (tokenToUse: string) => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    const wsUrl = `ws://localhost:3002?token=${tokenToUse}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = async () => {
      console.log('WebSocket connected successfully');
      setIsConnected(true);
      setError(null);
      reconnectAttempts.current = 0;

      setIsSyncing(true);
      try {
        const cachedConvs = await localDb.getConversations();
        const syncItems = [];
        for (const conv of cachedConvs) {
          const cachedMsgs = await localDb.getMessagesForConversation(conv.id);
          const validMsgs = cachedMsgs.filter((m) => m.sequenceId > 0 && m.sequenceId < 1e11);
          const lastSeq = validMsgs.length > 0 ? Math.max(...validMsgs.map((m) => m.sequenceId)) : 0;
          syncItems.push({ conversationId: conv.id, lastSequenceId: lastSeq });
        }

        ws.send(JSON.stringify({
          type: 'sync_request',
          payload: { conversations: syncItems },
        }));

        const unsent = await localDb.getUnsentMessages();
        for (const m of unsent) {
          ws.send(JSON.stringify({
            type: 'send_message',
            payload: {
              id: m.id,
              conversationId: m.conversationId,
              content: m.content,
            },
          }));
        }
      } catch (err) {
        console.error('Error during WS sync handshake:', err);
      } finally {
        setIsSyncing(false);
      }
    };

    ws.onmessage = async (event) => {
      try {
        const wsMsg: WsMessage = JSON.parse(event.data);

        // 1. MESSAGE ACK
        if (wsMsg.type === 'message_ack') {
          const { tempId, message } = wsMsg.payload;
          
          await localDb.saveMessage(message);
          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            return {
              ...prev,
              [message.conversationId]: list.map((msg) =>
                msg.id === tempId ? { ...message, isPending: false } : msg
              ),
            };
          });
        } 
        
        // 2. NEW MESSAGE
        else if (wsMsg.type === 'new_message') {
          const message = wsMsg.payload;
          
          await localDb.saveMessage(message);
          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            if (list.some((m) => m.id === message.id)) return prev;

            const updatedList = [...list, message].sort((a, b) => a.sequenceId - b.sequenceId);
            return {
              ...prev,
              [message.conversationId]: updatedList,
            };
          });

          const isActive = message.conversationId === activeConversationId;
          const targetStatus = isActive ? 'read' : 'delivered';

          sendStatusUpdate(message.conversationId, targetStatus, undefined, message.sequenceId);
          await updateLocalMessageStatus(
            message.conversationId,
            targetStatus,
            message.senderId,
            message.sequenceId
          );
        } 
        
        // 3. SYNC RESPONSE
        else if (wsMsg.type === 'sync_response') {
          const { messages: replayedMessages } = wsMsg.payload;
          if (replayedMessages.length === 0) return;

          await localDb.saveMessages(replayedMessages);

          const groups: Record<string, Message[]> = {};
          for (const msg of replayedMessages) {
            if (!groups[msg.conversationId]) {
              groups[msg.conversationId] = [];
            }
            groups[msg.conversationId].push(msg);
          }

          setMessages((prev) => {
            const newMap = { ...prev };
            for (const [convId, list] of Object.entries(groups)) {
              const currentList = newMap[convId] || [];
              const merged = [...currentList];
              
              for (const m of list) {
                if (!merged.some((existing) => existing.id === m.id)) {
                  merged.push(m);
                } else {
                  const idx = merged.findIndex((existing) => existing.id === m.id);
                  merged[idx] = m;
                }
              }

              merged.sort((a, b) => a.sequenceId - b.sequenceId);
              newMap[convId] = merged;

              const receivedMsgs = list.filter((m) => m.senderId !== currentUserId);
              if (receivedMsgs.length > 0) {
                const maxSeq = Math.max(...receivedMsgs.map((m) => m.sequenceId));
                const isActive = convId === activeConversationId;
                const targetStatus = isActive ? 'read' : 'delivered';

                sendStatusUpdate(convId, targetStatus, undefined, maxSeq);
                updateLocalMessageStatus(convId, targetStatus, undefined, maxSeq);
              }
            }
            return newMap;
          });
        } 
        
        // 4. MESSAGE STATUS UPDATE (Sender receives delivery update, OR our own other tabs sync read receipts)
        else if (wsMsg.type === 'message_status_update') {
          const { conversationId, status, messageId, upToSequenceId, userId } = wsMsg.payload;
          
          // Determine who sent the messages that should be updated
          // If the update was triggered by our own user on another tab: we read Bob's messages. Bob is the sender.
          // If the update was triggered by Bob: Bob read Alice's messages. Alice is the sender.
          const otherUser = conversationsRef.current.find((c) => c.id === conversationId)?.otherUser;
          const targetSenderId = (userId === currentUserId) ? otherUser?.id : currentUserId;
          
          if (targetSenderId) {
            await updateLocalMessageStatus(conversationId, status, targetSenderId, upToSequenceId, messageId);
          }
        }

        // 5. MESSAGE EDITED
        else if (wsMsg.type === 'message_edited') {
          const { messageId, conversationId, content, updatedAt } = wsMsg.payload;
          
          setMessages((prev) => {
            const list = prev[conversationId] || [];
            const updatedList = list.map((msg) =>
              msg.id === messageId ? { ...msg, content, updatedAt } : msg
            );

            const editedMsg = updatedList.find((m) => m.id === messageId);
            if (editedMsg) {
              localDb.saveMessage(editedMsg);
            }

            return {
              ...prev,
              [conversationId]: updatedList,
            };
          });
        }
        
        // 6. ERROR
        else if (wsMsg.type === 'error') {
          const { message, tempId } = wsMsg.payload;
          console.error('Server ws error:', message);
          if (tempId) {
            setMessages((prev) => {
              for (const convId of Object.keys(prev)) {
                const list = prev[convId];
                if (list.some((msg) => msg.id === tempId)) {
                  const updatedList = list.map((msg) =>
                    msg.id === tempId ? { ...msg, isPending: false, isFailed: true } : msg
                  );
                  const failedMsg = updatedList.find((m) => m.id === tempId);
                  if (failedMsg) localDb.saveMessage(failedMsg);

                  return {
                    ...prev,
                    [convId]: updatedList,
                  };
                }
              }
              return prev;
            });
          }
        }
      } catch (err) {
        console.error('WebSocket message parsing error:', err);
      }
    };

    ws.onclose = async (event) => {
      console.log('WebSocket connection closed:', event.code, event.reason);
      setIsConnected(false);

      if (accessToken) {
        const backoffDelay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000) + Math.random() * 500;
        console.log(`Reconnecting in ${(backoffDelay / 1000).toFixed(1)} seconds...`);
        
        reconnectAttempts.current += 1;
        
        reconnectTimeoutRef.current = window.setTimeout(async () => {
          const freshToken = await onTokenExpiredRef.current();
          if (freshToken) {
            connectWs(freshToken);
          }
        }, backoffDelay);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket connection error:', err);
    };
  }, [accessToken, currentUserId, activeConversationId, sendStatusUpdate, updateLocalMessageStatus]);

  // Initial connection hook
  useEffect(() => {
    if (accessToken) {
      fetchConversations(accessToken);
      connectWs(accessToken);
    } else {
      if (socketRef.current) {
        socketRef.current.close();
      }
      setIsConnected(false);
      setConversations([]);
      setMessages({});
      localDb.clearAll();
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [accessToken, connectWs, fetchConversations]);

  // Fetch messages when conversation changes
  useEffect(() => {
    if (activeConversationId && accessToken) {
      fetchMessages(activeConversationId, accessToken);
      
      const currentMsgs = messages[activeConversationId] || [];
      const unreadFromOther = currentMsgs.filter((m) => m.senderId !== currentUserId && m.status !== 'read');
      if (unreadFromOther.length > 0) {
        const maxSeq = Math.max(...unreadFromOther.map((m) => m.sequenceId));
        sendStatusUpdate(activeConversationId, 'read', undefined, maxSeq);
        updateLocalMessageStatus(activeConversationId, 'read', currentUserId || undefined, maxSeq);
      }
    }
  }, [activeConversationId, accessToken, fetchMessages, currentUserId, sendStatusUpdate, updateLocalMessageStatus]);

  // Send Message
  const sendMessage = useCallback(async (content: string) => {
    if (!activeConversationId || !currentUserId || !content.trim()) return;

    const clientUuid = window.crypto.randomUUID();
    const tempMessage: Message = {
      id: clientUuid,
      conversationId: activeConversationId,
      senderId: currentUserId,
      content: content.trim(),
      sequenceId: Date.now(),
      createdAt: new Date().toISOString(),
      status: 'sent',
      isPending: true,
    };

    await localDb.saveMessage(tempMessage);

    setMessages((prev) => {
      const list = prev[activeConversationId] || [];
      return {
        ...prev,
        [activeConversationId]: [...list, tempMessage],
      };
    });

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'send_message',
        payload: {
          id: clientUuid,
          conversationId: activeConversationId,
          content: content.trim(),
        },
      }));
    }
  }, [activeConversationId, currentUserId]);

  // Edit Message (WebSocket push)
  const editMessage = useCallback((messageId: string, content: string) => {
    if (!activeConversationId || !content.trim()) return;

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'edit_message',
        payload: {
          messageId,
          conversationId: activeConversationId,
          content: content.trim(),
        },
      }));
    }
  }, [activeConversationId]);

  // Start Conversation
  const startConversation = useCallback(async (otherUserId: string) => {
    if (!accessToken) return;
    try {
      const res = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ otherUserId }),
      });
      if (res.ok) {
        const newConv: Conversation = await res.json();
        setConversations((prev) => {
          if (prev.some((c) => c.id === newConv.id)) return prev;
          return [newConv, ...prev];
        });
        await localDb.saveConversation(newConv);
        setActiveConversationId(newConv.id);
        return newConv.id;
      }
    } catch (err) {
      console.error('Failed to start conversation:', err);
    }
  }, [accessToken]);

  return {
    conversations,
    activeConversationId,
    setActiveConversationId,
    activeMessages: activeConversationId ? messages[activeConversationId] || [] : [],
    isConnected,
    isSyncing,
    error,
    sendMessage,
    editMessage, // Exported to support message editing
    startConversation,
    refreshConversations: () => accessToken && fetchConversations(accessToken),
  };
}
