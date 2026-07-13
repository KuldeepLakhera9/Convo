import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, Conversation, WsMessage } from '@convo/shared';

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
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const onTokenExpiredRef = useRef(onTokenExpired);

  // Keep callback reference updated
  useEffect(() => {
    onTokenExpiredRef.current = onTokenExpired;
  }, [onTokenExpired]);

  // Fetch conversations
  const fetchConversations = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/chat/conversations', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    }
  }, []);

  // Fetch messages for a specific conversation
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
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  }, []);

  // Connect WebSocket
  const connectWs = useCallback(async (tokenToUse: string) => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    const wsUrl = `ws://localhost:3002?token=${tokenToUse}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      try {
        const wsMsg: WsMessage = JSON.parse(event.data);

        if (wsMsg.type === 'message_ack') {
          const { tempId, message } = wsMsg.payload;
          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            return {
              ...prev,
              [message.conversationId]: list.map((msg) =>
                msg.id === tempId ? { ...message, isPending: false } : msg
              ),
            };
          });
        } else if (wsMsg.type === 'new_message') {
          const message = wsMsg.payload;
          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            // Check if message already exists
            if (list.some((m) => m.id === message.id)) return prev;

            const updatedList = [...list, message].sort((a, b) => a.sequenceId - b.sequenceId);
            return {
              ...prev,
              [message.conversationId]: updatedList,
            };
          });
        } else if (wsMsg.type === 'error') {
          const { message, tempId } = wsMsg.payload;
          console.error('WebSocket server error:', message);
          if (tempId) {
            setMessages((prev) => {
              // Mark pending message as failed
              for (const convId of Object.keys(prev)) {
                const list = prev[convId];
                if (list.some((msg) => msg.id === tempId)) {
                  return {
                    ...prev,
                    [convId]: list.map((msg) =>
                      msg.id === tempId ? { ...msg, isPending: false, isFailed: true } : msg
                    ),
                  };
                }
              }
              return prev;
            });
          }
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.onclose = async (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      setIsConnected(false);

      // If connection closed unauthorized (4001 or standard fail), request fresh token
      if (accessToken) {
        console.log('Attempting WS reconnect...');
        const freshToken = await onTokenExpiredRef.current();
        if (freshToken) {
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connectWs(freshToken);
          }, 3000);
        }
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }, [accessToken]);

  // Initialize WS and Conversations
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

  // Fetch messages when active conversation changes
  useEffect(() => {
    if (activeConversationId && accessToken) {
      fetchMessages(activeConversationId, accessToken);
    }
  }, [activeConversationId, accessToken, fetchMessages]);

  // Send Message (with Optimistic UI updates)
  const sendMessage = useCallback((content: string) => {
    if (!activeConversationId || !currentUserId || !content.trim()) return;

    const tempId = crypto.randomUUID();
    const tempMessage: Message = {
      id: tempId,
      conversationId: activeConversationId,
      senderId: currentUserId,
      content: content.trim(),
      sequenceId: Date.now(), // temporary large sorting sequence
      createdAt: new Date().toISOString(),
      isPending: true,
    };

    // Update locally instantly (Optimistic UI)
    setMessages((prev) => {
      const list = prev[activeConversationId] || [];
      return {
        ...prev,
        [activeConversationId]: [...list, tempMessage],
      };
    });

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      const wsMsg: WsMessage = {
        type: 'send_message',
        payload: {
          id: tempId,
          conversationId: activeConversationId,
          content: content.trim(),
        },
      };
      socketRef.current.send(JSON.stringify(wsMsg));
    } else {
      // Mark as failed instantly if offline
      setMessages((prev) => {
        const list = prev[activeConversationId] || [];
        return {
          ...prev,
          [activeConversationId]: list.map((msg) =>
            msg.id === tempId ? { ...msg, isPending: false, isFailed: true } : msg
          ),
        };
      });
    }
  }, [activeConversationId, currentUserId]);

  // Start new 1:1 Conversation
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
    error,
    sendMessage,
    startConversation,
    refreshConversations: () => accessToken && fetchConversations(accessToken),
  };
}
