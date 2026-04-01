/*
 * ============================================================
 * AI Chroney — India Relay Server
 * ============================================================
 *
 * PURPOSE
 *   Forwards CRM sync requests from AI Chroney (US server) to
 *   Caprion LOS or any other CRM that only accepts requests
 *   from Indian IP addresses.
 *
 * DEPLOY INSTRUCTIONS (AWS Mumbai / any India server)
 * ----------------------------------------------------------
 * 1. Launch a t3.micro EC2 in ap-south-1 (Mumbai)
 *    - OS: Ubuntu 22.04 LTS
 *    - Security group: allow inbound TCP port 3000 from your
 *      AI Chroney server IP (or 0.0.0.0/0 if using RELAY_SECRET)
 *
 * 2. Install Node.js on the server:
 *      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
 *      sudo apt install -y nodejs
 *
 * 3. Copy this file to the server:
 *      scp relay-server.js ubuntu@<ec2-ip>:~/relay-server.js
 *
 * 4. Install the only dependency:
 *      npm install express node-fetch
 *    (or use global fetch if Node >= 18, no install needed)
 *
 * 5. Set environment variables and start:
 *      RELAY_SECRET=your-strong-random-secret node relay-server.js
 *
 * 6. (Optional) Keep it running with PM2:
 *      npm install -g pm2
 *      RELAY_SECRET=your-strong-random-secret pm2 start relay-server.js
 *      pm2 save && pm2 startup
 *
 * 7. Set the Relay URL in AI Chroney:
 *      CRM → Connection Settings → Relay URL
 *      Value: http://<ec2-public-ip>:3000
 *
 * ENVIRONMENT VARIABLES
 *   RELAY_SECRET  — Required. A shared secret between this relay and AI
 *                   Chroney. If set, every request must carry the header:
 *                     Authorization: Bearer <RELAY_SECRET>
 *                   Set the same value in your server environment as
 *                   CUSTOM_CRM_RELAY_SECRET (AI Chroney will send it).
 *   PORT          — Default 3000. The port to listen on.
 *
 * SECURITY NOTES
 *   - Always set RELAY_SECRET to a long random string (32+ chars).
 *   - This relay only forwards POST requests to non-localhost URLs.
 *   - Consider running behind nginx with HTTPS for production.
 * ============================================================
 */

const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

const RELAY_SECRET = process.env.RELAY_SECRET || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', relay: 'AI Chroney India Relay', time: new Date().toISOString() });
});

app.post('/relay', async (req, res) => {
  try {
    // Authenticate request if RELAY_SECRET is configured
    if (RELAY_SECRET) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== RELAY_SECRET) {
        console.warn(`[Relay] Unauthorized request from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { targetUrl, method, contentType, headers: extraHeaders, body } = req.body;

    // Validate required fields
    if (!targetUrl || typeof targetUrl !== 'string') {
      return res.status(400).json({ error: 'Missing targetUrl' });
    }
    if (!body && body !== '') {
      return res.status(400).json({ error: 'Missing body' });
    }

    // Block private/local addresses for security
    const parsed = new URL(targetUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      console.warn(`[Relay] Blocked request to private address: ${targetUrl}`);
      return res.status(400).json({ error: 'Private/internal addresses not allowed' });
    }

    const forwardHeaders = {
      'Content-Type': contentType || 'application/x-www-form-urlencoded',
      ...(extraHeaders || {}),
    };

    console.log(`[Relay] Forwarding ${method || 'POST'} → ${targetUrl}`);

    const upstream = await fetch(targetUrl, {
      method: method || 'POST',
      headers: forwardHeaders,
      body: body,
    });

    const responseText = await upstream.text();
    console.log(`[Relay] Upstream responded ${upstream.status} — ${responseText.slice(0, 200)}`);

    // Mirror upstream status and body back to AI Chroney
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-type', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.send(responseText);
  } catch (err) {
    console.error('[Relay] Error:', err);
    res.status(502).json({ error: 'Relay failed', detail: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Relay] AI Chroney India Relay running on port ${PORT}`);
  if (!RELAY_SECRET) {
    console.warn('[Relay] WARNING: RELAY_SECRET is not set — relay is open to anyone. Set it in production!');
  } else {
    console.log('[Relay] RELAY_SECRET is configured — requests require Authorization header.');
  }
});
