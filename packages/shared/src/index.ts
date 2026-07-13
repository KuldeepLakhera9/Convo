export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  otherUser?: User; // In 1:1, the other member
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  sequenceId: number;
  createdAt: string;
  updatedAt?: string; // Optional field indicating when the message was edited
  status: 'sent' | 'delivered' | 'read'; // Added delivery state tracking
  isPending?: boolean; // For client optimistic UI
  isFailed?: boolean;   // For client error UI
  // E2EE properties: mapping deviceId -> ciphertext payload
  encryptedPayloads?: Record<string, any>;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
}

export interface PrekeyRegistration {
  deviceId: string;
  identityKey: string; // SPKI base64
  signedPrekey: string; // SPKI base64
}

export interface PrekeyBundle {
  userId: string;
  deviceId: string;
  identityKey: string; // SPKI base64
  signedPrekey: string; // SPKI base64
}

// WebSocket Event Payloads
export type WsMessage =
  | {
      type: 'send_message';
      payload: {
        id: string; // client-generated UUID for deduplication
        conversationId: string;
        content: string;
        encryptedPayloads?: Record<string, any>;
      };
    }
  | {
      type: 'message_ack';
      payload: {
        tempId: string; // client temp id / UUID
        message: Message; // persisted DB message
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
        messageId?: string;          // update a single message
        upToSequenceId?: number;     // bulk update up to this sequence number
      };
    }
  | {
      type: 'message_status_update';
      payload: {
        conversationId: string;
        status: 'delivered' | 'read';
        messageId?: string;
        upToSequenceId?: number;
        userId: string; // user whose status changed (the recipient of the message)
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
  // WebRTC Video Call Signaling Events
  | {
      type: 'call_user';
      payload: {
        conversationId: string;
        offer: any; // SDP offer data
      };
    }
  | {
      type: 'call_incoming';
      payload: {
        conversationId: string;
        offer: any;
        fromUserId: string;
      };
    }
  | {
      type: 'call_accepted';
      payload: {
        conversationId: string;
        answer: any; // SDP answer data
      };
    }
  | {
      type: 'call_rejected';
      payload: {
        conversationId: string;
      };
    }
  | {
      type: 'call_hangup';
      payload: {
        conversationId: string;
      };
    }
  | {
      type: 'ice_candidate';
      payload: {
        conversationId: string;
        candidate: any;
        toUserId: string;
      };
    }
  | {
      type: 'error';
      payload: {
        message: string;
        tempId?: string;
      };
    };
