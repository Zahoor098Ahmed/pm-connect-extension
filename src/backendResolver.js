const fetch = require("node-fetch");

const CHECK_TIMEOUT_MS = 2500;
const REFRESH_INTERVAL_MS = 30 * 1000;

const DEFAULT_LOCAL_CANDIDATES = [
  "http://localhost:5052/api/pmconnect",
  "http://localhost:5173/api/pmconnect",
  "http://localhost:5000/api/pmconnect",
  "http://localhost:4000/api/pmconnect",
  "http://localhost:3000/api/pmconnect",
  "http://localhost:3050/api/pmconnect",
];

/**
 * Picks between a local dev ERP and the live/production one, automatically —
 * no manual URL switching.
 * If a local instance is reachable, everything goes there.
 * If not, falls back to the live ERP.
 * If live is not running, seamlessly targets the local ERP.
 */
class BackendResolver {
  constructor() {
    this.cachedBase = null;
    this.cachedIsLocal = false;
    this.refreshInFlight = null;
  }

  async checkReachable(url) {
    if (!url) return false;
    const cleanUrl = url.replace(/\/+$/, "");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      const res = await fetch(cleanUrl, { method: "GET", signal: controller.signal });
      clearTimeout(timeout);
      // Status < 500 means server is alive and responding (including 200, 404, 401, 405)
      return res.status < 500;
    } catch {
      // Try root health endpoint if subpath refused/failed
      try {
        const rootUrl = cleanUrl.replace(/\/api\/pmconnect.*$/, "/api/health");
        if (rootUrl !== cleanUrl) {
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), CHECK_TIMEOUT_MS);
          const res2 = await fetch(rootUrl, { method: "GET", signal: controller2.signal });
          clearTimeout(timeout2);
          return res2.status < 500;
        }
      } catch {
        /* silent */
      }
      return false;
    }
  }

  /**
   * Re-checks which backend to use and updates the cache. Safe to call
   * repeatedly/concurrently — collapses into a single in-flight check.
   */
  async refresh(getConfig) {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const configuredLocal = typeof getConfig === "function" ? getConfig("pmConnect.custom.localBaseUrl", "") : "";
      const configuredLive = typeof getConfig === "function" ? getConfig("pmConnect.custom.baseUrl", "") : "";
      const liveBaseUrl = configuredLive || "https://crm.tgailab.site/api/pmconnect";

      // 1. Build local candidate list: configured first, then known local ports
      const localCandidates = [];
      if (configuredLocal) localCandidates.push(configuredLocal);
      for (const candidate of DEFAULT_LOCAL_CANDIDATES) {
        if (!localCandidates.includes(candidate)) {
          localCandidates.push(candidate);
        }
      }

      // 2. Test local candidates
      let foundLocal = null;
      for (const candidate of localCandidates) {
        if (await this.checkReachable(candidate)) {
          foundLocal = candidate;
          break;
        }
      }

      if (foundLocal) {
        this.cachedBase = foundLocal;
        this.cachedIsLocal = true;
        return this.cachedBase;
      }

      // 3. If no local reachable, test live backend
      if (liveBaseUrl && (await this.checkReachable(liveBaseUrl))) {
        this.cachedBase = liveBaseUrl;
        this.cachedIsLocal = false;
        return this.cachedBase;
      }

      // 4. If neither responded, keep last known or default to configured local/first candidate
      if (!this.cachedBase) {
        this.cachedBase = configuredLocal || DEFAULT_LOCAL_CANDIDATES[0];
        this.cachedIsLocal = true;
      }
      return this.cachedBase;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  /**
   * Synchronous read for hot paths — returns the last-known choice without
   * blocking on a network check.
   */
  getCachedBaseUrl(getConfig) {
    if (this.cachedBase) return this.cachedBase;
    this.refresh(getConfig).catch(() => {});
    const configuredLocal = typeof getConfig === "function" ? getConfig("pmConnect.custom.localBaseUrl", "") : "";
    const configuredLive = typeof getConfig === "function" ? getConfig("pmConnect.custom.baseUrl", "") : "";
    return configuredLocal || configuredLive || "";
  }

  isCachedLocal() {
    return this.cachedIsLocal;
  }

  reset() {
    this.cachedBase = null;
    this.cachedIsLocal = false;
    this.refreshInFlight = null;
  }

  startBackgroundRefresh(getConfig) {
    void this.refresh(getConfig);
    const intervalId = setInterval(() => void this.refresh(getConfig), REFRESH_INTERVAL_MS);
    return { dispose: () => clearInterval(intervalId) };
  }
}

const backendResolver = new BackendResolver();

module.exports = { BackendResolver, backendResolver, DEFAULT_LOCAL_CANDIDATES };
