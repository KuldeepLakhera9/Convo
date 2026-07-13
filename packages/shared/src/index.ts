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
  status: 'sent' | 'delivered' | 'read'; // Added delivery state tracking
  isPending?: boolean; // For client optimistic UI
  isFailed?: boolean;   // For client error UI
}

export interface AuthResponse {
  user: User;
  accessToken: string;
}

// WebSocket Event Payloads
export type WsMessage =
  | {
      type: 'send_message';
      payload: {
        id: string; // client-generated UUID for deduplication
        conversationId: string;
        content: string;
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
      type: 'error';
      payload: {
        message: string;
        tempId?: string;
      };
    };
