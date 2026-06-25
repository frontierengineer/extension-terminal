// xterm takes flat colour literals, so the CSS custom properties that theme
// the rest of the app can't flow in — these mirror --bg-primary / the
// terminal palette in index.css and must be kept in step with it.
export const XTERM_THEME = {
  background: '#121314',
  foreground: '#e5e7eb',
  cursor: '#e5e7eb',
  cursorAccent: '#121314',
  selectionBackground: 'rgba(99, 102, 241, 0.35)',
  black: '#121314',
  red: '#ef4444',
  green: '#10b981',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#f87171',
  brightGreen: '#34d399',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#f9fafb',
} as const;
