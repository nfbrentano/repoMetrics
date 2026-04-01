import express from 'express';
import cors from 'cors';
import db from './db.js';
import { GitHubSync } from './services/GitHubSync.js';
import { AzureSync } from './services/AzureSync.js';
import { GitLabSync } from './services/GitLabSync.js';
import { BitbucketSync } from './services/BitbucketSync.js';
import { MetricsCalculator } from './services/MetricsCalculator.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ──────────────────────────────────────────
// Helper: get sync service for a repo config
// ──────────────────────────────────────────
function getSyncService(repoConfig) {
  switch (repoConfig.provider) {
    case 'github': return new GitHubSync(repoConfig);
    case 'azure': return new AzureSync(repoConfig);
    case 'gitlab': return new GitLabSync(repoConfig);
    case 'bitbucket': return new BitbucketSync(repoConfig);
    default: throw new Error(`Provider desconhecido: ${repoConfig.provider}`);
  }
}

// ──────────────────────────────────────────
// Helper: discover repos (expand wildcards)
// ──────────────────────────────────────────
async function discoverRepos(repoConfig) {
  switch (repoConfig.provider) {
    case 'github': return GitHubSync.discoverRepos(repoConfig);
    case 'azure': return AzureSync.discoverRepos(repoConfig);
    case 'gitlab': return GitLabSync.discoverRepos(repoConfig);
    case 'bitbucket': return BitbucketSync.discoverRepos(repoConfig);
    default: return [];
  }
}

// ──────────────────────────────────────────
// Helper: ensure a repo exists in the DB
// ──────────────────────────────────────────
function ensureRepoInDB(repo) {
  const existing = db.prepare('SELECT id FROM repos WHERE id = ?').get(repo.id);
  if (!existing) {
    db.prepare(`
      INSERT INTO repos (id, provider, namespace, repo, token, is_wildcard)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(repo.id, repo.provider, repo.namespace, repo.repo, repo.token || null, repo.type === 'wildcard' ? 1 : 0);
  } else if (repo.token) {
    // Update token if provided
    db.prepare('UPDATE repos SET token = ? WHERE id = ?').run(repo.token, repo.id);
  }
}

// ─────────────────────────────────────────────
// POST /api/repos — Save/update repo configs
// ─────────────────────────────────────────────
app.post('/api/repos', (req, res) => {
  const { repos } = req.body;
  if (!repos || !Array.isArray(repos)) {
    return res.status(400).json({ error: 'repos array is required' });
  }

  const upsert = db.prepare(`
    INSERT INTO repos (id, provider, namespace, repo, token, is_wildcard)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      token = excluded.token,
      namespace = excluded.namespace,
      repo = excluded.repo
  `);

  const tx = db.transaction((items) => {
    for (const r of items) {
      upsert.run(r.id, r.provider, r.namespace, r.repo, r.token || null, r.type === 'wildcard' ? 1 : 0);
    }
  });
  tx(repos);

  res.json({ ok: true, count: repos.length });
});

// ─────────────────────────────────────────────
// POST /api/sync — Sync repos (incremental)
// ─────────────────────────────────────────────
app.post('/api/sync', async (req, res) => {
  const { repos, rangeMonths = 6, author = null } = req.body;

  if (!repos || !Array.isArray(repos) || repos.length === 0) {
    return res.status(400).json({ error: 'repos array is required' });
  }

  try {
    // Step 1: Expand wildcards
    let resolvedRepos = [];
    for (const repo of repos) {
      if (repo.type === 'wildcard' || repo.repo === '*') {
        try {
          const discovered = await discoverRepos(repo);
          // Attach the token from the original wildcard config
          resolvedRepos = resolvedRepos.concat(discovered.map(d => ({ ...d, token: repo.token })));
        } catch (e) {
          console.error(`Falha ao expandir wildcard ${repo.namespace}:`, e.message);
        }
      } else {
        // Generate stable ID if not already set
        if (!repo.id || repo.id.match(/^\d+$/)) {
          repo.id = `${repo.provider}_${repo.namespace}_${repo.repo}`;
        }
        resolvedRepos.push(repo);
      }
    }

    // Step 2: Ensure all repos exist in DB
    for (const repo of resolvedRepos) {
      ensureRepoInDB(repo);
    }

    // Step 3: Sync each repo (with concurrency limit)
    const CONCURRENCY = 4;
    const queue = [...resolvedRepos];
    const results = [];
    let completed = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const repo = queue.shift();
        try {
          const service = getSyncService(repo);
          const result = await service.sync(rangeMonths);
          results.push({ repo: repo.repo, ...result });
        } catch (err) {
          console.error(`Sync falhou para ${repo.repo}:`, err.message);
          results.push({ repo: repo.repo, error: err.message });
        }
        completed++;
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);

    // Step 4: Calculate metrics from local DB
    const repoIds = resolvedRepos.map(r => r.id);
    const metrics = MetricsCalculator.getMetrics(repoIds, rangeMonths, author);

    res.json({
      ok: true,
      syncResults: results,
      repoCount: resolvedRepos.length,
      metrics,
      resolvedRepos: resolvedRepos.map(r => ({
        id: r.id,
        provider: r.provider,
        namespace: r.namespace,
        repo: r.repo
      }))
    });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/metrics — Get cached metrics
// ─────────────────────────────────────────────
app.get('/api/metrics', (req, res) => {
  const rangeMonths = parseInt(req.query.range) || 6;
  const author = req.query.author || null;

  // Get all repo IDs from DB
  const repos = db.prepare('SELECT id FROM repos WHERE is_wildcard = 0').all();
  const repoIds = repos.map(r => r.id);

  if (repoIds.length === 0) {
    return res.json({ metrics: null, repoCount: 0 });
  }

  const metrics = MetricsCalculator.getMetrics(repoIds, rangeMonths, author);
  res.json({ metrics, repoCount: repoIds.length });
});

// ─────────────────────────────────────────────
// GET /api/sync/status — Get sync status
// ─────────────────────────────────────────────
app.get('/api/sync/status', (req, res) => {
  const status = MetricsCalculator.getSyncStatus();
  res.json({ status });
});

// ─────────────────────────────────────────────
// POST /api/sync/force — Force full re-sync
// ─────────────────────────────────────────────
app.post('/api/sync/force', async (req, res) => {
  const { repos, rangeMonths = 6 } = req.body;

  // Reset last_synced_at for all matching repos
  if (repos) {
    for (const repo of repos) {
      const id = repo.id || `${repo.provider}_${repo.namespace}_${repo.repo}`;
      db.prepare('UPDATE repos SET last_synced_at = NULL WHERE id = ?').run(id);
    }
  } else {
    db.prepare('UPDATE repos SET last_synced_at = NULL').run();
  }

  // Forward to normal sync
  req.body.rangeMonths = rangeMonths;
  if (!repos) {
    const allRepos = db.prepare('SELECT * FROM repos WHERE is_wildcard = 0').all();
    req.body.repos = allRepos;
  }

  // Delegate to /api/sync handler logic
  const syncHandler = app._router.stack.find(
    r => r.route && r.route.path === '/api/sync' && r.route.methods.post
  );

  // Just re-call sync
  return res.redirect(307, '/api/sync');
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 RepoMetrics API Server rodando em http://localhost:${PORT}`);
  console.log(`📦 Banco de dados SQLite em: server/data/repometrics.db\n`);
});
