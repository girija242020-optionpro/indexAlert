// .env is optional (Render injects real env vars); dotenv only matters for local dev.
try { await import('dotenv/config'); } catch { /* not installed / not needed */ }

const e = process.env;
const num = (k, d) => (e[k] !== undefined && e[k] !== '' && Number.isFinite(+e[k]) ? +e[k] : d);
const list = (k, d) => (e[k] ? e[k].split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  port: num('PORT', 8080),
  apiKey: e.API_KEY || '',
  allowedOrigins: list('ALLOWED_ORIGINS', ['*']),
  dataDir: e.DATA_DIR || './data',
  riskFreeRate: num('RISK_FREE_RATE', 0.07),
  dhan: {
    clientId: e.DHAN_CLIENT_ID || '',
    accessToken: e.DHAN_ACCESS_TOKEN || '',
    pin: e.DHAN_PIN || '',
    totpSecret: e.DHAN_TOTP_SECRET || '',
    apiBase: 'https://api.dhan.co/v2',
    authBase: 'https://auth.dhan.co',
    feedUrl: 'wss://api-feed.dhan.co',
    depthUrl: 'wss://depth-api-feed.dhan.co/twentydepth',
    scripMasterUrl: e.SCRIP_MASTER_URL || 'https://images.dhan.co/api-data/api-scrip-master.csv',
  },
  feed: {
    staleMs: num('STALE_MS', 15000),
    packetTimeoutMs: num('PACKET_TIMEOUT_MS', 30000),
    // 15 = Ticker (LTP only, guaranteed for indices). 17 = Quote. 21 = Full.
    indexSubCode: num('INDEX_SUB_CODE', 15),
    maxDepthInstruments: 50,
  },
  depthMarkets: list('DEPTH_MARKETS', ['NIFTY']),
  vapid: {
    publicKey: e.VAPID_PUBLIC_KEY || '',
    privateKey: e.VAPID_PRIVATE_KEY || '',
    subject: e.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  futOverride: {
    NIFTY: e.NIFTY_FUT_SECURITY_ID || '',
    SENSEX: e.SENSEX_FUT_SECURITY_ID || '',
  },
};

// Underlying indices. Security IDs / segments per Dhan v2 (IDX_I: NIFTY 50 = 13, SENSEX = 51).
export const MARKETS = {
  NIFTY: { symbol: 'NIFTY', securityId: '13', segment: 'IDX_I', futExchange: 'NSE', futSegment: 'NSE_FNO', prefix: 'NIFTY' },
  SENSEX: { symbol: 'SENSEX', securityId: '51', segment: 'IDX_I', futExchange: 'BSE', futSegment: 'BSE_FNO', prefix: 'SENSEX' },
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), 'WARN', ...a);
