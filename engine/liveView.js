// Live view of a job's browser for its owner.
// Frames go out as JPEG over WebSocket. Clicks and keys come back from the
// viewer and are applied ONLY while the job is waiting for a human step
// (for example a reCAPTCHA checkbox the person must tick themselves).

class LiveView {
  constructor(page, isAcceptingInput) {
    this.page = page;
    this.isAcceptingInput = isAcceptingInput;
    this.viewers = new Set();
    this.cdp = null;
    this.lastFrame = null;
    this.viewport = page.viewportSize() || { width: 1024, height: 768 };
  }

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
      this.lastFrame = { data, metadata };
      const msg = JSON.stringify({ type: 'frame', data, w: metadata.deviceWidth, h: metadata.deviceHeight });
      for (const ws of this.viewers) if (ws.readyState === 1) ws.send(msg);
      await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1024, maxHeight: 1400, everyNthFrame: 2 });
  }

  attach(ws) {
    this.viewers.add(ws);
    if (this.lastFrame) {
      const { data, metadata } = this.lastFrame;
      ws.send(JSON.stringify({ type: 'frame', data, w: metadata.deviceWidth, h: metadata.deviceHeight }));
    }
    ws.on('message', (raw) => this.onInput(raw).catch(() => {}));
    ws.on('close', () => this.viewers.delete(ws));
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.viewers) if (ws.readyState === 1) ws.send(msg);
  }

  async onInput(raw) {
    if (!this.isAcceptingInput()) return;
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const vw = this.viewport.width;
    const vh = this.viewport.height;
    if (m.type === 'click') {
      // Coordinates arrive as fractions of the frame (0..1) so screen size does not matter.
      const x = Math.min(Math.max(Number(m.fx) || 0, 0), 1) * vw;
      const y = Math.min(Math.max(Number(m.fy) || 0, 0), 1) * vh;
      await this.page.mouse.click(x, y);
    } else if (m.type === 'scroll') {
      const dy = Math.max(-2000, Math.min(2000, Number(m.dy) || 0));
      await this.page.mouse.wheel(0, dy);
    }
    // Typing is deliberately not relayed: a human step here is only a click
    // or a scroll. Codes such as an SMS OTP go through the OTP endpoint.
  }

  async stop() {
    for (const ws of this.viewers) { try { ws.close(); } catch { /* ignore */ } }
    this.viewers.clear();
    if (this.cdp) await this.cdp.send('Page.stopScreencast').catch(() => {});
  }
}

module.exports = { LiveView };
