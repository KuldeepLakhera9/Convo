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
  Search,
  Settings,
  Bell,
  Phone,
  Video,
  Pin,
  Users,
  Paperclip,
  ChevronDown,
  ChevronUp,
  Image,
  Link2,
  FileText,
  Check,
  CheckCheck,
  WifiOff,
  Edit2,
  X,
  Shield,
  PhoneCall,
  PhoneOff,
  Mic,
  MicOff,
  VideoOff,
  Volume2,
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
  const [searchQuery, setSearchQuery] = useState('');

  // Right sidebar details toggle
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  const [linksOpen, setLinksOpen] = useState(false);

  // Messages input
  const [inputMessage, setInputMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Message Editing state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Video streams HTML elements references
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

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

  // Chat and Calling hooks
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    activeMessages,
    isConnected,
    isSyncing,
    error: wsError,
    sendMessage,
    editMessage,
    startConversation,

    // WebRTC calling hook bindings
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
  } = useChat({
    accessToken,
    currentUserId: user?.id || null,
    onTokenExpired: handleTokenExpired,
  });

  // Bind local stream tracks to local video DOM element
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Bind remote stream tracks to remote video DOM element
  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

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
      handleTokenExpired();
    }, 14 * 60 * 1000);

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

  // Handle Edit submit
  const handleEditSubmit = (e: React.FormEvent, messageId: string) => {
    e.preventDefault();
    if (!editContent.trim()) return;
    editMessage(messageId, editContent);
    setEditingMessageId(null);
  };

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  // Filter conversations based on query
  const filteredConversations = conversations.filter((conv) =>
    conv.otherUser?.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Get initial letters from email
  const getInitials = (email: string) => {
    return email.split('@')[0].substring(0, 2).toUpperCase();
  };

  if (bootLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0c0f] text-slate-100">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 animate-spin text-[#ddfd53]" />
          <p className="text-xs text-slate-400 font-semibold tracking-wider uppercase">Loading Workspace...</p>
        </div>
      </div>
    );
  }

  // AUTH SCREEN
  if (!user || !accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b0c0f] px-4">
        <div className="w-full max-w-md rounded-2xl dribbble-panel p-8 shadow-2xl transition-all duration-300">
          <div className="flex flex-col items-center mb-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#ddfd53] text-[#0b0c0f] shadow-lg shadow-[#ddfd53]/10 mb-3">
              <span className="font-black text-xl">S</span>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white m-0">Sign In to Convo</h1>
            <p className="text-[#989ba2] text-xs mt-1">Enterprise real-time communications</p>
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
              <label className="block text-[10px] font-bold text-[#989ba2] uppercase tracking-wider mb-2">
                Business Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg bg-[#18191e] border border-[#24262d] px-3.5 py-2.5 text-xs text-white placeholder-[#5c5e66] focus:outline-none focus:border-[#ddfd53] transition-colors"
                placeholder="you@domain.com"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#989ba2] uppercase tracking-wider mb-2">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg bg-[#18191e] border border-[#24262d] px-3.5 py-2.5 text-xs text-white placeholder-[#5c5e66] focus:outline-none focus:border-[#ddfd53] transition-colors"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={authLoading}
              className="w-full flex justify-center items-center rounded-lg bg-[#ddfd53] text-[#0b0c0f] font-bold px-4 py-2.5 text-xs hover:bg-[#cbe64c] transition-all cursor-pointer shadow-lg shadow-[#ddfd53]/5"
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
              className="text-xs text-[#ddfd53] hover:underline font-bold transition-colors cursor-pointer"
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
    <div className="flex flex-col h-screen w-screen bg-[#0b0c0f] overflow-hidden p-3 gap-3">
      {/* Dynamic WebSocket/Network alert banners */}
      {!isConnected && (
        <div className="w-full py-2 px-4 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-between text-xs text-amber-400 tracking-wide transition-all duration-300">
          <div className="flex items-center gap-2 font-medium">
            <WifiOff className="h-4 w-4 animate-pulse" />
            <span>Connection lost. Typing messages will queue offline and automatically sync upon reconnecting.</span>
          </div>
          <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/20">
            Offline Mode
          </span>
        </div>
      )}
      
      {isSyncing && (
        <div className="w-full py-2 px-4 rounded-xl bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-between text-xs text-indigo-400 tracking-wide transition-all duration-300">
          <div className="flex items-center gap-2 font-medium">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Synchronizing history and replaying missed messages...</span>
          </div>
        </div>
      )}

      {wsError && (
        <div className="w-full py-2 px-4 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center gap-2 text-xs text-red-400 tracking-wide transition-all duration-300">
          <AlertCircle className="h-4 w-4" />
          <span>{wsError}</span>
        </div>
      )}

      {/* Ringing In Overlay Banner */}
      {callState === 'ringing_in' && (
        <div className="w-full p-4 rounded-xl bg-[#ddfd53]/15 border border-[#ddfd53]/35 flex items-center justify-between text-xs text-[#ddfd53] tracking-wide transition-all duration-300">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-[#ddfd53] text-[#0b0c0f] flex items-center justify-center font-bold">
              <PhoneCall className="h-4.5 w-4.5 animate-pulse" />
            </div>
            <div>
              <span className="font-bold block">Incoming Video Call</span>
              <span className="text-[10px] text-slate-300">Active secure call session request</span>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={acceptCall}
              className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-3 py-1.5 rounded-lg transition-colors cursor-pointer text-[10px] flex items-center gap-1"
            >
              <Volume2 className="h-3.5 w-3.5" /> Accept
            </button>
            <button
              onClick={rejectCall}
              className="bg-rose-500 hover:bg-rose-600 text-white font-bold px-3 py-1.5 rounded-lg transition-colors cursor-pointer text-[10px] flex items-center gap-1"
            >
              <PhoneOff className="h-3.5 w-3.5" /> Reject
            </button>
          </div>
        </div>
      )}

      {/* Outer Layout Grid */}
      <div className="flex-1 flex gap-3 min-h-0 overflow-hidden">
        {/* COLUMN 1: Sidebar Nav Bar */}
        <nav className="w-[72px] dribbble-panel rounded-2xl flex flex-col items-center py-4 justify-between shrink-0 shadow-lg bg-[#131419]">
          <div className="flex flex-col items-center gap-6">
            <div className="h-10 w-10 rounded-xl bg-[#ddfd53] text-[#0b0c0f] flex items-center justify-center font-black text-lg shadow-md shadow-[#ddfd53]/10">
              S
            </div>

            <div className="flex flex-col items-center gap-3">
              <button className="h-10 w-10 rounded-full border border-slate-700 bg-slate-800 text-[10px] font-bold text-slate-300 hover:border-slate-500 hover:text-white transition-all cursor-pointer">
                Work
              </button>
              <button className="h-10 w-10 rounded-full border border-[#ddfd53] bg-[#ddfd53]/10 text-[10px] font-bold text-[#ddfd53] transition-all cursor-pointer">
                ICG
              </button>
              <button className="h-10 w-10 rounded-full border border-slate-800 bg-[#18191e] text-[10px] font-bold text-[#989ba2] hover:border-slate-700 hover:text-white transition-all cursor-pointer">
                SP
              </button>
              <button className="h-10 w-10 rounded-full border border-slate-800 bg-[#18191e] text-[10px] font-bold text-[#989ba2] hover:border-slate-700 hover:text-white transition-all cursor-pointer">
                BFF
              </button>
              <button className="h-10 w-10 rounded-full border border-slate-800 bg-[#18191e] text-[10px] font-bold text-[#989ba2] hover:border-slate-700 hover:text-white transition-all cursor-pointer">
                MJ
              </button>
            </div>
          </div>

          <div className="flex flex-col items-center gap-4">
            <button
              onClick={handleOpenUserSearch}
              title="Start Conversation"
              className="h-10 w-10 rounded-full bg-[#ddfd53] text-[#0b0c0f] flex items-center justify-center hover:bg-[#cbe64c] transition-all cursor-pointer shadow-md shadow-[#ddfd53]/10"
            >
              <Plus className="h-5 w-5" />
            </button>
            <button className="text-[#989ba2] hover:text-white transition-colors cursor-pointer">
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </nav>

        {/* COLUMN 2: Contacts sidebar list */}
        <aside className="w-[280px] dribbble-panel rounded-2xl flex flex-col overflow-hidden shadow-lg shrink-0 bg-[#131419]">
          <div className="p-4 border-b border-[#24262d]">
            <div className="relative">
              <Search className="absolute left-3.5 top-3 h-4 w-4 text-[#5c5e66]" />
              <input
                type="text"
                placeholder="Search chats"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-xl bg-[#18191e] border border-[#24262d] pl-9 pr-4 py-2 text-xs text-white placeholder-[#5c5e66] focus:outline-none focus:border-[#ddfd53] transition-colors"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <div className="px-2 py-1 text-[10px] font-bold text-[#5c5e66] uppercase tracking-wider">
              Direct Messages
            </div>
            
            {filteredConversations.length === 0 ? (
              <div className="text-center py-8 text-xs text-[#5c5e66]">No chats found</div>
            ) : (
              filteredConversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const userInitials = getInitials(conv.otherUser?.email || 'User');
                return (
                  <button
                    key={conv.id}
                    onClick={() => setActiveConversationId(conv.id)}
                    className={`w-full flex items-center gap-3 rounded-xl p-3 text-left transition-all border cursor-pointer ${
                      isActive
                        ? 'bg-[#24262d] border-[#24262d]'
                        : 'bg-transparent border-transparent hover:bg-[#18191e]/50'
                    }`}
                  >
                    <div className="h-9 w-9 rounded-full bg-[#18191e] border border-[#24262d] flex items-center justify-center font-bold text-[10px] text-slate-300 relative shrink-0">
                      {userInitials}
                      <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 border-2 border-[#131419]" />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-white truncate pr-1">
                          {conv.otherUser?.email.split('@')[0]}
                        </span>
                        <span className="text-[9px] text-[#5c5e66]">Active</span>
                      </div>
                      <p className="text-[10px] text-[#989ba2] truncate mt-0.5">
                        {conv.otherUser?.email}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="p-3 border-t border-[#24262d] bg-[#18191e]/40 flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-8 w-8 rounded-full bg-[#ddfd53] text-[#0b0c0f] flex items-center justify-center font-black text-xs shrink-0">
                {user.email.substring(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <span className="block text-xs font-bold text-white truncate">
                  {user.email.split('@')[0]}
                </span>
                <span className="block text-[10px] text-[#989ba2] truncate">{user.email}</span>
              </div>
            </div>
            <button
              onClick={handleLogout}
              title="Log Out"
              className="text-[#989ba2] hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-all cursor-pointer"
            >
              <LogOut className="h-4.5 w-4.5" />
            </button>
          </div>
        </aside>

        {/* COLUMN 3: Central Chat Viewport */}
        <main className="flex-1 dribbble-panel rounded-2xl flex flex-col overflow-hidden shadow-lg bg-[#131419] relative">
          {activeConversation ? (
            <>
              {/* Chat Pane Header */}
              <header className="h-16 border-b border-[#24262d] px-6 flex items-center justify-between shrink-0 bg-[#18191e]/15">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-[#18191e] border border-[#24262d] flex items-center justify-center font-bold text-xs text-white">
                    {getInitials(activeConversation.otherUser?.email || 'User')}
                  </div>
                  <div>
                    <h2 className="text-xs font-bold text-white m-0">
                      {activeConversation.otherUser?.email}
                    </h2>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse-subtle'}`} />
                      <span className="text-[9px] text-[#989ba2] mr-2">
                        {isConnected ? 'Active channel' : 'Offline • attempting reconnect...'}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded bg-[#ddfd53]/10 px-1.5 py-0.5 text-[8px] font-bold text-[#ddfd53] border border-[#ddfd53]/20 uppercase tracking-wider">
                        <Shield className="h-2 w-2" /> E2EE Secure
                      </span>
                    </div>
                  </div>
                </div>

                {/* Utility header buttons */}
                <div className="flex items-center gap-3">
                  <div className="relative w-44">
                    <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-[#5c5e66]" />
                    <input
                      type="text"
                      placeholder="Search thread"
                      className="w-full rounded-lg bg-[#18191e] border border-[#24262d] pl-8 pr-3 py-1.5 text-[10px] text-white focus:outline-none focus:border-[#ddfd53] transition-colors"
                    />
                  </div>
                  <button className="text-[#989ba2] hover:text-white cursor-pointer"><Bell className="h-4 w-4" /></button>
                  
                  {/* WebRTC calling initiation button */}
                  <button
                    onClick={() => startCall(activeConversation.id)}
                    title="Start Video Call"
                    disabled={callState !== 'idle'}
                    className="text-[#989ba2] hover:text-[#ddfd53] disabled:opacity-30 disabled:hover:text-[#989ba2] cursor-pointer"
                  >
                    <Video className="h-4.5 w-4.5" />
                  </button>

                  <button
                    onClick={() => setShowRightSidebar(!showRightSidebar)}
                    className={`text-[#989ba2] hover:text-white cursor-pointer ${showRightSidebar ? 'text-white' : ''}`}
                  >
                    <Users className="h-4 w-4" />
                  </button>
                </div>
              </header>

              {/* ACTIVE WEBRTC VIDEO CALL WINDOW OVERLAY */}
              {callState !== 'idle' && activeCallConversationId === activeConversation.id && (
                <div className="absolute inset-0 bg-[#0b0c0f] z-40 flex flex-col justify-between p-6">
                  {/* Call Header info bar */}
                  <div className="flex items-center justify-between z-10">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-[#ddfd53]" />
                      <span className="text-xs font-bold text-white uppercase tracking-wider">E2EE Call Connection</span>
                    </div>

                    {/* Connection quality status tag */}
                    <div className="flex items-center gap-2 rounded bg-black/60 px-3 py-1.5 border border-[#24262d]">
                      <span className={`h-2 w-2 rounded-full ${
                        callQuality === 'good' ? 'bg-emerald-500' : callQuality === 'poor' ? 'bg-amber-500 animate-pulse' : 'bg-red-500 animate-ping'
                      }`} />
                      <span className="text-[10px] font-bold text-slate-300 capitalize">
                        {callQuality === 'good' ? 'Stable Connection' : callQuality === 'poor' ? 'Low Bandwidth' : 'Connecting...'}
                      </span>
                    </div>
                  </div>

                  {/* Calling Status view / streams box */}
                  <div className="flex-1 flex items-center justify-center relative my-4 overflow-hidden rounded-2xl bg-[#131419] border border-[#24262d]">
                    {callState === 'ringing_out' && (
                      <div className="flex flex-col items-center gap-4 text-center">
                        <div className="h-16 w-16 rounded-full bg-[#ddfd53]/10 border border-[#ddfd53]/20 flex items-center justify-center call-glow text-[#ddfd53]">
                          <Phone className="h-8 w-8" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-white">Calling...</p>
                          <p className="text-xs text-[#989ba2] mt-1">Waiting for participant to answer...</p>
                        </div>
                      </div>
                    )}

                    {/* Remote stream video window (connected call) */}
                    <video
                      ref={remoteVideoRef}
                      autoPlay
                      playsInline
                      className={`w-full h-full object-cover bg-black ${callState === 'connected' ? 'block' : 'hidden'}`}
                    />

                    {/* Floating corner local user video stream */}
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`absolute bottom-4 right-4 w-40 h-28 object-cover rounded-xl border-2 border-white/10 shadow-2xl bg-[#131419] z-20 ${
                        callState === 'connected' || callState === 'ringing_out' ? 'block' : 'hidden'
                      }`}
                    />
                  </div>

                  {/* Floating call control bar */}
                  <div className="flex items-center justify-center gap-4 z-10">
                    {/* Mic mute toggler */}
                    <button
                      onClick={toggleMic}
                      className={`h-11 w-11 rounded-full flex items-center justify-center transition-all cursor-pointer border ${
                        isMicMuted
                          ? 'bg-red-500/20 border-red-500/40 text-red-400'
                          : 'bg-[#18191e] border-[#24262d] text-[#989ba2] hover:text-white'
                      }`}
                    >
                      {isMicMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    </button>

                    {/* Hangup calling sessions */}
                    <button
                      onClick={hangupCall}
                      className="h-12 w-12 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center transition-colors cursor-pointer shadow-lg shadow-rose-600/20"
                    >
                      <PhoneOff className="h-5.5 w-5.5" />
                    </button>

                    {/* Cam mute toggler */}
                    <button
                      onClick={toggleCam}
                      className={`h-11 w-11 rounded-full flex items-center justify-center transition-all cursor-pointer border ${
                        isCamMuted
                          ? 'bg-red-500/20 border-red-500/40 text-red-400'
                          : 'bg-[#18191e] border-[#24262d] text-[#989ba2] hover:text-white'
                      }`}
                    >
                      {isCamMuted ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
                    </button>
                  </div>
                </div>
              )}

              {/* Chat Messages Log */}
              <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
                <div className="rounded-xl overflow-hidden dribbble-card border border-[#24262d]">
                  <div className="relative h-28 bg-[#1f2028] overflow-hidden flex items-center justify-center">
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent z-10" />
                    <img
                      src="/Users/kuldeeplakhera/.gemini/antigravity-ide/brain/b913b2bd-a9aa-4e7a-9ace-95252c505a7b/initial_page_1783918540828.png"
                      alt="Shared banner"
                      onError={(e) => {
                        e.currentTarget.src = "https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=600&auto=format&fit=crop&q=60";
                      }}
                      className="w-full h-full object-cover opacity-60"
                    />
                    <div className="absolute bottom-3 left-4 z-20">
                      <span className="text-[10px] font-bold bg-[#ddfd53] text-[#0b0c0f] px-2 py-0.5 rounded-full uppercase tracking-wider">
                        Shared Banner
                      </span>
                      <h4 className="text-xs font-bold text-white mt-1">Convo secure workspace space initialized</h4>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-center my-6">
                  <div className="h-px bg-[#24262d] flex-1" />
                  <span className="px-3 py-1 rounded-full bg-[#18191e] border border-[#24262d] text-[9px] font-bold text-[#989ba2] uppercase tracking-wider">
                    Timeline
                  </span>
                  <div className="h-px bg-[#24262d] flex-1" />
                </div>

                {activeMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <p className="text-xs text-[#5c5e66]">No messages yet. Type in the input below to begin chat.</p>
                  </div>
                ) : (
                  activeMessages.map((msg) => {
                    const isMe = msg.senderId === user.id;
                    const isPending = msg.isPending;
                    const isFailed = msg.isFailed;
                    const initials = isMe ? getInitials(user.email) : getInitials(activeConversation.otherUser?.email || 'User');
                    const isEditing = editingMessageId === msg.id;
                    const isUndecryptable = msg.content.startsWith('🔒');
                    const isMissedCall = msg.content === '📞 Missed Call';

                    return (
                      <div key={msg.id} className="flex items-start gap-3.5 group relative">
                        <div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 border ${
                          isMe ? 'bg-[#ddfd53] text-[#0b0c0f] border-[#ddfd53]/10' : 'bg-[#18191e] text-slate-300 border-[#24262d]'
                        }`}>
                          {initials}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-bold text-white hover:underline cursor-pointer">
                              {isMe ? user.email.split('@')[0] : activeConversation.otherUser?.email.split('@')[0]}
                            </span>
                            <span className="text-[9px] text-[#5c5e66]">
                              {new Date(msg.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            
                            {msg.updatedAt && (
                              <span className="text-[9px] text-[#5c5e66] italic" title={`Edited at ${new Date(msg.updatedAt).toLocaleString()}`}>
                                (edited)
                              </span>
                            )}

                            <span className="text-[9px] font-mono text-[#ddfd53]/60 bg-[#ddfd53]/5 px-1.5 py-0.5 rounded border border-[#ddfd53]/10">
                              #{msg.sequenceId > 0 && msg.sequenceId < 1e11 ? msg.sequenceId : 'pending'}
                            </span>
                          </div>

                          {isEditing ? (
                            <form onSubmit={(e) => handleEditSubmit(e, msg.id)} className="flex items-center gap-2 mt-1.5 max-w-xl">
                              <input
                                type="text"
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                className="flex-1 bg-[#18191e] border border-[#24262d] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#ddfd53]"
                                autoFocus
                              />
                              <button
                                type="submit"
                                className="bg-[#ddfd53] text-[#0b0c0f] font-bold rounded-lg px-2.5 py-1.5 text-[10px] hover:bg-[#cbe64c] transition-colors cursor-pointer shrink-0"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingMessageId(null)}
                                className="bg-[#18191e] text-slate-400 border border-[#24262d] rounded-lg px-2 py-1.5 text-[10px] hover:text-white transition-colors cursor-pointer shrink-0"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </form>
                          ) : (
                            <div className={`text-xs mt-1 break-words leading-relaxed whitespace-pre-wrap ${
                              isPending ? 'opacity-50 italic text-[#f1f5f9]' : ''
                            } ${isFailed ? 'text-red-400' : ''} ${
                              isUndecryptable 
                                ? 'text-amber-500/90 italic font-medium bg-amber-500/5 border border-amber-500/10 px-2 py-1 rounded-lg inline-block' 
                                : isMissedCall
                                ? 'text-rose-400/95 font-semibold bg-rose-500/5 border border-rose-500/10 px-3 py-1.5 rounded-xl inline-flex items-center gap-2 mt-1.5 shadow-sm'
                                : 'text-[#f1f5f9]'
                            }`}>
                              {isMissedCall ? (
                                <>
                                  <PhoneOff className="h-3.5 w-3.5 text-rose-500 animate-pulse" />
                                  <span>Missed call request</span>
                                </>
                              ) : (
                                msg.content
                              )}
                            </div>
                          )}
                        </div>

                        {isMe && !isPending && !isFailed && !isEditing && !isUndecryptable && !isMissedCall && (
                          <div className="absolute right-12 top-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center bg-[#131419] border border-[#24262d] rounded-lg px-1 py-0.5 shadow-md">
                            <button
                              onClick={() => {
                                setEditingMessageId(msg.id);
                                setEditContent(msg.content);
                              }}
                              title="Edit Message"
                              className="text-[#989ba2] hover:text-[#ddfd53] p-1 transition-colors cursor-pointer"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </div>
                        )}

                        {isMe && (
                          <div className="self-center shrink-0 ml-2">
                            {isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#ddfd53]" />
                            ) : isFailed ? (
                              <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                            ) : msg.status === 'read' ? (
                              <div className="flex items-center" title="Read">
                                <CheckCheck className="h-4 w-4 text-[#ddfd53]" />
                              </div>
                            ) : msg.status === 'delivered' ? (
                              <div className="flex items-center" title="Delivered">
                                <CheckCheck className="h-4 w-4 text-[#989ba2]" />
                              </div>
                            ) : (
                              <div className="flex items-center" title="Sent">
                                <Check className="h-4 w-4 text-[#989ba2]" />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Message panel */}
              <div className="p-4 border-t border-[#24262d] bg-[#131419]/35 shrink-0">
                <form onSubmit={handleSend} className="max-w-4xl mx-auto flex items-center gap-3 rounded-2xl bg-[#18191e] border border-[#24262d] px-4 py-2">
                  <button type="button" className="text-[#989ba2] hover:text-white p-1.5 rounded-lg transition-colors cursor-pointer">
                    <Paperclip className="h-4.5 w-4.5" />
                  </button>
                  <input
                    type="text"
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    placeholder={`Write an encrypted message to ${activeConversation.otherUser?.email.split('@')[0]}...`}
                    className="flex-1 bg-transparent border-none py-2 text-xs text-white placeholder-[#5c5e66] focus:outline-none custom-input"
                  />
                  <button
                    type="submit"
                    disabled={!inputMessage.trim()}
                    className="h-9 w-9 rounded-xl bg-[#ddfd53] hover:bg-[#cbe64c] disabled:opacity-30 disabled:hover:bg-[#ddfd53] text-[#0b0c0f] flex items-center justify-center transition-all cursor-pointer shrink-0"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <div className="h-14 w-14 rounded-2xl bg-[#18191e] border border-[#24262d] flex items-center justify-center mb-4">
                <MessageSquare className="h-6 w-6 text-[#ddfd53]" />
              </div>
              <h2 className="text-sm font-bold text-white m-0">No active thread</h2>
              <p className="text-xs text-[#989ba2] max-w-xs mt-1.5 leading-relaxed">
                Select a conversation in the directory list, or click the **`+`** icon to search and initiate a discussion.
              </p>
            </div>
          )}
        </main>

        {/* COLUMN 4: Right Context details sidebar */}
        {activeConversation && showRightSidebar && (
          <aside className="w-[280px] dribbble-panel rounded-2xl flex flex-col overflow-hidden shadow-lg shrink-0 bg-[#131419]">
            <div className="p-4 border-b border-[#24262d] flex items-center justify-around bg-[#18191e]/20">
              <button
                onClick={() => startCall(activeConversation.id)}
                title="Start Voice Call"
                className="h-8 w-8 rounded-full bg-[#ddfd53]/10 border border-[#ddfd53]/25 flex items-center justify-center text-[#ddfd53] hover:bg-[#ddfd53]/20 transition-all cursor-pointer"
              >
                <Phone className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => startCall(activeConversation.id)}
                title="Start Video Call"
                className="h-8 w-8 rounded-full bg-[#18191e] border border-[#24262d] flex items-center justify-center text-slate-300 hover:text-white transition-all cursor-pointer"
              >
                <Video className="h-3.5 w-3.5" />
              </button>
              <button className="h-8 w-8 rounded-full bg-[#18191e] border border-[#24262d] flex items-center justify-center text-slate-300 hover:text-white transition-all cursor-pointer">
                <Pin className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="p-4 border-b border-[#24262d]">
              <h3 className="text-xs font-bold text-white mb-3">Members</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-7 w-7 rounded-full bg-[#18191e] border border-[#24262d] flex items-center justify-center font-bold text-[10px] text-white shrink-0">
                      {getInitials(activeConversation.otherUser?.email)}
                    </div>
                    <span className="text-xs font-semibold text-slate-300 truncate">
                      {activeConversation.otherUser?.email.split('@')[0]}
                    </span>
                  </div>
                  <span className="text-[9px] font-bold text-[#5c5e66] uppercase">Member</span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-7 w-7 rounded-full bg-[#ddfd53] text-[#0b0c0f] flex items-center justify-center font-bold text-[10px] shrink-0">
                      {getInitials(user.email)}
                    </div>
                    <span className="text-xs font-semibold text-slate-300 truncate">
                      {user.email.split('@')[0]} (You)
                    </span>
                  </div>
                  <span className="text-[9px] font-bold text-[#ddfd53] uppercase">Admin</span>
                </div>
              </div>
            </div>

            <div className="border-b border-[#24262d]">
              <button
                onClick={() => setFilesOpen(!filesOpen)}
                className="w-full flex items-center justify-between p-4 text-xs font-bold text-white hover:bg-[#18191e]/40 transition-colors cursor-pointer"
              >
                <span>Files</span>
                {filesOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              
              {filesOpen && (
                <div className="px-4 pb-4 space-y-2">
                  <div className="flex items-center gap-2.5 rounded-lg bg-[#18191e]/40 p-2 border border-[#24262d]/50 text-left">
                    <div className="h-7 w-7 rounded bg-[#24262d] flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-indigo-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold text-slate-300 truncate">project_spec.pdf</p>
                      <p className="text-[9px] text-[#5c5e66]">1.2 MB • PDF Document</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2.5 rounded-lg bg-[#18191e]/40 p-2 border border-[#24262d]/50 text-left">
                    <div className="h-7 w-7 rounded bg-[#24262d] flex items-center justify-center shrink-0">
                      <Image className="h-4 w-4 text-emerald-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold text-slate-300 truncate">design_reference.png</p>
                      <p className="text-[9px] text-[#5c5e66]">3.4 MB • PNG Image</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border-b border-[#24262d]">
              <button
                onClick={() => setLinksOpen(!linksOpen)}
                className="w-full flex items-center justify-between p-4 text-xs font-bold text-white hover:bg-[#18191e]/40 transition-colors cursor-pointer"
              >
                <span>Shared links</span>
                {linksOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>

              {linksOpen && (
                <div className="px-4 pb-4 space-y-2">
                  <div className="flex items-center gap-2 rounded-lg bg-[#18191e]/40 p-2 border border-[#24262d]/50 text-left">
                    <Link2 className="h-3.5 w-3.5 text-[#ddfd53] shrink-0" />
                    <a
                      href="https://dribbble.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-slate-300 truncate hover:underline"
                    >
                      https://dribbble.com/shots/24911746
                    </a>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* User Search Dialog overlay */}
      {showUserSearch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#131419] border border-[#24262d] p-5 shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-white flex items-center gap-2 text-xs">
                <Users className="h-4 w-4 text-[#ddfd53]" /> Start a New Chat
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
                <Loader2 className="h-6 w-6 animate-spin text-[#ddfd53]" />
              </div>
            ) : usersList.length === 0 ? (
              <p className="text-center text-xs text-[#5c5e66] py-6">No other users found.</p>
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
                    className="w-full flex items-center gap-2.5 rounded-xl bg-[#18191e]/60 hover:bg-[#ddfd53]/10 border border-[#24262d] p-2.5 text-left text-xs transition-colors cursor-pointer text-slate-200"
                  >
                    <div className="h-6 w-6 rounded-full bg-[#24262d] flex items-center justify-center shrink-0">
                      <User className="h-3 w-3 text-[#ddfd53]" />
                    </div>
                    <span className="truncate">{usr.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
