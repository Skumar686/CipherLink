import React, { useState, useEffect, useRef } from 'react';
import { Navbar } from './ui/Navbar';
import { IdentityCard } from './ui/IdentityCard';
import { ConnectionModal } from './ui/ConnectionModal';
import { ChatView } from './ui/ChatView';
import { FileTransferModal } from './ui/FileTransferModal';
import { CallView } from './ui/CallView';

import {
  getOrCreateIdentity,
  resetIdentity,
  type UserIdentity,
} from './crypto/identity';
import {
  PeerSessionManager,
  type IncomingRequest,
} from './network/peerSignaling';
import { FileTransferManager } from './network/fileTransfer';
import { MediaCallManager } from './network/mediaCalls';
import { OnionCircuitManager } from './network/onionRouting';
import { encryptPayload } from './crypto/session';
import type {
  ChatMessage,
  ConnectionStatus,
  FileTransferState,
  NetworkMetrics,
} from './network/types';

export const App: React.FC = () => {
  // Identity State
  const [identity, setIdentity] = useState<UserIdentity | null>(null);

  // Connection & Session State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [statusDetail, setStatusDetail] = useState<string>('');
  const [connectedPeerId, setConnectedPeerId] = useState<string>('');
  const [safetyNumber, setSafetyNumber] = useState<string>('');
  const [incomingRequest, setIncomingRequest] = useState<IncomingRequest | null>(null);

  // Messaging & File State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTransfer, setActiveTransfer] = useState<FileTransferState | null>(null);

  // Media Call State
  const [isCallOpen, setIsCallOpen] = useState<boolean>(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // Modal Visibility
  const [isIdentityOpen, setIsIdentityOpen] = useState<boolean>(false);
  const [isConnectModalOpen, setIsConnectModalOpen] = useState<boolean>(false);
  const [isFileModalOpen, setIsFileModalOpen] = useState<boolean>(false);

  // Onion Routing Mode
  // NOTE: isOnionMode=true applies real AES-CTR layered wrapping (3 hops) to each
  // outgoing message payload before the AES-256-GCM envelope is sent over the
  // WebRTC data channel. The circuit keys are generated and held entirely in this
  // browser — there are NO real relay nodes. This simulates the cryptographic
  // transformation layer of onion routing without actual multi-hop network routing.
  const [isOnionMode, setIsOnionMode] = useState<boolean>(false);
  const [onionDisclaimer, setOnionDisclaimer] = useState<boolean>(false);
  const onionManagerRef = useRef<OnionCircuitManager>(new OnionCircuitManager());

  // References to managers
  const peerManagerRef = useRef<PeerSessionManager | null>(null);
  const fileManagerRef = useRef<FileTransferManager | null>(null);
  const mediaManagerRef = useRef<MediaCallManager | null>(null);
  // sessionKeyRef mirrors the active session key so handlers can access it without closure staleness
  const sessionKeyRef = useRef<CryptoKey | null>(null);

  // Initialize Cryptographic Identity on load
  useEffect(() => {
    let isMounted = true;
    getOrCreateIdentity().then((id) => {
      if (isMounted) {
        setIdentity(id);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  // Initialize Peer Session Manager once identity is ready
  useEffect(() => {
    if (!identity) return;

    const manager = new PeerSessionManager(identity, {
      onStatusChange: (status, detail) => {
        setConnectionStatus(status);
        if (detail) setStatusDetail(detail);
      },
      onIncomingRequest: (req) => {
        setIncomingRequest(req);
      },
      onConnected: ({ peerId, safetyNumber: sn, sessionKey, reliableTransport }) => {
        setConnectedPeerId(peerId);
        setSafetyNumber(sn);
        setIsConnectModalOpen(false);
        setIncomingRequest(null);
        sessionKeyRef.current = sessionKey;

        // Initialize File Transfer Manager for this session
        const ftm = new FileTransferManager(reliableTransport, sessionKey);
        ftm.setOnProgress((state) => {
          setActiveTransfer({ ...state });
        });
        fileManagerRef.current = ftm;

        // System message confirming handshake completion
        setMessages([
          {
            id: 'handshake-' + Date.now(),
            seq: 0,
            senderId: 'SYSTEM',
            text: `🔒 Peer connection verified! Bilateral ECDH session key established. Signal Safety Number: ${sn}`,
            timestamp: Date.now(),
            isSelf: false,
            status: 'delivered',
            retransmits: 0,
          },
        ]);
      },
      // Bug fix #2: clear messages and session state on any disconnect
      onDisconnected: () => {
        setConnectedPeerId('');
        setSafetyNumber('');
        setMessages([]);
        setActiveTransfer(null);
        fileManagerRef.current = null;
        sessionKeyRef.current = null;
        // Reset onion mode on disconnect so next session starts clean
        setIsOnionMode(false);
        onionManagerRef.current.destroy();
        onionManagerRef.current = new OnionCircuitManager();
      },
      onMessageReceived: (text, timestamp, seq) => {
        setMessages((prev) => [
          ...prev,
          {
            id: 'msg-' + Date.now() + '-' + Math.random(),
            seq,
            senderId: connectedPeerId || 'Peer',
            text,
            timestamp,
            isSelf: false,
            status: 'delivered',
            retransmits: 0,
          },
        ]);
      },
      onFileChunkReceived: (packet) => {
        if (fileManagerRef.current) {
          fileManagerRef.current.handleIncomingChunk(packet);
        }
      },
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setIsCallOpen(true);
      },
      onMetricsChange: (_newMetrics: NetworkMetrics) => {
        // Metrics are not displayed (panel removed); no-op.
      },
    });

    peerManagerRef.current = manager;
    manager.startListening();

    return () => {
      manager.destroy();
    };
  }, [identity]);

  // Setup Media Call Manager
  useEffect(() => {
    const mcm = new MediaCallManager(
      {
        onLocalStream: (s) => setLocalStream(s),
        onRemoteStream: (s) => setRemoteStream(s),
        onCallEnded: () => {
          setIsCallOpen(false);
          setLocalStream(null);
          setRemoteStream(null);
        },
        onError: (err) => console.error('[MediaCallManager]', err),
      },
      (stream) => {
        if (peerManagerRef.current) {
          peerManagerRef.current.addMediaStream(stream);
        }
      },
      (stream) => {
        if (peerManagerRef.current) {
          peerManagerRef.current.removeMediaStream(stream);
        }
      }
    );
    mediaManagerRef.current = mcm;
  }, []);

  // Handle Outgoing Connection Request
  const handleConnect = async (targetId: string) => {
    if (!peerManagerRef.current) return;
    try {
      await peerManagerRef.current.connectToPeer(targetId);
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Handle Incoming Request Accept
  const handleAcceptIncoming = async () => {
    if (incomingRequest) {
      await incomingRequest.accept();
      setIncomingRequest(null);
    }
  };

  // Handle Incoming Request Reject
  const handleRejectIncoming = () => {
    if (incomingRequest) {
      incomingRequest.reject('Declined by user');
      setIncomingRequest(null);
    }
  };

  // Handle Disconnect (Bug fix #2: onDisconnected callback handles state cleanup)
  const handleDisconnect = () => {
    if (peerManagerRef.current) {
      peerManagerRef.current.disconnect();
    }
    setConnectionStatus('disconnected');
  };

  // Handle Send Chat Message
  const handleSendMessage = async (text: string) => {
    if (!peerManagerRef.current) return;

    if (isOnionMode && sessionKeyRef.current) {
      // Onion mode path:
      // Step 1 — AES-256-GCM encrypt the plaintext (end-to-end layer, same as direct)
      const e2eCiphertext = await encryptPayload(sessionKeyRef.current, text);
      // Step 2 — Wrap the ciphertext in 3 layers of AES-CTR (per-hop onion layers)
      //          The circuit keys live in-browser; no real relay nodes are traversed.
      const onionWrapped = await onionManagerRef.current.wrapOnionCell(e2eCiphertext);
      // Step 3 — Deliver the onion cell via the existing reliable transport
      const seq = peerManagerRef.current.sendOnionCell(onionWrapped);
      if (seq !== null) {
        setMessages((prev) => [
          ...prev,
          {
            id: 'msg-' + Date.now() + '-' + Math.random(),
            seq,
            senderId: identity?.id || 'Me',
            text,
            timestamp: Date.now(),
            isSelf: true,
            status: 'sent',
            retransmits: 0,
          },
        ]);
      }
      return;
    }

    // Direct P2P path (default)
    const seq = await peerManagerRef.current.sendChatMessage(text);
    if (seq !== null) {
      const newMsg: ChatMessage = {
        id: 'msg-' + Date.now() + '-' + Math.random(),
        seq,
        senderId: identity?.id || 'Me',
        text,
        timestamp: Date.now(),
        isSelf: true,
        status: 'sent',
        retransmits: 0,
      };
      setMessages((prev) => [...prev, newMsg]);
    }
  };

  // Handle Send File
  const handleSendFile = async (file: File) => {
    if (fileManagerRef.current) {
      await fileManagerRef.current.sendFile(file);
    }
  };

  // Handle Calls
  const handleStartAudioCall = async () => {
    if (mediaManagerRef.current) {
      setIsCallOpen(true);
      await mediaManagerRef.current.startMedia(false, true);
    }
  };

  const handleStartVideoCall = async () => {
    if (mediaManagerRef.current) {
      setIsCallOpen(true);
      await mediaManagerRef.current.startMedia(true, true);
    }
  };

  // Handle Onion Mode Toggle
  const handleToggleOnionMode = async () => {
    if (!isOnionMode) {
      // Switching ON: pre-build the local circuit (real AES-CTR keys, simulated nodes)
      await onionManagerRef.current.buildCircuit();
      setIsOnionMode(true);
      setOnionDisclaimer(true);
      // Auto-hide disclaimer after 8 seconds
      setTimeout(() => setOnionDisclaimer(false), 8000);
    } else {
      // Switching OFF
      onionManagerRef.current.destroy();
      onionManagerRef.current = new OnionCircuitManager();
      setIsOnionMode(false);
      setOnionDisclaimer(false);
    }
  };

  // Handle Reset Identity
  const handleResetIdentity = async () => {
    await resetIdentity();
    const newId = await getOrCreateIdentity();
    setIdentity(newId);
  };

  return (
    <div className="flex flex-col h-screen bg-[#090d16] text-slate-100 font-sans select-none overflow-hidden">
      {/* Top Navigation */}
      <Navbar
        localId={identity?.id || ''}
        status={connectionStatus}
        statusDetail={statusDetail}
        isOnionMode={isOnionMode}
        onToggleOnionMode={handleToggleOnionMode}
        onOpenIdentity={() => setIsIdentityOpen(true)}
      />

      {/* Main Chat Stage */}
      <main className="flex-1 flex overflow-hidden">
        <ChatView
          messages={messages}
          onSendMessage={handleSendMessage}
          onOpenFileTransfer={() => setIsFileModalOpen(true)}
          onStartAudioCall={handleStartAudioCall}
          onStartVideoCall={handleStartVideoCall}
          onDisconnect={handleDisconnect}
          onOpenConnectModal={() => setIsConnectModalOpen(true)}
          connectedPeerId={connectedPeerId}
          safetyNumber={safetyNumber}
          connectionStatus={connectionStatus}
        />
      </main>

      {/* Onion Mode Disclaimer Banner */}
      {onionDisclaimer && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[calc(100%-2rem)] px-4 py-3 rounded-xl bg-purple-950/90 border border-purple-500/40 shadow-2xl backdrop-blur-md text-xs text-purple-200 leading-relaxed">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-purple-300 mb-1">⚠️ Onion Mode — Local Simulation Active</p>
              <p>
                Messages are now wrapped in <strong>3 layers of AES-CTR encryption</strong> (one per simulated hop) before the AES-256-GCM transport envelope. The layered keys are generated and peeled entirely within this browser — <strong>no real relay nodes or network hops are used</strong>. This demonstrates the cryptographic transformation of onion routing, not its anonymity properties.
              </p>
            </div>
            <button
              onClick={() => setOnionDisclaimer(false)}
              className="shrink-0 mt-0.5 text-purple-400 hover:text-purple-200"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Modals */}
      <IdentityCard
        identity={identity}
        isOpen={isIdentityOpen}
        onClose={() => setIsIdentityOpen(false)}
        onResetIdentity={handleResetIdentity}
        peerSafetyNumber={safetyNumber}
        connectedPeerId={connectedPeerId}
      />

      <ConnectionModal
        isOpen={isConnectModalOpen}
        onClose={() => setIsConnectModalOpen(false)}
        onConnect={handleConnect}
        incomingRequest={incomingRequest}
        onAcceptIncoming={handleAcceptIncoming}
        onRejectIncoming={handleRejectIncoming}
        isConnecting={connectionStatus === 'signaling' || connectionStatus === 'authenticating'}
        connectingStatusText={statusDetail}
      />

      <FileTransferModal
        isOpen={isFileModalOpen}
        onClose={() => setIsFileModalOpen(false)}
        onSendFile={handleSendFile}
        activeTransfer={activeTransfer}
      />

      <CallView
        isOpen={isCallOpen}
        onClose={() => setIsCallOpen(false)}
        localStream={localStream}
        remoteStream={remoteStream}
        peerId={connectedPeerId}
        mediaManager={mediaManagerRef.current}
      />
    </div>
  );
};

export default App;
