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
        id: string; // client-generated temp id for optimistic UI
        conversationId: string;
        content: string;
      };
    }
  | {
      type: 'message_ack';
      payload: {
        tempId: string; // client temp id
        message: Message; // persisted DB message
      };
    }
  | {
      type: 'new_message';
      payload: Message;
    }
  | {
      type: 'error';
      payload: {
        message: string;
        tempId?: string;
      };
    };
