import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, Conversation, WsMessage, PrekeyBundle } from '@convo/shared';
import { localDb } from '../utils/db';
import {
  generateDeviceKeyPair,
  exportPublicKey,
  x3dhInitiate,
  x3dhReceive,
  kdfStep,
  encryptSymmetric,
  decryptSymmetric,
} from '../utils/crypto';

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

  // E2EE Device credentials
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [deviceKeys, setDeviceKeys] = useState<{
    ik: { privateKey: CryptoKey; publicKey: CryptoKey };
    spk: { privateKey: CryptoKey; publicKey: CryptoKey };
  } | null>(null);

  // WebRTC Video Calling state
  const [callState, setCallState] = useState<'idle' | 'ringing_out' | 'ringing_in' | 'connected'>('idle');
  const [activeCallConversationId, setActiveCallConversationId] = useState<string | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [callOffer, setCallOffer] = useState<any | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callQuality, setCallQuality] = useState<'good' | 'poor' | 'disconnected'>('disconnected');
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCamMuted, setIsCamMuted] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);
  const onTokenExpiredRef = useRef(onTokenExpired);

  const conversationsRef = useRef<Conversation[]>([]);
  const prekeyBundlesRef = useRef<PrekeyBundle[]>([]);

  // WebRTC Connection References
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callTimeoutRef = useRef<number | null>(null);
  const iceCandidatesQueueRef = useRef<any[]>([]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    onTokenExpiredRef.current = onTokenExpired;
  }, [onTokenExpired]);

  // Decryption wrapper for individual messages
  const decryptMessage = useCallback(async (
    msg: Message,
    devId: string,
    keys: {
      ik: { privateKey: CryptoKey };
      spk: { privateKey: CryptoKey };
    }
  ): Promise<Message> => {
    if (!msg.encryptedPayloads) return msg;

    const senderDeviceId = msg.encryptedPayloads.senderDeviceId as string;
    const payload = msg.encryptedPayloads[devId] as {
      ciphertext: string;
      iv: string;
      ephemeralPublicKey: string;
    };

    if (!payload) {
      return {
        ...msg,
        content: '🔒 [Encrypted - Keyset unavailable on this device]',
      };
    }

    try {
      const sessionId = `${msg.senderId}:${senderDeviceId}`;
      let session = await localDb.getRatchetSession(sessionId);

      if (!session) {
        const bundle = prekeyBundlesRef.current.find(
          (b) => b.userId === msg.senderId && b.deviceId === senderDeviceId
        );
        
        if (!bundle) {
          return {
            ...msg,
            content: '🔒 [Encrypted - Sender public bundle missing]',
          };
        }

        const rootKey = await x3dhReceive(
          keys.ik,
          keys.spk,
          bundle.identityKey,
          payload.ephemeralPublicKey
        );

        session = {
          sessionId,
          rootKey,
          sendingChainKey: new Uint8Array(32),
          receivingChainKey: rootKey,
          remoteIKPub: bundle.identityKey,
        };
        await localDb.saveRatchetSession(session);
      }

      const { nextChainKey, messageKey } = await kdfStep(session.receivingChainKey, 'receive');
      session.receivingChainKey = nextChainKey;
      await localDb.saveRatchetSession(session);

      const plaintext = await decryptSymmetric(payload.ciphertext, payload.iv, messageKey);
      return {
        ...msg,
        content: plaintext,
      };
    } catch (err) {
      console.error('Decryption failed for message ID:', msg.id, err);
      return {
        ...msg,
        content: '🔒 [Decryption failed - session mismatch]',
      };
    }
  }, []);

  // 1. Initial Local Cache & E2EE Credentials Load
  useEffect(() => {
    const initializeE2eeAndCache = async () => {
      if (!currentUserId) return;
      try {
        await localDb.init();

        let keysBundle = await localDb.getDeviceKeys();
        let devId = keysBundle?.deviceId || null;
        
        if (!keysBundle) {
          devId = window.crypto.randomUUID();
          console.log(`Generating E2EE device key pairs for device ID: ${devId}`);
          const { ik, spk } = await generateDeviceKeyPair();
          keysBundle = {
            id: 'local_bundle',
            deviceId: devId,
            ik,
            spk,
          };
          await localDb.saveDeviceKeys(keysBundle);
        }

        setLocalDeviceId(devId);
        setDeviceKeys(keysBundle);

        const cachedConvs = await localDb.getConversations();
        setConversations(cachedConvs);

        const messagesMap: Record<string, Message[]> = {};
        for (const conv of cachedConvs) {
          const cachedMsgs = await localDb.getMessagesForConversation(conv.id);
          const decrypted = [];
          for (const m of cachedMsgs) {
            decrypted.push(await decryptMessage(m, devId, keysBundle));
          }
          messagesMap[conv.id] = decrypted;
        }
        setMessages(messagesMap);
      } catch (err) {
        console.error('E2EE and cache initialization failed:', err);
      }
    };
    initializeE2eeAndCache();
  }, [currentUserId, decryptMessage]);

  // 2. Register public prekey bundles on the server
  useEffect(() => {
    if (!accessToken || !localDeviceId || !deviceKeys) return;

    const registerPrekeys = async () => {
      try {
        const ikPub = await exportPublicKey(deviceKeys.ik.publicKey);
        const spkPub = await exportPublicKey(deviceKeys.spk.publicKey);

        await fetch('/api/chat/prekeys', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            deviceId: localDeviceId,
            identityKey: ikPub,
            signedPrekey: spkPub,
          }),
        });
        console.log('E2EE prekey bundle uploaded to registry.');
      } catch (err) {
        console.error('Failed to register prekeys with server:', err);
      }
    };
    registerPrekeys();
  }, [accessToken, localDeviceId, deviceKeys]);

  // Fetch participant prekey bundles
  const fetchPrekeyBundles = useCallback(async (convId: string, token: string) => {
    try {
      const res = await fetch(`/api/chat/conversations/${convId}/prekeys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const bundles: PrekeyBundle[] = await res.json();
        prekeyBundlesRef.current = bundles;
      }
    } catch (err) {
      console.error('Failed to fetch prekey bundles:', err);
    }
  }, []);

  // Fetch conversations
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

  // Fetch messages
  const fetchMessages = useCallback(async (conversationId: string, token: string) => {
    if (!localDeviceId || !deviceKeys) return;
    try {
      const res = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: Message[] = await res.json();
        await localDb.saveMessages(data);

        const decrypted = [];
        for (const m of data) {
          decrypted.push(await decryptMessage(m, localDeviceId, deviceKeys));
        }

        setMessages((prev) => ({
          ...prev,
          [conversationId]: decrypted,
        }));
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  }, [localDeviceId, deviceKeys, decryptMessage]);

  // Update status in local state
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

  // Send status update event
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

  // WebRTC State teardown
  const resetCallState = useCallback(() => {
    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    iceCandidatesQueueRef.current = [];
    setCallState('idle');
    setCallerId(null);
    setActiveCallConversationId(null);
    setCallOffer(null);
    setLocalStream(null);
    setRemoteStream(null);
    setCallQuality('disconnected');
    setIsMicMuted(false);
    setIsCamMuted(false);
  }, []);

  // Reject Call callback
  const rejectCall = useCallback(() => {
    if (activeCallConversationId && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'call_rejected',
        payload: { conversationId: activeCallConversationId },
      }));
    }
    resetCallState();
  }, [activeCallConversationId, resetCallState]);

  // Hangup Call callback
  const hangupCall = useCallback(() => {
    if (activeCallConversationId && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'call_hangup',
        payload: { conversationId: activeCallConversationId },
      }));
    }
    resetCallState();
  }, [activeCallConversationId, resetCallState]);

  // Accept Call callback
  const acceptCall = useCallback(async () => {
    if (callState !== 'ringing_in' || !callOffer || !activeCallConversationId) return;

    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }

    try {
      // Get local stream
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Create Peer Connection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      peerConnectionRef.current = pc;

      // Add local media tracks
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Handle remote media track
      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteStreamRef.current = event.streams[0];
          setRemoteStream(event.streams[0]);
        }
      };

      // Gather ICE Candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && callerId && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            type: 'ice_candidate',
            payload: {
              conversationId: activeCallConversationId,
              candidate: event.candidate,
              toUserId: callerId,
            },
          }));
        }
      };

      // Monitor network quality
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
          setCallQuality('good');
        } else if (state === 'disconnected') {
          setCallQuality('poor');
        } else if (state === 'failed' || state === 'closed') {
          setCallQuality('disconnected');
          resetCallState();
        }
      };

      // Set remote SDP offer & create local SDP answer
      await pc.setRemoteDescription(new RTCSessionDescription(callOffer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Send answer back to Caller
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'call_accepted',
          payload: { conversationId: activeCallConversationId, answer },
        }));
      }

      setCallState('connected');

      // Flush queued ICE candidates
      for (const cand of iceCandidatesQueueRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      iceCandidatesQueueRef.current = [];
    } catch (err) {
      console.error('Failed to accept incoming WebRTC call:', err);
      resetCallState();
    }
  }, [callState, callOffer, activeCallConversationId, callerId, resetCallState]);

  // Connect WebSocket
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
              encryptedPayloads: m.encryptedPayloads,
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
      if (!localDeviceId || !deviceKeys) return;
      try {
        const wsMsg: WsMessage = JSON.parse(event.data);

        // 1. MESSAGE ACK
        if (wsMsg.type === 'message_ack') {
          const { tempId, message } = wsMsg.payload;
          await localDb.saveMessage(message);
          const decrypted = await decryptMessage(message, localDeviceId, deviceKeys);

          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            return {
              ...prev,
              [message.conversationId]: list.map((msg) =>
                msg.id === tempId ? { ...decrypted, isPending: false } : msg
              ),
            };
          });
        } 
        
        // 2. NEW MESSAGE
        else if (wsMsg.type === 'new_message') {
          const message = wsMsg.payload;
          await localDb.saveMessage(message);
          const decrypted = await decryptMessage(message, localDeviceId, deviceKeys);

          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            if (list.some((m) => m.id === message.id)) return prev;

            const updatedList = [...list, decrypted].sort((a, b) => a.sequenceId - b.sequenceId);
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
            const processDecryption = async () => {
              for (const [convId, list] of Object.entries(groups)) {
                const currentList = newMap[convId] || [];
                const merged = [...currentList];
                
                for (const m of list) {
                  const decrypted = await decryptMessage(m, localDeviceId, deviceKeys);
                  if (!merged.some((existing) => existing.id === m.id)) {
                    merged.push(decrypted);
                  } else {
                    const idx = merged.findIndex((existing) => existing.id === m.id);
                    merged[idx] = decrypted;
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
              setMessages({ ...newMap });
            };
            processDecryption();
            return prev;
          });
        } 
        
        // 4. MESSAGE STATUS UPDATE
        else if (wsMsg.type === 'message_status_update') {
          const { conversationId, status, messageId, upToSequenceId, userId } = wsMsg.payload;
          const otherUser = conversationsRef.current.find((c) => c.id === conversationId)?.otherUser;
          const targetSenderId = (userId === currentUserId) ? otherUser?.id : currentUserId;
          
          if (targetSenderId) {
            await updateLocalMessageStatus(conversationId, status, targetSenderId, upToSequenceId, messageId);
          }
        }

        // 5. MESSAGE EDITED
        else if (wsMsg.type === 'message_edited') {
          const { messageId, conversationId, content } = wsMsg.payload;
          setMessages((prev) => {
            const list = prev[conversationId] || [];
            const updatedList = list.map((msg) =>
              msg.id === messageId ? { ...msg, content } : msg
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
        
        // 6. WebRTC: INCOMING CALL OFFER
        else if (wsMsg.type === 'call_incoming') {
          const { conversationId, offer, fromUserId } = wsMsg.payload;
          setCallState('ringing_in');
          setCallerId(fromUserId);
          setActiveCallConversationId(conversationId);
          setCallOffer(offer);

          // Callee ringing timeout (30 seconds)
          callTimeoutRef.current = window.setTimeout(() => {
            console.log('No answer - auto rejecting incoming call.');
            rejectCall();
          }, 30000);
        }

        // 7. WebRTC: CALL ACCEPTED (SDP ANSWER)
        else if (wsMsg.type === 'call_accepted') {
          const { answer } = wsMsg.payload;
          if (callTimeoutRef.current) {
            clearTimeout(callTimeoutRef.current);
            callTimeoutRef.current = null;
          }
          if (peerConnectionRef.current) {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
            setCallState('connected');

            // Flush queued ICE candidates
            for (const cand of iceCandidatesQueueRef.current) {
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(cand));
            }
            iceCandidatesQueueRef.current = [];
          }
        }

        // 8. WebRTC: CALL REJECTED
        else if (wsMsg.type === 'call_rejected') {
          setError('Call rejected by the recipient');
          resetCallState();
          setTimeout(() => setError(null), 4000);
        }

        // 9. WebRTC: CALL HANGUP / DISCONNECT
        else if (wsMsg.type === 'call_hangup') {
          resetCallState();
        }

        // 10. WebRTC: ICE CANDIDATE
        else if (wsMsg.type === 'ice_candidate') {
          const { candidate } = wsMsg.payload;
          const pc = peerConnectionRef.current;
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            iceCandidatesQueueRef.current.push(candidate);
          }
        }
        
        // 11. ERROR
        else if (wsMsg.type === 'error') {
          const { message, tempId } = wsMsg.payload;
          setError(message);
          setTimeout(() => setError(null), 4000);

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
  }, [accessToken, currentUserId, activeConversationId, sendStatusUpdate, updateLocalMessageStatus, decryptMessage, localDeviceId, deviceKeys, resetCallState, rejectCall]);

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
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, [accessToken, connectWs, fetchConversations]);

  // Fetch prekeys when active conversation changes
  useEffect(() => {
    if (activeConversationId && accessToken && localDeviceId && deviceKeys) {
      const initConversationSession = async () => {
        await fetchPrekeyBundles(activeConversationId, accessToken);
        await fetchMessages(activeConversationId, accessToken);
        
        const currentMsgs = messages[activeConversationId] || [];
        const unreadFromOther = currentMsgs.filter((m) => m.senderId !== currentUserId && m.status !== 'read');
        if (unreadFromOther.length > 0) {
          const maxSeq = Math.max(...unreadFromOther.map((m) => m.sequenceId));
          sendStatusUpdate(activeConversationId, 'read', undefined, maxSeq);
          updateLocalMessageStatus(activeConversationId, 'read', currentUserId || undefined, maxSeq);
        }
      };
      initConversationSession();
    }
  }, [activeConversationId, accessToken, fetchMessages, fetchPrekeyBundles, currentUserId, sendStatusUpdate, updateLocalMessageStatus, localDeviceId, deviceKeys]);

  // Initiate Call callback (Caller)
  const startCall = useCallback(async (conversationId: string) => {
    if (callState !== 'idle' || !socketRef.current) return;

    setActiveCallConversationId(conversationId);
    setCallState('ringing_out');

    try {
      // Get local media
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Create Peer Connection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      peerConnectionRef.current = pc;

      // Add local media tracks
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Handle remote stream
      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteStreamRef.current = event.streams[0];
          setRemoteStream(event.streams[0]);
        }
      };

      // Gather local ICE Candidates
      pc.onicecandidate = (event) => {
        const otherMember = conversationsRef.current.find((c) => c.id === conversationId)?.otherUser;
        if (event.candidate && otherMember && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            type: 'ice_candidate',
            payload: {
              conversationId,
              candidate: event.candidate,
              toUserId: otherMember.id,
            },
          }));
        }
      };

      // Monitor network quality
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
          setCallQuality('good');
        } else if (state === 'disconnected') {
          setCallQuality('poor');
        } else if (state === 'failed' || state === 'closed') {
          setCallQuality('disconnected');
          resetCallState();
        }
      };

      // Create offer and set local description
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send SDP Offer signaling event
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'call_user',
          payload: { conversationId, offer },
        }));
      }

      // Caller timeout (30 seconds)
      callTimeoutRef.current = window.setTimeout(() => {
        console.log('Ringing timeout - call cancelled.');
        hangupCall();
      }, 30000);
    } catch (err) {
      console.error('Failed to initiate WebRTC call:', err);
      resetCallState();
    }
  }, [callState, resetCallState, hangupCall]);

  // Send E2EE Encrypted Message
  const sendMessage = useCallback(async (content: string) => {
    if (!activeConversationId || !currentUserId || !localDeviceId || !deviceKeys || !content.trim()) return;

    const clientUuid = window.crypto.randomUUID();
    const encryptedPayloads: Record<string, { ciphertext: string; iv: string; ephemeralPublicKey: string }> = {
      senderDeviceId: localDeviceId,
    } as any;

    try {
      for (const bundle of prekeyBundlesRef.current) {
        if (bundle.userId === currentUserId && bundle.deviceId === localDeviceId) continue;

        const sessionId = `${bundle.userId}:${bundle.deviceId}`;
        let session = await localDb.getRatchetSession(sessionId);
        let sessionEphemeralPublicKey = session?.ephemeralPublicKey || '';

        if (!session) {
          const { rootKey, ephemeralPublicKey } = await x3dhInitiate(
            deviceKeys.ik,
            bundle.identityKey,
            bundle.signedPrekey
          );

          session = {
            sessionId,
            rootKey,
            sendingChainKey: rootKey,
            receivingChainKey: new Uint8Array(32),
            remoteIKPub: bundle.identityKey,
            ephemeralPublicKey,
          };
          sessionEphemeralPublicKey = ephemeralPublicKey;
          await localDb.saveRatchetSession(session);
        }

        const { nextChainKey, messageKey } = await kdfStep(session.sendingChainKey, 'send');
        session.sendingChainKey = nextChainKey;
        await localDb.saveRatchetSession(session);

        const { ciphertext, iv } = await encryptSymmetric(content.trim(), messageKey);
        encryptedPayloads[bundle.deviceId] = {
          ciphertext,
          iv,
          ephemeralPublicKey: sessionEphemeralPublicKey,
        };
      }
    } catch (err) {
      console.error('Failed to encrypt E2EE message payloads:', err);
      return;
    }

    const tempMessage: Message = {
      id: clientUuid,
      conversationId: activeConversationId,
      senderId: currentUserId,
      content: content.trim(),
      sequenceId: Date.now(),
      createdAt: new Date().toISOString(),
      status: 'sent',
      isPending: true,
      encryptedPayloads,
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
          content: '[Encrypted Message]',
          encryptedPayloads,
        },
      }));
    }
  }, [activeConversationId, currentUserId, localDeviceId, deviceKeys]);

  // Edit E2EE Message
  const editMessage = useCallback(async (messageId: string, content: string) => {
    if (!activeConversationId || !localDeviceId || !deviceKeys || !content.trim()) return;

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
  }, [activeConversationId, localDeviceId, deviceKeys]);

  // Toggle Microphone
  const toggleMic = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicMuted(!audioTrack.enabled);
      }
    }
  }, []);

  // Toggle Camera
  const toggleCam = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCamMuted(!videoTrack.enabled);
      }
    }
  }, []);

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
    editMessage,
    startConversation,
    refreshConversations: () => accessToken && fetchConversations(accessToken),

    // WebRTC Exports
    callState,
    activeCallConversationId,
    callQuality,
    localStream,
    remoteStream,
    isMicMuted,
    isCamMuted,
    startCall,
    acceptCall,
    rejectCall,
    hangupCall,
    toggleMic,
    toggleCam,
  };
}
