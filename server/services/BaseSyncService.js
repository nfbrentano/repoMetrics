// Base class for all sync services
// Handles token retrieval from the database and common HTTP utilities

import db from '../db.js';

export class BaseSyncService {
  constructor(repoConfig) {
    this.repoId = repoConfig.id;
    this.provider = repoConfig.provider;
    this.namespace = repoConfig.namespace;
    this.repo = repoConfig.repo;
    this.token = repoConfig.token;
  }

  getLastSyncedAt() {
    const row = db.prepare('SELECT last_synced_at FROM repos WHERE id = ?').get(this.repoId);
    return row?.last_synced_at || null;
  }

  getSinceDate(rangeInMonths) {
    const d = new Date();
    d.setMonth(d.getMonth() - rangeInMonths);
    return d.toISOString();
  }

  updateLastSynced() {
    db.prepare('UPDATE repos SET last_synced_at = datetime(\'now\') WHERE id = ?').run(this.repoId);
  }

  async fetchJSON(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[${this.provider}] Fetch failed for ${url} — status ${res.status}`);
      return null;
    }
    return res.json();
  }
}
