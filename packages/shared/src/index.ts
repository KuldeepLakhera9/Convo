export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  otherUser?: User;
}

export interface ReplyPreview {
  id: string;
  content: string;
  senderId: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  sequenceId: number;
  createdAt: string;
  updatedAt?: string;
  status: 'sent' | 'delivered' | 'read';
  isPending?: boolean;
  isFailed?: boolean;
  encryptedPayloads?: Record<string, any>;
  // New fields
  deletedAt?: string;
  replyToId?: string;
  replyTo?: ReplyPreview;        // denormalised preview, populated on client
  isEdited?: boolean;
  reactions?: Record<string, string[]>; // emoji -> userId[]
}

export interface AuthResponse {
  user: User;
  accessToken: string;
}

export interface PrekeyRegistration {
  deviceId: string;
  identityKey: string;
  signedPrekey: string;
}

export interface PrekeyBundle {
  userId: string;
  deviceId: string;
  identityKey: string;
  signedPrekey: string;
}

export interface SearchResult {
  message: Message;
  conversationId: string;
  otherUserEmail: string;
}

// WebSocket Event Payloads
export type WsMessage =
  | {
      type: 'send_message';
      payload: {
        id: string;
        conversationId: string;
        content: string;
        encryptedPayloads?: Record<string, any>;
        replyToId?: string;
      };
    }
  | {
      type: 'message_ack';
      payload: {
        tempId: string;
        message: Message;
      };
    }
  | {
      type: 'new_message';
      payload: Message;
    }
  | {
      type: 'sync_request';
      payload: {
        conversations: {
          conversationId: string;
          lastSequenceId: number;
        }[];
      };
    }
  | {
      type: 'sync_response';
      payload: {
        messages: Message[];
      };
    }
  | {
      type: 'update_status';
      payload: {
        conversationId: string;
        status: 'delivered' | 'read';
        messageId?: string;
        upToSequenceId?: number;
      };
    }
  | {
      type: 'message_status_update';
      payload: {
        conversationId: string;
        status: 'delivered' | 'read';
        messageId?: string;
        upToSequenceId?: number;
        userId: string;
      };
    }
  | {
      type: 'edit_message';
      payload: {
        messageId: string;
        conversationId: string;
        content: string;
      };
    }
  | {
      type: 'message_edited';
      payload: {
        messageId: string;
        conversationId: string;
        content: string;
        updatedAt: string;
      };
    }
  // ── Typing indicators ───────────────────────────────────────────────────────
  | {
      type: 'typing_start';
      payload: { conversationId: string };
    }
  | {
      type: 'typing_stop';
      payload: { conversationId: string };
    }
  | {
      type: 'user_typing';
      payload: { conversationId: string; userId: string; isTyping: boolean };
    }
  // ── Soft delete ─────────────────────────────────────────────────────────────
  | {
      type: 'delete_message';
      payload: { messageId: string; conversationId: string };
    }
  | {
      type: 'message_deleted';
      payload: { messageId: string; conversationId: string; deletedAt: string };
    }
  // ── Reactions ───────────────────────────────────────────────────────────────
  | {
      type: 'reaction_add';
      payload: { messageId: string; conversationId: string; emoji: string };
    }
  | {
      type: 'reaction_remove';
      payload: { messageId: string; conversationId: string; emoji: string };
    }
  | {
      type: 'reaction_update';
      payload: {
        messageId: string;
        conversationId: string;
        reactions: Record<string, string[]>; // emoji -> userId[]
      };
    }
  // ── WebRTC ──────────────────────────────────────────────────────────────────
  | {
      type: 'call_user';
      payload: { conversationId: string; offer: any };
    }
  | {
      type: 'call_incoming';
      payload: { conversationId: string; offer: any; fromUserId: string };
    }
  | {
      type: 'call_accepted';
      payload: { conversationId: string; answer: any };
    }
  | {
      type: 'call_rejected';
      payload: { conversationId: string };
    }
  | {
      type: 'call_hangup';
      payload: { conversationId: string };
    }
  | {
      type: 'ice_candidate';
      payload: { conversationId: string; candidate: any; toUserId: string };
    }
  | {
      type: 'error';
      payload: { message: string; tempId?: string };
    };
