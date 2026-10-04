import React from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Radio,
  Key,
  Layers,
} from 'lucide-react';
import type { ConnectionStatus } from '../network/types';

interface NavbarProps {
  localId: string;
  status: ConnectionStatus;
  statusDetail?: string;
  isOnionMode: boolean;
  onToggleOnionMode: () => void;
  onOpenIdentity: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  localId,
  status,
  statusDetail,
  isOnionMode,
  onToggleOnionMode,
  onOpenIdentity,
}) => {
  const isConnected = status === 'connected';
  const getStatusBadge = () => {
    switch (status) {
      case 'connected':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 shadow-[0_0_10px_rgba(139,92,246,0.2)]">
            <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
            E2EE Connected
          </span>
        );
      case 'authenticating':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            Authenticating Handshake...
          </span>
        );
      case 'signaling':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Radio className="w-3 h-3 animate-spin" />
            Signaling Rendezvous...
          </span>
        );
      case 'rejected':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <ShieldAlert className="w-3 h-3" />
            Connection Declined
          </span>
        );
      case 'failed':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <ShieldAlert className="w-3 h-3" />
            Handshake Failed
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-slate-800 text-slate-400 border border-slate-700">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            Ready / Listening
          </span>
        );
    }
  };

  return (
    <header className="sticky top-0 z-30 w-full border-b border-white/[0.08] bg-[#0B0D12]/90 backdrop-blur-md px-4 py-3 sm:px-6">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        {/* Logo and Brand */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-teal-500/10 border border-violet-500/30 shadow-[0_0_15px_rgba(139,92,246,0.25)]">
            <ShieldCheck className="w-6 h-6 text-violet-400" />
            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-violet-400 ring-2 ring-[#090d16]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-violet-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
                CipherLink
              </span>
              <span className="hidden sm:inline-block text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">
                P2P E2EE
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              Serverless End-to-End Encrypted Messenger
            </p>
          </div>
        </div>

        {/* Center: Connection Status + Onion Mode Toggle */}
        <div className="order-3 flex w-full flex-wrap items-center justify-between gap-2 md:order-none md:w-auto md:flex-nowrap md:justify-center md:gap-3">
          {getStatusBadge()}
          {statusDetail && status !== 'connected' && status !== 'disconnected' && (
            <span className="text-xs font-mono text-slate-500 hidden lg:inline truncate max-w-xs">
              {statusDetail}
            </span>
          )}

          {/* Onion Routing Mode Toggle */}
          <button
            onClick={onToggleOnionMode}
            disabled={!isConnected}
            title={
              !isConnected
                ? 'Connect to a peer first to enable Onion Routing'
                : isOnionMode
                ? 'Active: messages are wrapped in 3-layer AES-CTR cells (local simulation — no real relay nodes)'
                : 'Switch to Onion Routing mode (local simulation)'
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all border ${
              !isConnected
                ? 'opacity-40 cursor-not-allowed bg-slate-900/40 text-slate-600 border-white/[0.08]'
                : isOnionMode
                ? 'bg-purple-950/40 text-purple-300 border-purple-500/40 shadow-[0_0_12px_rgba(168,85,247,0.25)] hover:bg-purple-900/40'
                : 'bg-[#141720]/90 text-slate-400 border-white/[0.08] hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            <Layers
              className={`w-3.5 h-3.5 ${
                isOnionMode ? 'text-purple-400' : 'text-slate-500'
              }`}
            />
            <span>
              {isOnionMode ? '3-Hop Onion ✓' : 'Direct P2P'}
            </span>
            {isConnected && (
              <span className="text-[9px] text-slate-500 hidden lg:inline">(sim)</span>
            )}
          </button>
        </div>

        {/* Right: Identity Button */}
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenIdentity}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 text-xs font-mono text-slate-300 border border-slate-700/80 transition-all duration-200"
            title="View Your Cryptographic Identity & Safety Keys"
          >
            <Key className="w-3.5 h-3.5 text-violet-400" />
            <span className="hidden sm:inline">{localId ? localId.slice(0, 9) + '...' : 'Identity'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
