
import db from './server/db.js';
import { GitHubSync } from './server/services/GitHubSync.js';

const repo = {
  id: 'github_pixforce-dev_backend-data-streaming-platform',
  provider: 'github',
  namespace: 'pixforce-dev',
  repo: 'backend-data-streaming-platform',
  token: process.env.GITHUB_TOKEN || '' // I will check if I can get a token from the DB
};

// Get a token from the DB if available
const row = db.prepare('SELECT token FROM repos WHERE id = ?').get(repo.id);
if (row && row.token) repo.token = row.token;

async function test() {
  const syncService = new GitHubSync(repo);
  console.log('Starting sync for:', repo.repo);
  
  // Force a sync since 1 year ago to ensure we get something
  const result = await syncService.sync(12);
  console.log('Sync result:', result);
  
  const count = db.prepare('SELECT count(*) as c FROM commits WHERE repo_id = ?').get(repo.id);
  console.log('Commits in DB for this repo:', count.c);
}

test().catch(console.error);
