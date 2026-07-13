import { useState, useEffect, useRef, useCallback } from "react";
import type {
  Message,
  Conversation,
  WsMessage,
  PrekeyBundle,
} from "../types/shared";
import { localDb } from "../utils/db";
import {
  generateDeviceKeyPair,
  exportPublicKey,
  x3dhInitiate,
  x3dhReceive,
  encryptSymmetric,
  decryptSymmetric,
} from "../utils/crypto";
import { apiFetch } from "../utils/api";

interface UseChatProps {
  accessToken: string | null;
  currentUserId: string | null;
  onTokenExpired: () => Promise<string | null>;
}

export function useChat({
  accessToken,
  currentUserId,
  onTokenExpired,
}: UseChatProps) {
  // ─── Stable state ────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── E2EE Device credentials ─────────────────────────────────────────────
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [deviceKeys, setDeviceKeys] = useState<{
    ik: { privateKey: CryptoKey; publicKey: CryptoKey };
    spk: { privateKey: CryptoKey; publicKey: CryptoKey };
  } | null>(null);

  // ─── WebRTC UI state (only for rendering) ────────────────────────────────
  const [callState, setCallState] = useState<
    "idle" | "ringing_out" | "ringing_in" | "connected"
  >("idle");
  const [activeCallConversationId, setActiveCallConversationId] = useState<
    string | null
  >(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callQuality, setCallQuality] = useState<
    "good" | "poor" | "disconnected"
  >("disconnected");
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCamMuted, setIsCamMuted] = useState(false);

  // ─── Stable refs (never trigger re-renders, safe to use in connectWs) ────
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);

  // Refs that mirror props/state so callbacks inside connectWs stay stale-free
  const onTokenExpiredRef = useRef(onTokenExpired);
  const accessTokenRef = useRef(accessToken);
  const currentUserIdRef = useRef(currentUserId);
  const activeConversationIdRef = useRef(activeConversationId);
  const localDeviceIdRef = useRef(localDeviceId);
  const deviceKeysRef = useRef(deviceKeys);
  const conversationsRef = useRef<Conversation[]>([]);
  const prekeyBundlesRef = useRef<PrekeyBundle[]>([]);

  // WebRTC refs (mutable, never should trigger connectWs re-creation)
  const callStateRef = useRef<
    "idle" | "ringing_out" | "ringing_in" | "connected"
  >("idle");
  const activeCallConvIdRef = useRef<string | null>(null);
  const callerIdRef = useRef<string | null>(null);
  const callOfferRef = useRef<any | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const callTimeoutRef = useRef<number | null>(null);
  const iceCandidatesQueueRef = useRef<any[]>([]);

  // Keep all refs in sync with their corresponding state/props
  useEffect(() => {
    onTokenExpiredRef.current = onTokenExpired;
  }, [onTokenExpired]);
  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  useEffect(() => {
    localDeviceIdRef.current = localDeviceId;
  }, [localDeviceId]);
  useEffect(() => {
    deviceKeysRef.current = deviceKeys;
  }, [deviceKeys]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Sync call state into refs so WS handler can read current value without dependency
  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);
  useEffect(() => {
    activeCallConvIdRef.current = activeCallConversationId;
  }, [activeCallConversationId]);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const decryptMessage = useCallback(
    async (
      msg: Message,
      devId: string,
      keys: { ik: { privateKey: CryptoKey }; spk: { privateKey: CryptoKey } },
    ): Promise<Message> => {
      if (!msg.encryptedPayloads) return msg;

      const senderDeviceId = msg.encryptedPayloads.senderDeviceId as string;

      // Own sent messages: plaintext is stored locally — never needs decryption
      if (senderDeviceId === devId) {
        const local = await localDb.getMessage(msg.id);
        if (local?.content && local.content !== "[Encrypted Message]") {
          return { ...msg, content: local.content };
        }
      }

      const payload = msg.encryptedPayloads[devId] as {
        ciphertext: string;
        iv: string;
        ephemeralPublicKey: string;
      };
      if (!payload)
        return {
          ...msg,
          content: "🔒 [Encrypted - Keyset unavailable on this device]",
        };

      try {
        // Per-message X3DH: look up sender's public bundle to recompute the shared secret
        let bundle = prekeyBundlesRef.current.find(
          (b) => b.userId === msg.senderId && b.deviceId === senderDeviceId,
        );
        if (!bundle) {
          const token = accessTokenRef.current;
          if (token) {
            const res = await fetch(
              `/api/chat/conversations/${msg.conversationId}/prekeys`,
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            );
            if (res.ok) {
              const fetched: PrekeyBundle[] = await res.json();
              prekeyBundlesRef.current = fetched;
              bundle = fetched.find(
                (b) =>
                  b.userId === msg.senderId && b.deviceId === senderDeviceId,
              );
            }
          }
        }
        if (!bundle)
          return {
            ...msg,
            content: "🔒 [Encrypted - Sender key bundle not found]",
          };

        // Derive the SAME message key the sender used — no session state required
        const messageKey = await x3dhReceive(
          keys.ik,
          keys.spk,
          bundle.identityKey, // sender's identity public key
          payload.ephemeralPublicKey, // fresh EK the sender included in this message
        );
        const plaintext = await decryptSymmetric(
          payload.ciphertext,
          payload.iv,
          messageKey,
        );
        return { ...msg, content: plaintext };
      } catch (err) {
        console.error("Decryption failed:", err);
        return { ...msg, content: "🔒 [Decryption failed]" };
      }
    },
    [],
  ); // stable — uses only refs and pure crypto functions

  const updateLocalMessageStatus = useCallback(
    async (
      conversationId: string,
      status: "delivered" | "read",
      senderId?: string,
      upToSequenceId?: number,
      messageId?: string,
    ) => {
      setMessages((prev) => {
        const list = prev[conversationId] || [];
        const updatedList = list.map((msg) => {
          const matchId = messageId ? msg.id === messageId : true;
          const matchSender = senderId ? msg.senderId === senderId : true;
          const matchSeq = upToSequenceId
            ? msg.sequenceId <= upToSequenceId
            : true;

          if (matchId && matchSender && matchSeq) {
            const cur = msg.status || "sent";
            if (
              (cur === "sent" &&
                (status === "delivered" || status === "read")) ||
              (cur === "delivered" && status === "read")
            ) {
              const updated = { ...msg, status };
              localDb.saveMessage(updated);
              return updated;
            }
          }
          return msg;
        });
        return { ...prev, [conversationId]: updatedList };
      });
    },
    [],
  );

  const sendStatusUpdate = useCallback(
    (
      conversationId: string,
      status: "delivered" | "read",
      messageId?: string,
      upToSequenceId?: number,
    ) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "update_status",
            payload: { conversationId, status, messageId, upToSequenceId },
          }),
        );
      }
    },
    [],
  );

  // ─── WebRTC call teardown (stable — only uses refs) ──────────────────────

  const resetCallState = useCallback(() => {
    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    iceCandidatesQueueRef.current = [];
    callerIdRef.current = null;
    callOfferRef.current = null;
    callStateRef.current = "idle";
    activeCallConvIdRef.current = null;
    setCallState("idle");
    setActiveCallConversationId(null);
    setLocalStream(null);
    setRemoteStream(null);
    setCallQuality("disconnected");
    setIsMicMuted(false);
    setIsCamMuted(false);
  }, []);

  // ─── Call actions (stable — use refs for current values) ─────────────────

  const rejectCall = useCallback(() => {
    const convId = activeCallConvIdRef.current;
    if (convId && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "call_rejected",
          payload: { conversationId: convId },
        }),
      );
    }
    resetCallState();
  }, [resetCallState]);

  const hangupCall = useCallback(() => {
    const convId = activeCallConvIdRef.current;
    if (convId && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "call_hangup",
          payload: { conversationId: convId },
        }),
      );
    }
    resetCallState();
  }, [resetCallState]);

  const acceptCall = useCallback(async () => {
    if (
      callStateRef.current !== "ringing_in" ||
      !callOfferRef.current ||
      !activeCallConvIdRef.current
    )
      return;

    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
      peerConnectionRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        if (event.streams?.[0]) {
          remoteStreamRef.current = event.streams[0];
          setRemoteStream(event.streams[0]);
        }
      };

      pc.onicecandidate = (event) => {
        const callerId = callerIdRef.current;
        const convId = activeCallConvIdRef.current;
        if (
          event.candidate &&
          callerId &&
          convId &&
          socketRef.current?.readyState === WebSocket.OPEN
        ) {
          socketRef.current.send(
            JSON.stringify({
              type: "ice_candidate",
              payload: {
                conversationId: convId,
                candidate: event.candidate,
                toUserId: callerId,
              },
            }),
          );
        }
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") setCallQuality("good");
        else if (s === "disconnected") setCallQuality("poor");
        else if (s === "failed" || s === "closed") {
          setCallQuality("disconnected");
          resetCallState();
        }
      };

      await pc.setRemoteDescription(
        new RTCSessionDescription(callOfferRef.current),
      );
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "call_accepted",
            payload: { conversationId: activeCallConvIdRef.current, answer },
          }),
        );
      }

      callStateRef.current = "connected";
      setCallState("connected");

      for (const cand of iceCandidatesQueueRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      iceCandidatesQueueRef.current = [];
    } catch (err) {
      console.error("Failed to accept call:", err);
      resetCallState();
    }
  }, [resetCallState]);

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchConversations = useCallback(async (token: string) => {
    try {
      const res = await apiFetch("/api/chat/conversations", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: Conversation[] = await res.json();
        setConversations(data);
        await localDb.saveConversations(data);
      }
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
    }
  }, []);

  const fetchMessages = useCallback(
    async (conversationId: string, token: string) => {
      const devId = localDeviceIdRef.current;
      const keys = deviceKeysRef.current;
      if (!devId || !keys) return;
      try {
        const res = await fetch(
          `/api/chat/conversations/${conversationId}/messages`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (res.ok) {
          const data: Message[] = await res.json();
          await localDb.saveMessages(data);
          const decrypted = await Promise.all(
            data.map((m) => decryptMessage(m, devId, keys)),
          );
          setMessages((prev) => ({ ...prev, [conversationId]: decrypted }));
        }
      } catch (err) {
        console.error("Failed to fetch messages:", err);
      }
    },
    [decryptMessage],
  );

  const fetchPrekeyBundles = useCallback(
    async (convId: string, token: string) => {
      try {
        const res = await fetch(`/api/chat/conversations/${convId}/prekeys`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const bundles: PrekeyBundle[] = await res.json();
          prekeyBundlesRef.current = bundles;
        }
      } catch (err) {
        console.error("Failed to fetch prekey bundles:", err);
      }
    },
    [],
  );

  // ─── E2EE Initialization (once on login) ─────────────────────────────────

  useEffect(() => {
    if (!currentUserId) return;
    const init = async () => {
      try {
        await localDb.init();

        // ── Crypto scheme version guard ──────────────────────────────────────
        // When we change the encryption scheme (e.g. kdfStep → per-message X3DH),
        // locally cached ciphertext is incompatible. Clear messages so they are
        // re-fetched from the server and decrypted with the new scheme.
        const CRYPTO_VERSION = "v4-per-message-x3dh";
        const storedVersion = localStorage.getItem("convo_crypto_version");
        if (storedVersion !== CRYPTO_VERSION) {
          await localDb.clearMessages(); // wipe only messages, keep device keys
          localStorage.setItem("convo_crypto_version", CRYPTO_VERSION);
        }

        let keysBundle = await localDb.getDeviceKeys();
        let devId = keysBundle?.deviceId ?? window.crypto.randomUUID();

        if (!keysBundle) {
          const { ik, spk } = await generateDeviceKeyPair();
          keysBundle = { id: "local_bundle", deviceId: devId, ik, spk };
          await localDb.saveDeviceKeys(keysBundle);
        }

        setLocalDeviceId(devId);
        setDeviceKeys(keysBundle);
        localDeviceIdRef.current = devId;
        deviceKeysRef.current = keysBundle;

        const cachedConvs = await localDb.getConversations();
        setConversations(cachedConvs);

        const messagesMap: Record<string, Message[]> = {};
        for (const conv of cachedConvs) {
          const cached = await localDb.getMessagesForConversation(conv.id);
          messagesMap[conv.id] = await Promise.all(
            cached.map((m) => decryptMessage(m, devId, keysBundle!)),
          );
        }
        setMessages(messagesMap);
      } catch (err) {
        console.error("E2EE init failed:", err);
      }
    };
    init();
  }, [currentUserId, decryptMessage]);

  // ─── Register prekeys ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!accessToken || !localDeviceId || !deviceKeys) return;
    const register = async () => {
      try {
        const ikPub = await exportPublicKey(deviceKeys.ik.publicKey);
        const spkPub = await exportPublicKey(deviceKeys.spk.publicKey);
        await apiFetch("/api/chat/prekeys", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            deviceId: localDeviceId,
            identityKey: ikPub,
            signedPrekey: spkPub,
          }),
        });
      } catch (err) {
        console.error("Failed to register prekeys:", err);
      }
    };
    register();
  }, [accessToken, localDeviceId, deviceKeys]);

  // ─── WebSocket (STABLE — empty deps, reads everything via refs) ───────────

  const connectWs = useCallback((tokenToUse: string) => {
    if (socketRef.current) {
      socketRef.current.onclose = null; // prevent reconnect loop on intentional close
      socketRef.current.close();
    }

    // In dev: VITE_API_URL is not set, so use localhost via Vite proxy base
    // In prod: VITE_API_URL is set to the Railway HTTPS URL, switch http→ws and https→wss
    const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3002";
    const wsUrl = apiUrl.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}?token=${tokenToUse}`);
    socketRef.current = ws;

    ws.onopen = async () => {
      console.log("WebSocket connected");
      setIsConnected(true);
      setError(null);
      reconnectAttempts.current = 0;

      setIsSyncing(true);
      try {
        const cachedConvs = await localDb.getConversations();
        const syncItems = await Promise.all(
          cachedConvs.map(async (conv) => {
            const msgs = await localDb.getMessagesForConversation(conv.id);
            const valid = msgs.filter(
              (m) => m.sequenceId > 0 && m.sequenceId < 1e11,
            );
            const lastSeq =
              valid.length > 0
                ? Math.max(...valid.map((m) => m.sequenceId))
                : 0;
            return { conversationId: conv.id, lastSequenceId: lastSeq };
          }),
        );
        ws.send(
          JSON.stringify({
            type: "sync_request",
            payload: { conversations: syncItems },
          }),
        );

        const unsent = await localDb.getUnsentMessages();
        for (const m of unsent) {
          ws.send(
            JSON.stringify({
              type: "send_message",
              payload: {
                id: m.id,
                conversationId: m.conversationId,
                content: m.content,
                encryptedPayloads: m.encryptedPayloads,
              },
            }),
          );
        }
      } finally {
        setIsSyncing(false);
      }
    };

    ws.onmessage = async (event) => {
      // Read current values from refs — NO state dependencies here
      const devId = localDeviceIdRef.current;
      const keys = deviceKeysRef.current;
      const userId = currentUserIdRef.current;
      const activeConvId = activeConversationIdRef.current;

      if (!devId || !keys) return;

      try {
        const wsMsg: WsMessage = JSON.parse(event.data);

        if (wsMsg.type === "message_ack") {
          const { tempId, message } = wsMsg.payload;
          await localDb.saveMessage(message);
          const decrypted = await decryptMessage(message, devId, keys);
          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            return {
              ...prev,
              [message.conversationId]: list.map((m) =>
                m.id === tempId ? { ...decrypted, isPending: false } : m,
              ),
            };
          });
        } else if (wsMsg.type === "new_message") {
          const message = wsMsg.payload;
          await localDb.saveMessage(message);
          const decrypted = await decryptMessage(message, devId, keys);

          setMessages((prev) => {
            const list = prev[message.conversationId] || [];
            if (list.some((m) => m.id === message.id)) return prev;
            return {
              ...prev,
              [message.conversationId]: [...list, decrypted].sort(
                (a, b) => a.sequenceId - b.sequenceId,
              ),
            };
          });

          const isActive = message.conversationId === activeConvId;
          const targetStatus = isActive ? "read" : "delivered";
          sendStatusUpdate(
            message.conversationId,
            targetStatus,
            undefined,
            message.sequenceId,
          );
          await updateLocalMessageStatus(
            message.conversationId,
            targetStatus,
            message.senderId,
            message.sequenceId,
          );
        } else if (wsMsg.type === "sync_response") {
          const { messages: replayed } = wsMsg.payload;
          if (replayed.length === 0) return;
          await localDb.saveMessages(replayed);

          const groups: Record<string, Message[]> = {};
          for (const msg of replayed) {
            if (!groups[msg.conversationId]) groups[msg.conversationId] = [];
            groups[msg.conversationId].push(msg);
          }

          for (const [convId, list] of Object.entries(groups)) {
            const decryptedList = await Promise.all(
              list.map((m) => decryptMessage(m, devId, keys)),
            );
            setMessages((prev) => {
              const current = prev[convId] || [];
              const merged = [...current];
              for (const m of decryptedList) {
                const idx = merged.findIndex((e) => e.id === m.id);
                if (idx === -1) merged.push(m);
                else merged[idx] = m;
              }
              return {
                ...prev,
                [convId]: merged.sort((a, b) => a.sequenceId - b.sequenceId),
              };
            });

            const received = list.filter((m) => m.senderId !== userId);
            if (received.length > 0) {
              const maxSeq = Math.max(...received.map((m) => m.sequenceId));
              const isActive = convId === activeConvId;
              sendStatusUpdate(
                convId,
                isActive ? "read" : "delivered",
                undefined,
                maxSeq,
              );
              updateLocalMessageStatus(
                convId,
                isActive ? "read" : "delivered",
                undefined,
                maxSeq,
              );
            }
          }
        } else if (wsMsg.type === "message_status_update") {
          const { conversationId, status, messageId, upToSequenceId } =
            wsMsg.payload;
          await updateLocalMessageStatus(
            conversationId,
            status,
            undefined,
            upToSequenceId,
            messageId,
          );
        } else if (wsMsg.type === "message_edited") {
          const { messageId, conversationId, content } = wsMsg.payload;
          setMessages((prev) => {
            const list = (prev[conversationId] || []).map((m) =>
              m.id === messageId ? { ...m, content } : m,
            );
            const edited = list.find((m) => m.id === messageId);
            if (edited) localDb.saveMessage(edited);
            return { ...prev, [conversationId]: list };
          });

          // ── WebRTC signaling ───────────────────────────────────────────────
        } else if (wsMsg.type === "call_incoming") {
          const { conversationId, offer, fromUserId } = wsMsg.payload;
          callStateRef.current = "ringing_in";
          callerIdRef.current = fromUserId;
          callOfferRef.current = offer;
          activeCallConvIdRef.current = conversationId;
          setCallState("ringing_in");
          setActiveCallConversationId(conversationId);

          callTimeoutRef.current = window.setTimeout(() => {
            rejectCall();
          }, 30000);
        } else if (wsMsg.type === "call_accepted") {
          const { answer } = wsMsg.payload;
          if (callTimeoutRef.current) {
            clearTimeout(callTimeoutRef.current);
            callTimeoutRef.current = null;
          }
          if (peerConnectionRef.current) {
            await peerConnectionRef.current.setRemoteDescription(
              new RTCSessionDescription(answer),
            );
            callStateRef.current = "connected";
            setCallState("connected");
            for (const cand of iceCandidatesQueueRef.current) {
              await peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate(cand),
              );
            }
            iceCandidatesQueueRef.current = [];
          }
        } else if (wsMsg.type === "call_rejected") {
          setError("Call was declined");
          setTimeout(() => setError(null), 4000);
          resetCallState();
        } else if (wsMsg.type === "call_hangup") {
          resetCallState();
        } else if (wsMsg.type === "ice_candidate") {
          const { candidate } = wsMsg.payload;
          const pc = peerConnectionRef.current;
          if (pc?.remoteDescription)
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          else iceCandidatesQueueRef.current.push(candidate);
        } else if (wsMsg.type === "error") {
          const { message, tempId } = wsMsg.payload;
          setError(message);
          setTimeout(() => setError(null), 4000);
          if (tempId) {
            setMessages((prev) => {
              for (const convId of Object.keys(prev)) {
                const list = prev[convId];
                if (list.some((m) => m.id === tempId)) {
                  return {
                    ...prev,
                    [convId]: list.map((m) =>
                      m.id === tempId
                        ? { ...m, isPending: false, isFailed: true }
                        : m,
                    ),
                  };
                }
              }
              return prev;
            });
          }
        }
      } catch (err) {
        console.error("WS message error:", err);
      }
    };

    ws.onclose = async () => {
      console.log("WebSocket disconnected");
      setIsConnected(false);
      const token = accessTokenRef.current;
      if (token) {
        const delay =
          Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000) +
          Math.random() * 500;
        reconnectAttempts.current++;
        reconnectTimeoutRef.current = window.setTimeout(async () => {
          const fresh = await onTokenExpiredRef.current();
          if (fresh) connectWs(fresh);
        }, delay);
      }
    };

    ws.onerror = (err) => console.error("WS error:", err);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← intentionally empty: all dynamic values are read via refs

  // ─── Mount / unmount effect (stable — connectWs is now stable) ───────────

  useEffect(() => {
    if (accessToken) {
      fetchConversations(accessToken);
      connectWs(accessToken);
    } else {
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
      }
      setIsConnected(false);
      setConversations([]);
      setMessages({});
      localDb.clearAll();
    }
    return () => {
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
      }
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      if (localStreamRef.current)
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      if (peerConnectionRef.current) peerConnectionRef.current.close();
    };
    // connectWs is stable (empty deps), fetchConversations is stable
  }, [accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Active conversation change: fetch prekeys + messages, send read ──────

  useEffect(() => {
    if (!activeConversationId || !accessToken) return;
    const token = accessToken;
    const convId = activeConversationId;

    fetchPrekeyBundles(convId, token);
    fetchMessages(convId, token);

    setMessages((prev) => {
      const list = prev[convId] || [];
      const unread = list.filter(
        (m) => m.senderId !== currentUserId && m.status !== "read",
      );
      if (unread.length > 0) {
        const maxSeq = Math.max(...unread.map((m) => m.sequenceId));
        sendStatusUpdate(convId, "read", undefined, maxSeq);
        updateLocalMessageStatus(
          convId,
          "read",
          currentUserId ?? undefined,
          maxSeq,
        );
      }
      return prev;
    });
  }, [
    activeConversationId,
    accessToken,
    currentUserId,
    fetchMessages,
    fetchPrekeyBundles,
    sendStatusUpdate,
    updateLocalMessageStatus,
  ]);

  // ─── startCall (stable — reads call state via ref) ───────────────────────

  const startCall = useCallback(
    async (conversationId: string) => {
      if (callStateRef.current !== "idle") return;

      callStateRef.current = "ringing_out";
      activeCallConvIdRef.current = conversationId;
      setCallState("ringing_out");
      setActiveCallConversationId(conversationId);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        setLocalStream(stream);

        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
          ],
        });
        peerConnectionRef.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        pc.ontrack = (event) => {
          if (event.streams?.[0]) {
            remoteStreamRef.current = event.streams[0];
            setRemoteStream(event.streams[0]);
          }
        };

        pc.onicecandidate = (event) => {
          const convs = conversationsRef.current;
          const other = convs.find((c) => c.id === conversationId)?.otherUser;
          if (
            event.candidate &&
            other &&
            socketRef.current?.readyState === WebSocket.OPEN
          ) {
            socketRef.current.send(
              JSON.stringify({
                type: "ice_candidate",
                payload: {
                  conversationId,
                  candidate: event.candidate,
                  toUserId: other.id,
                },
              }),
            );
          }
        };

        pc.oniceconnectionstatechange = () => {
          const s = pc.iceConnectionState;
          if (s === "connected" || s === "completed") setCallQuality("good");
          else if (s === "disconnected") setCallQuality("poor");
          else if (s === "failed" || s === "closed") {
            setCallQuality("disconnected");
            resetCallState();
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(
            JSON.stringify({
              type: "call_user",
              payload: { conversationId, offer },
            }),
          );
        }

        callTimeoutRef.current = window.setTimeout(() => {
          hangupCall();
        }, 30000);
      } catch (err) {
        console.error("Failed to start call:", err);
        resetCallState();
      }
    },
    [resetCallState, hangupCall],
  );

  // ─── Messaging ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (content: string) => {
    const convId = activeConversationIdRef.current;
    const userId = currentUserIdRef.current;
    const devId = localDeviceIdRef.current;
    const keys = deviceKeysRef.current;
    const token = accessTokenRef.current;
    if (!convId || !userId || !devId || !keys || !token || !content.trim())
      return;

    // ── Eagerly fetch prekey bundles if the ref is stale/empty ──────────────
    if (prekeyBundlesRef.current.length === 0) {
      try {
        const res = await fetch(`/api/chat/conversations/${convId}/prekeys`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          prekeyBundlesRef.current = await res.json();
        }
      } catch (err) {
        console.error("Failed to fetch prekeys before send:", err);
      }
    }

    const clientUuid = window.crypto.randomUUID();
    const encryptedPayloads: Record<string, any> = { senderDeviceId: devId };

    try {
      // Per-message X3DH: fresh ephemeral key for every device for every message.
      // Each entry in encryptedPayloads is independently decryptable — no chain state.
      for (const bundle of prekeyBundlesRef.current) {
        const { messageKey, ephemeralPublicKey } = await x3dhInitiate(
          keys.ik,
          bundle.identityKey,
          bundle.signedPrekey,
        );
        const { ciphertext, iv } = await encryptSymmetric(
          content.trim(),
          messageKey,
        );
        encryptedPayloads[bundle.deviceId] = {
          ciphertext,
          iv,
          ephemeralPublicKey,
        };
      }
    } catch (err) {
      console.error("Encryption failed:", err);
      return;
    }

    // Store plaintext locally for the sender's own display — the server only
    // ever sees '[Encrypted Message]'.
    const tempMessage: Message = {
      id: clientUuid,
      conversationId: convId,
      senderId: userId,
      content: content.trim(), // ← plaintext, stored locally only
      sequenceId: Date.now(),
      createdAt: new Date().toISOString(),
      status: "sent",
      isPending: true,
      encryptedPayloads,
    };

    await localDb.saveMessage(tempMessage);
    setMessages((prev) => ({
      ...prev,
      [convId]: [...(prev[convId] || []), tempMessage],
    }));

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "send_message",
          // Server only stores ciphertext — plaintext never leaves the device
          payload: {
            id: clientUuid,
            conversationId: convId,
            content: "[Encrypted Message]",
            encryptedPayloads,
          },
        }),
      );
    }
  }, []);

  const editMessage = useCallback(
    async (messageId: string, content: string) => {
      const convId = activeConversationIdRef.current;
      if (!convId || !content.trim()) return;
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "edit_message",
            payload: {
              messageId,
              conversationId: convId,
              content: content.trim(),
            },
          }),
        );
      }
    },
    [],
  );

  // ─── Toggle controls ──────────────────────────────────────────────────────

  const toggleMic = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsMicMuted(!track.enabled);
    }
  }, []);

  const toggleCam = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsCamMuted(!track.enabled);
    }
  }, []);

  // ─── Start Conversation ───────────────────────────────────────────────────

  const startConversation = useCallback(async (otherUserId: string) => {
    const token = accessTokenRef.current;
    if (!token) return;
    try {
      const res = await apiFetch("/api/chat/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ otherUserId }),
      });
      if (res.ok) {
        const newConv: Conversation = await res.json();
        setConversations((prev) =>
          prev.some((c) => c.id === newConv.id) ? prev : [newConv, ...prev],
        );
        await localDb.saveConversation(newConv);
        setActiveConversationId(newConv.id);
        return newConv.id;
      }
    } catch (err) {
      console.error("Failed to start conversation:", err);
    }
  }, []);

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    conversations,
    activeConversationId,
    setActiveConversationId,
    activeMessages: activeConversationId
      ? messages[activeConversationId] || []
      : [],
    isConnected,
    isSyncing,
    error,
    sendMessage,
    editMessage,
    startConversation,
    refreshConversations: () => {
      const t = accessTokenRef.current;
      if (t) fetchConversations(t);
    },

    // WebRTC
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
