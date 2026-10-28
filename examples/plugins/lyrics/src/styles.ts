/**
 * Class names are global, so everything here starts with `lyr-`. Colours and motion come
 * from custom properties the view sets from the user's settings.
 */
export const css = /* css */ `
.lyr-pane {
  --lyr-fg: #fff;
  --lyr-dim: rgb(255 255 255 / 0.38);
  --lyr-sub: rgb(255 255 255 / 0.72);
  container-type: size;
  position: relative;
  isolation: isolate;
  overflow: hidden;
  width: 100%;
  height: 100%;
  color: var(--lyr-fg);
  font-weight: var(--lyr-weight, 700);
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.lyr-inline {
  --lyr-fs: clamp(17px, 5.6cqw, 30px);
  max-width: 620px;
  border-radius: 28px;
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.35);
  cursor: pointer;
}

.lyr-full {
  --lyr-fs: clamp(26px, 7.6cqw, 46px);
}

/* ---- background ---- */
.lyr-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  background: #111;
}

.lyr-bg-art {
  position: absolute;
  inset: -30%;
  filter: blur(46px) saturate(1.7) brightness(0.62);
  transform: scale(1.25);
}

.lyr-bg-art > * {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.lyr-bg-art.is-moving {
  animation: lyr-drift 48s linear infinite;
}

.lyr-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgb(0 0 0 / 0.12), rgb(0 0 0 / 0.38));
}

.lyr-plain-bg .lyr-bg {
  background: #141414;
}

.lyr-plain-bg .lyr-bg::after {
  display: none;
}

@keyframes lyr-drift {
  from { transform: scale(1.25) rotate(0deg); }
  to { transform: scale(1.25) rotate(360deg); }
}

/* ---- scrolling ---- */
.lyr-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  mask-image: linear-gradient(180deg, transparent 0, #000 9%, #000 86%, transparent 100%);
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 9%, #000 86%, transparent 100%);
}

.lyr-viewport.is-plain {
  overflow-y: auto;
  touch-action: pan-y;
  scrollbar-width: none;
}

.lyr-track {
  position: relative;
  padding: 0 var(--lyr-pad, 22px);
  will-change: transform;
}

.lyr-spacer-top { height: 20cqh; }
.lyr-spacer { height: 70cqh; }

/* ---- lines ---- */
.lyr-line {
  position: relative;
  padding: 0.28em 0;
  font-size: var(--lyr-fs);
  line-height: 1.22;
  text-align: var(--lyr-align, left);
  letter-spacing: -0.01em;
  will-change: transform;
  --d: 6;
  --rel: 0;
}

.lyr-line.is-right { text-align: right; }

.lyr-body {
  display: block;
  transform-origin: var(--lyr-origin, left center);
  transform: scale(var(--lyr-inactive-scale, 0.94));
  opacity: var(--lyr-inactive-opacity, 0.34);
  filter: blur(calc(min(var(--d), 3) * var(--lyr-blur-step, 1px)));
  transition:
    transform 0.55s cubic-bezier(0.22, 0.9, 0.3, 1) calc(var(--rel) * var(--lyr-stagger, 40ms)),
    opacity 0.45s ease calc(var(--rel) * var(--lyr-stagger, 40ms)),
    filter 0.45s ease calc(var(--rel) * var(--lyr-stagger, 40ms));
}

.lyr-line.is-near .lyr-body { opacity: calc(var(--lyr-inactive-opacity, 0.34) * 1.15); }

.lyr-line.is-active .lyr-body {
  transform: scale(1);
  opacity: 1;
  filter: none;
}

.lyr-no-focus .lyr-body { transform: none; filter: none; }
.lyr-no-focus .lyr-line.is-active .lyr-body { transform: none; }
.lyr-no-blur .lyr-body { filter: none; }

.lyr-scrolling .lyr-body {
  filter: none;
  opacity: 0.62;
  transition-delay: 0s;
}
.lyr-scrolling .lyr-line.is-active .lyr-body { opacity: 1; }

.lyr-reduced .lyr-body,
.lyr-reduced .lyr-word { transition: none !important; }

.lyr-line.is-seekable { cursor: pointer; }

/* words */
.lyr-text { display: block; overflow-wrap: anywhere; }
.lyr-group { display: inline-block; white-space: nowrap; }

.lyr-word {
  --p: 0;
  display: inline-block;
  white-space: pre;
  transition: transform 0.4s ease, filter 0.4s ease;
}

.lyr-line.is-active .lyr-word {
  color: transparent;
  background-image: linear-gradient(
    90deg,
    var(--lyr-fg) calc(var(--p) * 130% - 30%),
    var(--lyr-dim) calc(var(--p) * 130%)
  );
  -webkit-background-clip: text;
  background-clip: text;
  transform: translateY(calc(var(--p) * var(--lyr-lift, 3) * -1px));
  transition: none;
}

.lyr-line.is-active .lyr-word.is-singing {
  filter: drop-shadow(0 0 0.35em rgb(255 255 255 / var(--lyr-glow, 0.35)));
}

/* Lines that are synced as a whole just brighten. */
.lyr-line:not(.is-active) .lyr-text { color: var(--lyr-fg); }

/* background vocals */
.lyr-line.is-bg { font-size: calc(var(--lyr-fs) * 0.62); font-weight: calc(var(--lyr-weight, 700) - 100); padding-top: 0; }
.lyr-line.is-bg .lyr-body { opacity: calc(var(--lyr-inactive-opacity, 0.34) * 0.7); }
.lyr-line.is-bg.is-active .lyr-body { opacity: 0.85; }

/* romanization and translation */
.lyr-sub {
  display: block;
  margin-top: 0.22em;
  font-size: calc(var(--lyr-fs) * var(--lyr-sub-scale, 0.5));
  font-weight: 600;
  line-height: 1.25;
  color: var(--lyr-sub);
}

.lyr-roman { font-style: italic; letter-spacing: 0.01em; }

/* instrumental breaks */
.lyr-dots-body {
  display: flex;
  gap: 0.32em;
  height: 1.2em;
  padding-top: 0.35em;
}

.lyr-line.lyr-dots { padding: 0.15em 0; }
.lyr-line.lyr-dots .lyr-body { transform: scale(0.5); opacity: 0; filter: none; transform-origin: var(--lyr-origin, left center); }
.lyr-line.lyr-dots.is-active .lyr-body { transform: scale(1); opacity: 1; animation: lyr-breathe 2.6s ease-in-out infinite; }

.lyr-dot {
  width: 0.5em;
  height: 0.5em;
  border-radius: 50%;
  background: var(--lyr-fg);
  opacity: var(--o, 0.28);
}

@keyframes lyr-breathe {
  0%, 100% { transform: scale(0.92); }
  50% { transform: scale(1.12); }
}

/* plain (unsynced) lyrics */
.lyr-viewport.is-plain .lyr-line { padding: 0.12em 0; }
.lyr-viewport.is-plain .lyr-body { opacity: 0.92; transform: none; filter: none; }
.lyr-viewport.is-plain .lyr-line { font-size: calc(var(--lyr-fs) * 0.82); font-weight: 600; }

/* messages and buttons on the pane */
.lyr-message {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--lyr-sub);
}

.lyr-spinner {
  width: 26px;
  height: 26px;
  margin: 0 auto;
  border: 3px solid rgb(255 255 255 / 0.25);
  border-top-color: #fff;
  border-radius: 50%;
  animation: lyr-spin 0.8s linear infinite;
}

@keyframes lyr-spin { to { transform: rotate(360deg); } }

.lyr-corner {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: flex;
  gap: 6px;
}

.lyr-icon-button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: rgb(0 0 0 / 0.32);
  cursor: pointer;
}

.lyr-icon-button.is-active { background: rgb(255 255 255 / 0.9); color: #111; }
.lyr-icon-button:disabled { opacity: 0.4; }

.lyr-cover-wrap {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}

/* ---- the source list in settings (drag to reorder) ---- */
.lyr-src { margin: 0 16px 12px; }
.lyr-src-hint { margin: 0 4px 8px; }
.lyr-src-list { margin: 0; padding: 0; list-style: none; }
.lyr-src-row { display: flex; align-items: center; padding: 0; transition: transform 0.18s var(--md-sys-motion-easing, ease); }
.lyr-src-list.is-settling .lyr-src-row { transition: none; }
.lyr-src-row.is-dragging { position: relative; z-index: 1; transition: none; box-shadow: var(--md-sys-elevation-3, 0 4px 16px rgb(0 0 0 / 0.3)); background: var(--md-sys-color-surface-container-highest, inherit); }
.lyr-src-row.is-off .settings-row-text { opacity: 0.5; }
.lyr-src-handle { display: grid; place-items: center; flex: none; width: 48px; align-self: stretch; color: var(--md-sys-color-on-surface-variant); cursor: grab; touch-action: none; }
.lyr-src-main { display: flex; flex: 1; align-items: center; gap: 12px; min-width: 0; padding: 12px 4px 12px 16px; text-align: left; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; }
.lyr-src-main .settings-row-text { flex: 1; min-width: 0; }

/* ---- full screen ---- */
.lyr-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  color: #fff;
  background: #000;
}

.lyr-overlay .lyr-pane { flex: 1 1 auto; min-height: 0; }

.lyr-top {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: calc(var(--safe-top, 0px) + 8px) 14px 8px;
}

.lyr-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  line-height: 1.25;
}

.lyr-titles strong,
.lyr-titles span {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lyr-titles strong { font-size: 15px; }
.lyr-titles span { font-size: 13px; opacity: 0.72; }

.lyr-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 17px;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  background: rgb(0 0 0 / 0.32);
  cursor: pointer;
}

.lyr-chip.is-active { background: rgb(255 255 255 / 0.92); color: #111; }
.lyr-chip.is-error { outline: 1px solid #ff8a80; }

.lyr-bottom {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 3;
  padding: 18px 22px calc(var(--safe-bottom, 0px) + 14px);
  background: linear-gradient(0deg, rgb(0 0 0 / 0.55), transparent);
}

.lyr-bottom {
  /* The seek bar is the app's own; give it colours that read on the dark backdrop. */
  --md-sys-color-primary: #fff;
  --md-sys-color-secondary-container: rgb(255 255 255 / 0.28);
  --md-sys-color-on-surface-variant: rgb(255 255 255 / 0.8);
}

.lyr-bottom .seek { margin-bottom: 4px; }

.lyr-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
}

.lyr-controls .lyr-icon-button { width: 48px; height: 48px; background: transparent; }
.lyr-controls .lyr-play { width: 60px; height: 60px; background: rgb(255 255 255 / 0.92); color: #111; }

.lyr-status {
  position: absolute;
  right: 14px;
  bottom: calc(var(--safe-bottom, 0px) + 116px);
  z-index: 3;
  max-width: min(70%, 420px);
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: rgb(0 0 0 / 0.5);
}

.lyr-fade-enter-active,
.lyr-fade-leave-active { transition: opacity 0.28s ease, transform 0.32s cubic-bezier(0.22, 0.9, 0.3, 1); }
.lyr-fade-enter-from,
.lyr-fade-leave-to { opacity: 0; transform: scale(1.03); }

@media (max-width: 560px) {
  .lyr-chip-label { display: none; }
  .lyr-chip { width: 36px; height: 36px; padding: 0; justify-content: center; }
}

@media (min-width: 840px) {
  .lyr-full .lyr-track { max-width: 820px; margin: 0 auto; }
}
`
