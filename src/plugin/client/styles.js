export const CSS = `
  .remoteWorkspace, .remoteWorkspace__launcher, .remoteOps { --ro-bg: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff)); --ro-panel: var(--dsw-alias-bg-module-platform, #f5f6f7); --ro-panel-2: var(--dsw-alias-interactive-bg-hover-solid, #f1f3f5); --ro-active: var(--dsw-alias-button-ghost-active-fill, #ebeef2); --ro-hover: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); --ro-code-bg: var(--dsw-alias-markdown-code-block, #f9fafb); --ro-menu-bg: var(--dsw-specific-menu, var(--ro-bg)); --ro-input-bg: var(--dsw-specific-input-major, var(--ro-bg)); --ro-line: var(--dsw-alias-border-l2, rgba(0,0,0,.1)); --ro-text: var(--dsw-alias-label-primary, #0f1115); --ro-muted: var(--dsw-alias-label-secondary, #61666b); --ro-dim: var(--dsw-alias-label-tertiary, #81858c); --ro-accent: var(--dsw-alias-state-business-primary, #4176e6); --ro-danger: var(--dsw-alias-state-error-primary, #ec1313); --ro-success: var(--dsw-alias-state-success-primary, #22c55e); color: var(--ro-text); }
  .remoteOps * , .remoteWorkspace * { box-sizing: border-box; }
  .remoteWorkspace { background: var(--ro-bg); border-left: 1px solid var(--ro-line); color-scheme: light dark; display: flex; flex-direction: column; height: 100vh; inset: 0 0 0 var(--ro-workspace-left, 50vw); min-width: 300px; position: fixed; z-index: 2; }
  .remoteWorkspace__head { align-items: center; background: var(--ro-bg); border-bottom: 1px solid var(--ro-line); display: flex; height: 44px; justify-content: space-between; padding: 0 12px 0 16px; }
  .remoteWorkspace__identity { align-items: center; display: flex; gap: 9px; min-width: 0; }
  .remoteWorkspace__title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteWorkspace__address { color: var(--ro-muted); font: 12px ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteWorkspace__statusDot { background: var(--ro-success); border-radius: 50%; height: 7px; width: 7px; }
  .remoteWorkspace__button { align-items: center; appearance: none; background: transparent; border: 1px solid var(--ro-line); border-radius: 6px; color: var(--ro-muted); cursor: pointer; display: inline-flex; font: inherit; font-size: 12px; gap: 6px; height: 30px; justify-content: center; padding: 0 9px; }
  .remoteWorkspace__launcherButton, .remoteWorkspace__headButton { height: 30px; }
  .remoteWorkspace__saveButton { min-width: 74px; }
  .remoteWorkspace__port, .remoteOps__port { min-width: 0; }
  .remoteWorkspace__button:hover:not(:disabled), .remoteWorkspace__button[data-active='true'] { background: var(--ro-hover); color: var(--ro-text); }
  .remoteWorkspace__button:disabled { cursor: default; opacity: .45; }
  .remoteWorkspace__workspace { display: grid; flex: 1; grid-template-columns: minmax(0, 1fr) 5px var(--ro-explorer-width, 320px); min-height: 0; }
  .remoteWorkspace__workspaceSplitter { background: transparent; bottom: 0; cursor: col-resize; left: -3px; position: absolute; top: 0; touch-action: none; width: 7px; z-index: 2; }
  .remoteWorkspace__workspaceSplitter:hover { background: color-mix(in srgb, var(--ro-accent) 35%, transparent); }
  .remoteWorkspace__explorerSplitter { background: var(--ro-line); cursor: col-resize; min-width: 5px; touch-action: none; }
  .remoteWorkspace__explorerSplitter:hover { background: var(--ro-accent); }
  .remoteWorkspace__main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .remoteWorkspace__tabs { align-items: center; background: var(--ro-bg); border-bottom: 1px solid var(--ro-line); display: flex; gap: 4px; height: 46px; overflow-x: auto; padding: 0 10px; }
  .remoteWorkspace__tab { align-items: center; background: transparent; border: 1px solid transparent; border-radius: 7px; color: var(--ro-muted); cursor: pointer; display: inline-flex; font: inherit; font-size: 12px; gap: 7px; height: 34px; padding: 0 12px; white-space: nowrap; }
  .remoteWorkspace__tab:hover { background: var(--ro-hover); color: var(--ro-text); }
  .remoteWorkspace__tab[data-active='true'] { background: var(--ro-active); border-color: transparent; color: var(--ro-text); }
  .remoteWorkspace__view { display: flex; flex: 1; min-height: 0; }
  .remoteWorkspace__editor, .remoteWorkspace__terminal, .remoteWorkspace__changes { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
  .remoteWorkspace__editorbar { align-items: center; border-bottom: 1px solid var(--ro-line); display: flex; height: 40px; justify-content: space-between; padding: 0 14px; }
  .remoteWorkspace__editorPath { color: var(--ro-muted); font: 12px ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteWorkspace__editorActions { align-items: center; display: flex; flex: none; gap: 6px; }
  .remoteWorkspace__editorTextArea { background: var(--ro-code-bg); border: 0; color: var(--ro-text); flex: 1; font: var(--dsw-font-markdown-code-block, 13px/22px ui-monospace, Consolas, monospace); min-height: 0; outline: none; overflow: auto; overflow-wrap: anywhere; padding: 16px 20px; resize: none; tab-size: 2; white-space: pre-wrap; word-break: break-word; }
  .remoteWorkspace__codeView { background: var(--ro-code-bg); border: 0 !important; border-radius: 0 !important; flex: 1; margin: 0 !important; min-height: 0; overflow: auto; }
  .remoteWorkspace__codeView > div:nth-child(2) { overflow: visible !important; }
  .remoteWorkspace__codeView > div:nth-child(2) > div { align-items: start; min-width: 0; }
  .remoteWorkspace__codeView > div:nth-child(2) > div > span:last-child { overflow-wrap: anywhere; white-space: pre-wrap !important; word-break: break-word; }
  .remoteWorkspace__codeFallback { background: var(--ro-code-bg); color: var(--ro-text); flex: 1; font: var(--dsw-font-markdown-code-block, 13px/22px ui-monospace, Consolas, monospace); margin: 0; overflow: auto; overflow-wrap: anywhere; padding: 16px 20px; white-space: pre-wrap; word-break: break-word; }
  .remoteWorkspace__editorFooter { align-items: center; border-top: 1px solid var(--ro-line); color: var(--ro-dim); display: flex; font-size: 11px; gap: 14px; height: 28px; padding: 0 14px; }
  .remoteWorkspace__dirty { color: #e5b96b; font-size: 11px; }
  .remoteWorkspace__empty { align-items: center; color: var(--ro-dim); display: flex; flex: 1; flex-direction: column; font-size: 12px; gap: 10px; justify-content: center; }
  .remoteWorkspace__explorer { background: var(--ro-panel); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .remoteWorkspace__explorerHead { align-items: center; border-bottom: 1px solid var(--ro-line); display: flex; height: 42px; justify-content: space-between; padding: 0 10px 0 14px; }
  .remoteWorkspace__label { color: var(--ro-muted); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .remoteWorkspace__search { border-bottom: 1px solid var(--ro-line); padding: 9px 10px; }
  .remoteWorkspace__searchInput { background: var(--ro-input-bg) !important; border-color: var(--ro-line) !important; color: var(--ro-text) !important; width: 100%; }
  .remoteWorkspace__searchInput input { background: transparent !important; color: var(--ro-text) !important; font: 12px ui-monospace, Consolas, monospace; }
  .remoteWorkspace__searchInput input::placeholder { color: var(--ro-dim); }
  .remoteWorkspace__iconButton { min-width: 28px; padding: 0 !important; }
  .remoteWorkspace__tree { min-height: 0; overflow: auto; padding: 7px 6px 18px; }
  .remoteWorkspace__treeEntry { align-items: center; background: transparent; border: 0; color: var(--ro-muted); cursor: pointer; display: flex; font: 12px/28px ui-monospace, Consolas, monospace; height: 28px; min-width: 0; padding: 0 6px; text-align: left; width: 100%; }
  .remoteWorkspace__treeEntry:hover, .remoteWorkspace__treeEntry[data-active='true'] { background: var(--ro-hover); color: var(--ro-text); }
  .remoteWorkspace__treeChevron { color: var(--ro-dim); flex: none; font-family: sans-serif; text-align: center; width: 17px; }
  .remoteWorkspace__treeName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteWorkspace__treeMessage { color: var(--ro-dim); font-size: 12px; padding: 8px; }
  .remoteWorkspace__terminal { background: var(--ro-bg); color: var(--ro-text); font: 13px/1.55 ui-monospace, Consolas, monospace; padding: 16px 18px; }
  .remoteWorkspace__output { flex: 1; margin: 0; min-height: 0; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .remoteWorkspace__terminalbar { align-items: center; display: flex; flex: none; gap: 8px; margin-top: 5px; min-height: 24px; }
  .remoteWorkspace__terminalPrompt { color: #75d19a; white-space: nowrap; }
  .remoteWorkspace__input { background: transparent; border: 0; color: inherit; flex: 1; font: inherit; min-width: 0; outline: none; }
  .remoteWorkspace__changes { gap: 0; overflow: auto; padding: 0 14px 20px; }
  .remoteWorkspace__change { border-bottom: 1px solid var(--ro-line); display: block; padding: 14px 0; }
  .remoteWorkspace__changeHead { align-items: center; display: flex; gap: 12px; justify-content: space-between; margin-bottom: 10px; }
  .remoteWorkspace__changeMain { min-width: 0; }
  .remoteWorkspace__changePath { color: var(--ro-text); font: 12px ui-monospace, Consolas, monospace; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteWorkspace__changeMeta { color: var(--ro-muted); display: block; font-size: 11px; margin-top: 4px; }
  .remoteWorkspace__changeActions { display: flex; flex: none; gap: 4px; }
  .remoteWorkspace__nativeDiff { margin: 0; max-width: 100%; overflow: hidden; }
  .remoteWorkspace__diffFallback { background: var(--ro-code-bg); border: 1px solid var(--ro-line); font: 11px/1.45 ui-monospace, Consolas, monospace; margin: 0; max-height: 260px; overflow: auto; overflow-wrap: anywhere; padding: 10px; white-space: pre-wrap; word-break: break-word; }
  .remoteWorkspace__error { background: #3a2024; border-bottom: 1px solid #63343c; color: #ffabb2; font-size: 12px; padding: 8px 14px; }
  .remoteWorkspace__launcher { display: inline-flex; position: relative; z-index: 19; }
  .remoteWorkspace__serverMenu { background: var(--ro-menu-bg); border: 1px solid var(--ro-line); border-radius: 8px; box-shadow: var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.06)); color: var(--ro-text); display: flex; flex-direction: column; gap: 2px; min-width: 250px; padding: 6px; position: absolute; right: 0; top: calc(100% + 8px); z-index: 3; }
  .remoteWorkspace__serverOption { background: transparent; border: 0; color: var(--ro-muted); cursor: pointer; display: flex; justify-content: space-between; padding: 9px; text-align: left; width: 100%; }
  .remoteWorkspace__serverOption:hover { background: var(--ro-hover); color: var(--ro-text); }
  .remoteWorkspace__serverStatus { color: var(--ro-dim); font-size: 11px; }
  @media (max-width: 1100px) { .remoteWorkspace { inset: 0 0 0 max(280px, var(--ro-workspace-left, 50vw)); } .remoteWorkspace__workspace { grid-template-columns: minmax(0, 1fr) 5px minmax(220px, var(--ro-explorer-width, 250px)); } }
  @media (max-width: 760px) { .remoteWorkspace { inset: 0; } }
  @media (max-width: 620px) { .remoteWorkspace__explorer { display: none; } }
  .remoteOps { display: flex; flex-direction: column; gap: 20px; max-width: 920px; padding: 4px 0 30px; }
  .remoteOps__settingsHead, .remoteOps__hostCardHead, .remoteOps__hostActions, .remoteOps__sectionTitle { align-items: center; display: flex; justify-content: space-between; gap: 12px; }
  .remoteOps__settingsHead h2 { font-size: 18px; margin: 0; }
  .remoteOps__settingsHead p { color: var(--ro-muted); font-size: 12px; margin: 4px 0 0; }
  .remoteOps__overview { border-bottom: 1px solid var(--ro-line); border-top: 1px solid var(--ro-line); display: grid; grid-template-columns: repeat(3, 1fr); }
  .remoteOps__overview div { display: flex; flex-direction: column; gap: 5px; padding: 13px 16px; }
  .remoteOps__overview div + div { border-left: 1px solid var(--ro-line); }
  .remoteOps__overview span { color: var(--ro-dim); font-size: 11px; }
  .remoteOps__overview strong { font-size: 13px; font-weight: 600; }
  .remoteOps__iconButton, .remoteOps__modeSwitch button, .remoteOps__hostActions button, .remoteOps__cancel { cursor: pointer; font-size: 12px; min-height: 30px; }
  .remoteOps__modeSwitch { background: var(--ro-panel); border: 1px solid var(--ro-line); border-radius: 7px; display: inline-flex; padding: 2px; width: max-content; }
  .remoteOps__modeSwitch button[data-active='true'] { background: var(--ro-panel-2); color: var(--ro-text); }
  .remoteOps__connectForm { background: var(--ro-panel); border: 1px solid var(--ro-line); border-radius: 8px; display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 16px; }
  .remoteOps__field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .remoteOps__field > span { color: var(--ro-muted); font-size: 11px; }
  .remoteOps__field > span:not(:first-child), .remoteOps__field input { min-width: 0; width: 100%; }
  .remoteOps__endpoint { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) 92px; }
  .remoteOps__connectForm input, .remoteOps__sectionTitle select { color: var(--ro-text); font: inherit; font-size: 12px; }
  .remoteOps__sectionTitle select { background: var(--ro-bg); border: 1px solid var(--ro-line); border-radius: 6px; height: 30px; padding: 0 9px; }
  .remoteOps__formFooter { align-items: center; border-top: 1px solid var(--ro-line); color: var(--ro-dim); display: flex; font-size: 11px; justify-content: space-between; padding-top: 12px; }
  .remoteOps__wideInput { grid-column: 1 / -1; }
  .remoteOps__primary { cursor: pointer; font-size: 12px; font-weight: 600; min-width: 92px; }
  .remoteOps__primary:disabled { cursor: default; opacity: .45; }
  .remoteOps__notice { border-radius: 6px; font-size: 12px; padding: 9px 12px; }
  .remoteOps__notice--error { background: var(--dsw-alias-state-error-secondary, #fff0ef); color: var(--ro-danger); }
  .remoteOps__notice--success { background: var(--dsw-alias-state-success-secondary, #edf9f2); color: var(--ro-success); }
  .remoteOps__settingsSection { display: flex; flex-direction: column; gap: 9px; }
  .remoteOps__sectionTitle { color: var(--ro-muted); font-size: 12px; font-weight: 600; }
  .remoteOps__hostCard { background: var(--ro-panel); border: 1px solid var(--ro-line); border-radius: 8px; padding: 15px; position: relative; }
  .remoteOps__hostCard[data-current='true']::before { background: var(--ro-accent); border-radius: 2px; bottom: 14px; content: ''; left: -1px; position: absolute; top: 14px; width: 3px; }
  .remoteOps__hostCardHead strong { display: block; font-size: 13px; }
  .remoteOps__hostCardHead span { color: var(--ro-muted); display: block; font: 11px ui-monospace, Consolas, monospace; margin-top: 3px; }
  .remoteOps__status { border-radius: 999px; font-size: 11px !important; margin: 0 !important; padding: 3px 8px; }
  .remoteOps__status--online { background: var(--dsw-alias-state-success-secondary, #edf9f2); color: var(--ro-success) !important; }
  .remoteOps__status--auth_failed, .remoteOps__status--offline, .remoteOps__status--key_missing { background: var(--dsw-alias-state-error-secondary, #fff0ef); color: var(--ro-danger) !important; }
  .remoteOps__status--connecting, .remoteOps__status--degraded { background: var(--dsw-alias-state-warn-secondary, #fff8e8); color: var(--dsw-alias-state-warn-primary, #a86b00) !important; }
  .remoteOps__facts { border-bottom: 1px solid var(--ro-line); border-top: 1px solid var(--ro-line); display: grid; gap: 12px 18px; grid-template-columns: repeat(3, 1fr); margin: 13px 0; padding: 12px 0; }
  .remoteOps__factWide { grid-column: span 2; }
  .remoteOps__facts dt { color: var(--ro-dim); font-size: 10px; }
  .remoteOps__facts dd { color: var(--ro-muted); font-size: 12px; margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteOps__hostError { color: var(--ro-danger); font-size: 12px; margin: 0 0 10px; }
  .remoteOps__hostActions { justify-content: flex-start; }
  .remoteOps__hostActions button:hover, .remoteOps__iconButton:hover, .remoteOps__cancel:hover { background: var(--ro-panel-2); color: var(--ro-text); }
  .remoteOps__jobList { display: flex; flex-direction: column; gap: 7px; list-style: none; margin: 0; padding: 0; }
  .remoteOps__job { background: var(--ro-panel); border: 1px solid var(--ro-line); border-radius: 7px; overflow: hidden; }
  .remoteOps__jobRow { align-items: center; background: transparent; border: 0; color: var(--ro-muted); cursor: pointer; display: flex; font: inherit; font-size: 12px; justify-content: space-between; padding: 11px 12px; text-align: left; width: 100%; }
  .remoteOps__jobRow > span:first-child { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .remoteOps__jobRow strong, .remoteOps__jobRow small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remoteOps__jobRow strong { color: var(--ro-text); font-size: 12px; }
  .remoteOps__jobRow small { color: var(--ro-dim); font: 10px ui-monospace, Consolas, monospace; }
  .remoteOps__jobStatus { border-radius: 999px; flex: none; font-size: 10px; margin-left: 12px; padding: 3px 7px; }
  .remoteOps__jobStatus--running { background: var(--dsw-alias-state-business-tertiary, var(--ro-panel-2)); color: var(--ro-accent); }
  .remoteOps__jobStatus--succeeded { color: var(--ro-success); }
  .remoteOps__jobStatus--failed, .remoteOps__jobStatus--timed_out { color: var(--ro-danger); }
  .remoteOps__jobDetail { border-top: 1px solid var(--ro-line); padding: 10px 12px 12px; }
  .remoteOps__jobDetail dl { display: flex; gap: 24px; margin: 0 0 9px; }
  .remoteOps__jobDetail dt { color: var(--ro-dim); font-size: 10px; }
  .remoteOps__jobDetail dd { color: var(--ro-muted); font-size: 11px; margin: 2px 0 0; }
  .remoteOps__jobLog { background: #111; border: 1px solid var(--ro-line); color: #ccc; font: 11px/1.5 ui-monospace, Consolas, monospace; margin: 0; max-height: 180px; overflow: auto; padding: 10px; white-space: pre-wrap; }
  .remoteOps__cancel { color: var(--ro-danger); margin: 0 12px 10px; }
  .remoteOps__danger { background: transparent; border: 1px solid transparent; color: var(--ro-danger); cursor: pointer; font-size: 12px; min-height: 30px; padding: 0 8px; }
  .remoteOps__danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(213, 73, 65, .08)); }
  .remoteOps__empty { align-items: center; border: 1px dashed var(--ro-line); color: var(--ro-muted); display: flex; justify-content: center; min-height: 74px; padding: 14px; }
  @media (max-width: 620px) { .remoteOps__overview { grid-template-columns: 1fr; } .remoteOps__overview div + div { border-left: 0; border-top: 1px solid var(--ro-line); } .remoteOps__connectForm { grid-template-columns: 1fr; } .remoteOps__wideInput { grid-column: auto; } .remoteOps__facts { grid-template-columns: 1fr 1fr; } .remoteOps__factWide { grid-column: 1 / -1; } }
`
