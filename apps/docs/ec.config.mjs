export default {
  defaultProps: { frame: 'code' },
  styleOverrides: {
    borderRadius: '0.5rem',
    borderColor: 'var(--o-rule)',
    codeBackground: 'var(--o-code)',
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
