import React from 'react';

interface WindowsLogoProps {
  className?: string;
  variant?: 'color' | 'monochrome';
}

/**
 * Authentic 4-quadrant Windows Logo
 */
export const WindowsLogo: React.FC<WindowsLogoProps> = ({
  className = 'w-5 h-5',
  variant = 'color',
}) => {
  if (variant === 'monochrome') {
    return (
      <svg
        viewBox="0 0 88 88"
        fill="currentColor"
        className={className}
        aria-hidden="true"
      >
        <path d="M0 12.402l35.689-4.86.016 34.423-35.67.203zm35.67 33.529l.028 34.453L.028 75.48.016 46.134zM40.16 6.844L87.971 0v41.974l-47.811.207zm47.823 39.467v41.689l-47.823-6.744V46.311z" />
      </svg>
    );
  }

  // Modern Windows 11 Fluent 4-tile design with signature blue gradients
  return (
    <svg
      viewBox="0 0 88 88"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="win-grad-tl" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00adef" />
          <stop offset="100%" stopColor="#0078d7" />
        </linearGradient>
        <linearGradient id="win-grad-tr" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#29b6f6" />
          <stop offset="100%" stopColor="#0288d1" />
        </linearGradient>
        <linearGradient id="win-grad-bl" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0078d7" />
          <stop offset="100%" stopColor="#005a9e" />
        </linearGradient>
        <linearGradient id="win-grad-br" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0288d1" />
          <stop offset="100%" stopColor="#01579b" />
        </linearGradient>
      </defs>
      {/* Top Left */}
      <path d="M2 12.4l33.7-4.6v34.2H2z" fill="url(#win-grad-tl)" />
      {/* Top Right */}
      <path d="M40.2 6.8L86 0v42H40.2z" fill="url(#win-grad-tr)" />
      {/* Bottom Left */}
      <path d="M2 46h33.7v34.4L2 75.6z" fill="url(#win-grad-bl)" />
      {/* Bottom Right */}
      <path d="M40.2 46H86v41.8L40.2 81z" fill="url(#win-grad-br)" />
    </svg>
  );
};
