import React, { useState, useEffect, useRef } from 'react';
import { useChat } from './hooks/useChat';
import {
  MessageSquare,
  Send,
  User,
  LogOut,
  Plus,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Users,
  Hash,
} from 'lucide-react';

function parseJwt(token: string) {
  try {
    return JSON.parse(window.atob(token.split('.')[1]));
  } catch (e) {
    return null;
  }
}

export default function App() {
  // Auth state
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);

  // User search/new conversation list
  const [showUserSearch, setShowUserSearch] = useState(false);
  const [usersList, setUsersList] = useState<{ id: string; email: string }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Messages input
  const [inputMessage, setInputMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Trigger token refresh
  const handleTokenExpired = async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAccessToken(data.accessToken);
        const decoded = parseJwt(data.accessToken);
        if (decoded) {
          const emailValue = localStorage.getItem('userEmail') || 'User';
          setUser({ id: decoded.userId, email: emailValue });
        }
        return data.accessToken;
      } else {
        handleLogoutLocal();
        return null;
      }
    } catch (err) {
      handleLogoutLocal();
      return null;
    }
  };

  // Chat hook
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    activeMessages,
    isConnected,
    sendMessage,
    startConversation,
  } = useChat({
    accessToken,
    currentUserId: user?.id || null,
    onTokenExpired: handleTokenExpired,
  });

  const handleLogoutLocal = () => {
    setUser(null);
    setAccessToken(null);
    localStorage.removeItem('userEmail');
  };

  // Silent refresh on boot
  useEffect(() => {
    const checkAuthOnBoot = async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setAccessToken(data.accessToken);
          const decoded = parseJwt(data.accessToken);
          if (decoded) {
            const savedEmail = localStorage.getItem('userEmail') || 'User';
            setUser({ id: decoded.userId, email: savedEmail });
          }
        }
      } catch (err) {
        console.log('No existing session.');
      } finally {
        setBootLoading(false);
      }
    };
    checkAuthOnBoot();
  }, []);

  // Set up refresh interval (every 14 minutes)
  useEffect(() => {
    if (!accessToken) return;
    const interval = setInterval(() => {
      console.log('Triggering silent JWT token refresh...');
      handleTokenExpired();
    }, 14 * 60 * 1000); // 14 mins

    return () => clearInterval(interval);
  }, [accessToken]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages]);

  // Fetch users for start conversation dialog
  const handleOpenUserSearch = async () => {
    if (!accessToken) return;
    setShowUserSearch(true);
    setSearchLoading(true);
    try {
      const res = await fetch('/api/chat/users', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUsersList(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSearchLoading(false);
    }
  };

  // Handle Authentication submit
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setAuthError('All fields are required');
      return;
    }
    setAuthError(null);
    setAuthLoading(true);

    const urlPath = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';

    try {
      const res = await fetch(urlPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setAuthError(data.error || 'Authentication failed');
        setAuthLoading(false);
        return;
      }

      if (authMode === 'login') {
        setUser(data.user);
        setAccessToken(data.accessToken);
        localStorage.setItem('userEmail', data.user.email);
        setEmail('');
        setPassword('');
      } else {
        // For register, toggle to login page after successful registration
        setAuthMode('login');
        setAuthError('Registration successful! Please log in.');
      }
    } catch (err) {
      setAuthError('Network error. Check backend connection.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error(err);
    } finally {
      handleLogoutLocal();
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;
    sendMessage(inputMessage);
    setInputMessage('');
  };

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  if (bootLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-indigo-500" />
          <p className="text-sm text-slate-400 font-medium tracking-wide">Initializing secure session...</p>
        </div>
      </div>
    );
  }

  // AUTH SCREEN
  if (!user || !accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#090d16] px-4">
        <div className="w-full max-w-md rounded-2xl glass-panel p-8 shadow-2xl transition-all duration-300">
          <div className="flex flex-col items-center mb-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-600/30 mb-3">
              <MessageSquare className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white m-0">Convo</h1>
            <p className="text-slate-400 text-xs mt-1">Real-time gapless message delivery</p>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-5">
            {authError && (
              <div className={`p-3 rounded-lg flex items-start gap-2.5 text-xs ${
                authError.includes('successful')
                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}>
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg bg-slate-900/50 border border-slate-700/50 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg bg-slate-900/50 border border-slate-700/50 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={authLoading}
              className="w-full flex justify-center items-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 transition-all cursor-pointer shadow-lg shadow-indigo-600/20"
            >
              {authLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : authMode === 'login' ? (
                'Sign In'
              ) : (
                'Create Account'
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => {
                setAuthMode(authMode === 'login' ? 'register' : 'login');
                setAuthError(null);
              }}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors cursor-pointer"
            >
              {authMode === 'login'
                ? "Don't have an account? Sign up"
                : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // MAIN DASHBOARD SCREEN
  return (
    <div className="flex h-screen w-screen bg-[#070b13] overflow-hidden">
      {/* LEFT SIDEBAR: Conversations List */}
      <aside className="w-80 border-r border-slate-800/60 bg-slate-950/40 flex flex-col shrink-0">
        {/* Sidebar Header */}
        <div className="h-16 border-b border-slate-800/60 flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-600/10">
              <MessageSquare className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-md text-white tracking-wide">Convo</span>
          </div>

          <button
            onClick={handleOpenUserSearch}
            title="New Chat"
            className="h-8 w-8 rounded-lg bg-slate-800/40 hover:bg-indigo-600 hover:text-white border border-slate-800 flex items-center justify-center text-slate-300 transition-all cursor-pointer"
          >
            <Plus className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* User Search Dialog overlay */}
        {showUserSearch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-xl glass-panel p-5 shadow-2xl">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-white flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4 text-indigo-400" /> Start a New Chat
                </h3>
                <button
                  onClick={() => setShowUserSearch(false)}
                  className="text-xs text-slate-400 hover:text-white cursor-pointer"
                >
                  Close
                </button>
              </div>

              {searchLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                </div>
              ) : usersList.length === 0 ? (
                <p className="text-center text-xs text-slate-400 py-6">No other users found on the server.</p>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
                  {usersList.map((usr) => (
                    <button
                      key={usr.id}
                      onClick={async () => {
                        const cid = await startConversation(usr.id);
                        if (cid) {
                          setActiveConversationId(cid);
                        }
                        setShowUserSearch(false);
                      }}
                      className="w-full flex items-center gap-2.5 rounded-lg bg-slate-900/40 hover:bg-indigo-600/30 border border-slate-800/50 p-2.5 text-left text-xs transition-colors cursor-pointer text-slate-200"
                    >
                      <div className="h-6 w-6 rounded-full bg-slate-800 flex items-center justify-center shrink-0">
                        <User className="h-3 w-3 text-indigo-400" />
                      </div>
                      <span className="truncate">{usr.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {conversations.length === 0 ? (
            <div className="h-full flex flex-col justify-center items-center text-center p-4">
              <MessageSquare className="h-8 w-8 text-slate-700 mb-2" />
              <p className="text-xs text-slate-500">No active conversations</p>
              <button
                onClick={handleOpenUserSearch}
                className="mt-3 text-xs bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 border border-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
              >
                Find users
              </button>
            </div>
          ) : (
            conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              return (
                <button
                  key={conv.id}
                  onClick={() => setActiveConversationId(conv.id)}
                  className={`w-full flex items-center gap-3 rounded-xl p-3 text-left transition-all cursor-pointer border ${
                    isActive
                      ? 'bg-indigo-600/15 border-indigo-500/30 shadow-inner'
                      : 'bg-slate-900/10 hover:bg-slate-900/30 border-transparent'
                  }`}
                >
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
                    isActive ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                  }`}>
                    <User className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-100 truncate">
                      {conv.otherUser?.email}
                    </p>
                    <p className="text-[10px] text-slate-500 truncate mt-0.5">
                      Open active discussion
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Sidebar Footer (Profile Info & Logout) */}
        <div className="h-16 border-t border-slate-800/60 bg-slate-950/60 flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-7 w-7 rounded-full bg-slate-800 flex items-center justify-center shrink-0 border border-slate-700/50">
              <User className="h-3.5 w-3.5 text-indigo-400" />
            </div>
            <span className="text-xs text-slate-300 truncate font-medium">{user.email}</span>
          </div>

          <button
            onClick={handleLogout}
            title="Sign Out"
            className="h-8 w-8 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center transition-colors cursor-pointer"
          >
            <LogOut className="h-4.5 w-4.5" />
          </button>
        </div>
      </aside>

      {/* RIGHT ACTIVE CHAT VIEW */}
      <main className="flex-1 flex flex-col bg-slate-950/10 relative">
        {activeConversation ? (
          <>
            {/* Chat Pane Header */}
            <header className="h-16 border-b border-slate-800/60 px-6 flex items-center justify-between shrink-0 glass-panel-light">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 border border-slate-700">
                  <User className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white m-0 leading-tight">
                    {activeConversation.otherUser?.email}
                  </h2>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse-subtle'}`} />
                    <span className="text-[10px] text-slate-400">
                      {isConnected ? 'connected' : 'connecting...'}
                    </span>
                  </div>
                </div>
              </div>
            </header>

            {/* Messages Viewport */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3.5">
              {activeMessages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="p-3 rounded-full bg-slate-900 border border-slate-800/50 mb-3">
                    <MessageSquare className="h-6 w-6 text-slate-500" />
                  </div>
                  <h3 className="text-sm font-semibold text-slate-300">Start of conversation</h3>
                  <p className="text-xs text-slate-500 mt-1">Send a message to begin discussing.</p>
                </div>
              ) : (
                activeMessages.map((msg) => {
                  const isMe = msg.senderId === user.id;
                  const isPending = msg.isPending;
                  const isFailed = msg.isFailed;

                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isMe ? 'justify-end' : 'justify-start'} group`}
                    >
                      <div
                        className={`max-w-[70%] rounded-xl px-4 py-2.5 border shadow-sm transition-all duration-200 ${
                          isMe
                            ? `bg-slate-900/80 border-indigo-500/20 text-white ${
                                isPending ? 'opacity-55 scale-[0.98]' : ''
                              } ${isFailed ? 'border-red-500/40 bg-red-950/20' : ''}`
                            : 'bg-indigo-950/30 border-white/5 text-slate-100'
                        }`}
                      >
                        <p className="text-xs break-words whitespace-pre-wrap">{msg.content}</p>

                        <div className="flex items-center justify-end gap-2.5 mt-1.5">
                          {/* Display database message sequence ID */}
                          <span className="text-[9px] text-slate-500 font-mono flex items-center gap-0.5">
                            <Hash className="h-2 w-2 shrink-0" />
                            {msg.sequenceId > 0 && msg.sequenceId < 1e11 ? msg.sequenceId : '...'}
                          </span>

                          <span className="text-[9px] text-slate-500">
                            {new Date(msg.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>

                          {/* Message status icon */}
                          {isMe && (
                            <span className="flex items-center">
                              {isPending ? (
                                <Loader2 className="h-2.5 w-2.5 animate-spin text-indigo-400" />
                              ) : isFailed ? (
                                <AlertCircle className="h-2.5 w-2.5 text-red-400" />
                              ) : (
                                <CheckCircle2 className="h-2.5 w-2.5 text-indigo-400" />
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message input */}
            <div className="p-4 border-t border-slate-800/60 glass-panel-light shrink-0">
              <form onSubmit={handleSend} className="flex gap-2 max-w-4xl mx-auto">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 rounded-xl bg-slate-900/50 border border-slate-800/80 px-4 py-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                <button
                  type="submit"
                  disabled={!inputMessage.trim()}
                  className="h-10 w-10 shrink-0 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-all cursor-pointer disabled:opacity-40 disabled:hover:bg-indigo-600 shadow-md shadow-indigo-600/15"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            </div>
          </>
        ) : (
          /* Empty Chat state */
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <div className="h-14 w-14 rounded-2xl bg-slate-900 border border-slate-850 flex items-center justify-center shadow-lg shadow-black/10 mb-4">
              <MessageSquare className="h-7 w-7 text-indigo-400" />
            </div>
            <h2 className="text-md font-semibold text-slate-200 m-0">No active thread</h2>
            <p className="text-xs text-slate-500 max-w-sm mt-1.5 leading-relaxed">
              Select an existing contact from the left panel, or start a new conversation to begin secure messaging.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
