export default {
  defaultProps: { frame: 'code' },
  styleOverrides: {
    borderRadius: 'calc(var(--radius-card) * var(--corner-scale))',
    borderColor: 'var(--border-default)',
    codeBackground: 'var(--bg-surface)',
    codeFontFamily: 'var(--sl-font-mono)',
    codeFontSize: '0.8125rem',
    uiFontFamily: 'var(--sl-font)',
    frames: {
      inlineButtonBackgroundIdleOpacity: '0',
      inlineButtonBackgroundHoverOrFocusOpacity: '0.1',
      inlineButtonBorderOpacity: '0',
      shadowColor: 'transparent'
    }
  }
};
