/** @type {import('tailwindcss').Config} */
export default {
  content: [
  "./index.html",
  "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
  extend: {
  colors: {
  cyber: {
  50: '#f5f3ff',
  100: '#ede9fe',
  200: '#ddd6fe',
  300: '#c4b5fd',
  400: '#a78bfa',
  500: '#8b5cf6',
  600: '#7c3aed',
  700: '#6d28d9',
  800: '#5b21b6',
  900: '#4c1d95',
  950: '#2e1065',
  },
  accent: {
  400: '#22d3ee',
  500: '#06b6d4',
  600: '#0891b2',
  },
  dark: {
  950: '#09090f',
  900: '#11111b',
  800: '#171725',
  700: '#222233',
  600: '#303044',
  500: '#414158',
  },
  success: {
  400: '#34d399',
  500: '#10b981',
  600: '#059669',
  },
  },
  fontFamily: {
  sans: ['Inter', 'system-ui', 'sans-serif'],
  display: ['Manrope', 'Inter', 'sans-serif'],
  mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
  },
  animation: {
  'pulse-glow': 'pulseGlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  'matrix-scan': 'matrixScan 3s linear infinite',
  'fade-in': 'fadeIn 0.2s ease-out forwards',
  float: 'float 3s ease-in-out infinite',
  },
  keyframes: {
  pulseGlow: {
  '0%, 100%': {
  opacity: '1',
  filter: 'drop-shadow(0 0 12px rgba(139, 92, 246, 0.6))',
  },
  '50%': {
  opacity: '0.6',
  filter: 'drop-shadow(0 0 4px rgba(139, 92, 246, 0.2))',
  },
  },
  matrixScan: {
  '0%': { transform: 'translateY(-100%)' },
  '100%': { transform: 'translateY(1000%)' },
  },
  fadeIn: {
  from: {
  opacity: '0',
  transform: 'scale(0.98)',
  },
  to: {
  opacity: '1',
  transform: 'scale(1)',
  },
  },
  float: {
  '0%, 100%': { transform: 'translateY(0)' },
  '50%': { transform: 'translateY(-6px)' },
  },
  },
  boxShadow: {
  'violet-glow': '0 0 24px rgba(139, 92, 246, 0.18)',
  'cyan-glow': '0 0 24px rgba(34, 211, 238, 0.15)',
  panel: '0 8px 32px rgba(0, 0, 0, 0.25)',
  },
  borderRadius: {
  xl: '1rem',
  '2xl': '1.25rem',
  '3xl': '1.75rem',
  },
  },
  },
  plugins: [],
  };
  