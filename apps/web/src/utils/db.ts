import type { Message, Conversation } from '@convo/shared';

const DB_NAME = 'convo_db';
const DB_VERSION = 3; // v3: clear ratchet sessions after kdfStep label fix

class LocalDbManager {
  private db: IDBDatabase | null = null;

  // Initialize DB and create object stores
  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) return resolve();

      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('IndexedDB open error:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const database = request.result;
        const oldVersion = event.oldVersion;

        if (!database.objectStoreNames.contains('conversations')) {
          database.createObjectStore('conversations', { keyPath: 'id' });
        }
        
        if (!database.objectStoreNames.contains('messages')) {
          const messageStore = database.createObjectStore('messages', { keyPath: 'id' });
          messageStore.createIndex('conversationId', 'conversationId', { unique: false });
          messageStore.createIndex('sequenceId', 'sequenceId', { unique: false });
        }

        // Create E2EE Device keys object store
        if (!database.objectStoreNames.contains('device_keys')) {
          database.createObjectStore('device_keys', { keyPath: 'id' });
        }

        // v3: Wipe and recreate ratchet_sessions — old sessions used broken kdfStep labels
        // and cannot decrypt correctly. Force fresh key agreement on next message.
        if (oldVersion < 3 && database.objectStoreNames.contains('ratchet_sessions')) {
          database.deleteObjectStore('ratchet_sessions');
        }
        if (!database.objectStoreNames.contains('ratchet_sessions')) {
          database.createObjectStore('ratchet_sessions', { keyPath: 'sessionId' });
        }
      };
    });
  }

  private getStore(
    storeName: 'conversations' | 'messages' | 'device_keys' | 'ratchet_sessions',
    mode: IDBTransactionMode
  ): IDBObjectStore {
    if (!this.db) throw new Error('Database not initialized');
    const transaction = this.db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  }

  // CONVERSATIONS
  saveConversation(conv: Conversation): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('conversations', 'readwrite');
        const request = store.put(conv);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  saveConversations(convs: Conversation[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (convs.length === 0) return resolve();
      try {
        if (!this.db) throw new Error('Database not initialized');
        const transaction = this.db.transaction('conversations', 'readwrite');
        const store = transaction.objectStore('conversations');

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);

        for (const conv of convs) {
          store.put(conv);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  getConversations(): Promise<Conversation[]> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('conversations', 'readonly');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // MESSAGES
  saveMessage(msg: Message): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('messages', 'readwrite');
        const request = store.put(msg);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  saveMessages(msgs: Message[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (msgs.length === 0) return resolve();
      try {
        if (!this.db) throw new Error('Database not initialized');
        const transaction = this.db.transaction('messages', 'readwrite');
        const store = transaction.objectStore('messages');

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);

        for (const msg of msgs) {
          store.put(msg);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  getMessagesForConversation(conversationId: string): Promise<Message[]> {
    return new Promise((resolve, reject) => {
      try {
        if (!this.db) throw new Error('Database not initialized');
        const transaction = this.db.transaction('messages', 'readonly');
        const store = transaction.objectStore('messages');
        const index = store.index('conversationId');
        
        const request = index.getAll(IDBKeyRange.only(conversationId));
        request.onsuccess = () => {
          const list = request.result || [];
          list.sort((a, b) => a.sequenceId - b.sequenceId);
          resolve(list);
        };
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  getMessage(id: string): Promise<Message | null> {
    return new Promise((resolve, reject) => {
      try {
        if (!this.db) throw new Error('Database not initialized');
        const transaction = this.db.transaction('messages', 'readonly');
        const store = transaction.objectStore('messages');
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  getUnsentMessages(): Promise<Message[]> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('messages', 'readonly');
        const request = store.getAll();
        request.onsuccess = () => {
          const list: Message[] = request.result || [];
          const unsent = list.filter((m) => m.isPending || m.status === 'sent' && m.sequenceId > 1e11);
          resolve(unsent);
        };
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // E2EE KEYS
  saveDeviceKeys(bundle: {
    id: string;
    deviceId: string;
    ik: { privateKey: CryptoKey; publicKey: CryptoKey };
    spk: { privateKey: CryptoKey; publicKey: CryptoKey };
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('device_keys', 'readwrite');
        const request = store.put(bundle);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  getDeviceKeys(): Promise<{
    id: string;
    deviceId: string;
    ik: { privateKey: CryptoKey; publicKey: CryptoKey };
    spk: { privateKey: CryptoKey; publicKey: CryptoKey };
  } | null> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('device_keys', 'readonly');
        const request = store.get('local_bundle');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // E2EE RATCHET SESSIONS
  saveRatchetSession(session: {
    sessionId: string; // "remoteUserId:remoteDeviceId"
    rootKey: Uint8Array;
    sendingChainKey: Uint8Array;
    receivingChainKey: Uint8Array;
    ephemeralPublicKey?: string;
    remoteIKPub: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('ratchet_sessions', 'readwrite');
        const request = store.put(session);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  getRatchetSession(sessionId: string): Promise<{
    sessionId: string;
    rootKey: Uint8Array;
    sendingChainKey: Uint8Array;
    receivingChainKey: Uint8Array;
    ephemeralPublicKey?: string;
    remoteIKPub: string;
  } | null> {
    return new Promise((resolve, reject) => {
      try {
        const store = this.getStore('ratchet_sessions', 'readonly');
        const request = store.get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  clearMessages(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!this.db) throw new Error('Database not initialized');
        const transaction = this.db.transaction(['messages', 'ratchet_sessions'], 'readwrite');
        transaction.objectStore('messages').clear();
        transaction.objectStore('ratchet_sessions').clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  clearAll(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!this.db) throw new Error('Database not initialized');
        const transaction = this.db.transaction(
          ['conversations', 'messages', 'device_keys', 'ratchet_sessions'],
          'readwrite'
        );
        transaction.objectStore('conversations').clear();
        transaction.objectStore('messages').clear();
        transaction.objectStore('device_keys').clear();
        transaction.objectStore('ratchet_sessions').clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      } catch (err) {
        reject(err);
      }
    });
  }
}

export const localDb = new LocalDbManager();
