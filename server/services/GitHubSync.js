import { BaseSyncService } from './BaseSyncService.js';
import db from '../db.js';

export class GitHubSync extends BaseSyncService {
  constructor(repoConfig) {
    super(repoConfig);
    this.baseUrl = 'https://api.github.com';
    this.headers = {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'RepoMetrics-Server'
    };
  }

  static async discoverRepos({ namespace, token }) {
    const headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'RepoMetrics-Server'
    };
    let allRepos = [];
    let page = 1;
    let keepGoing = true;

    // Detect user vs org
    let isUser = false;
    const testRes = await fetch(`https://api.github.com/orgs/${namespace}`, { headers });
    if (testRes.status === 404) isUser = true;

    while (keepGoing) {
      let url = '';
      if (isUser) {
        url = `https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator&sort=updated&per_page=100&page=${page}`;
      } else {
        url = `https://api.github.com/orgs/${namespace}/repos?type=all&sort=updated&per_page=100&page=${page}`;
      }

      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = await res.json();

      if (!data || data.length === 0) {
        keepGoing = false;
      } else {
        allRepos = allRepos.concat(data);
        page++;
        if (data.length < 100) keepGoing = false;
      }

      // Rate limit protection
      await new Promise(r => setTimeout(r, 200));
    }

    return allRepos.map(repo => ({
      id: `github_${namespace}_${repo.name}`,
      provider: 'github',
      namespace,
      repo: repo.name,
      active: true
    }));
  }

  async sync(rangeInMonths = 6) {
    const lastSync = this.getLastSyncedAt();
    const sinceDate = lastSync || this.getSinceDate(rangeInMonths);

    console.log(`[GitHub] Syncing ${this.namespace}/${this.repo} since ${sinceDate}`);

    // Fetch data with rate limit delays
    const commits = await this.fetchCommits(sinceDate);
    await new Promise(r => setTimeout(r, 200));
    const prs = await this.fetchPRs(sinceDate);
    await new Promise(r => setTimeout(r, 200));
    const issues = await this.fetchIssues(sinceDate);

    let commitsAdded = 0;
    let prsAdded = 0;
    let issuesAdded = 0;

    // Upsert commits
    const insertCommit = db.prepare(`
      INSERT OR IGNORE INTO commits (repo_id, sha, author, date, message)
      VALUES (?, ?, ?, ?, ?)
    `);

    const commitTx = db.transaction((items) => {
      for (const c of items) {
        const author = c.commit?.author?.name || c.author?.login || 'Desconhecido';
        const date = c.commit?.author?.date || null;
        const message = c.commit?.message?.substring(0, 500) || '';
        const result = insertCommit.run(this.repoId, c.sha, author, date, message);
        if (result.changes > 0) commitsAdded++;
      }
    });
    commitTx(commits);

    // Upsert PRs
    const upsertPR = db.prepare(`
      INSERT INTO pull_requests (repo_id, number, title, state, created_at, merged_at, closed_at, author)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET
        state = excluded.state,
        merged_at = excluded.merged_at,
        closed_at = excluded.closed_at
    `);

    const prTx = db.transaction((items) => {
      for (const p of items) {
        const result = upsertPR.run(
          this.repoId, p.number, p.title?.substring(0, 500),
          p.state, p.created_at, p.merged_at || null,
          p.closed_at || null, p.user?.login || 'Desconhecido'
        );
        if (result.changes > 0) prsAdded++;
      }
    });
    prTx(prs);

    // Fetch reviews for each PR (chunked)
    const deleteReviews = db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?');
    const insertReview = db.prepare(`
      INSERT INTO reviews (repo_id, pr_number, reviewer, submitted_at)
      VALUES (?, ?, ?, ?)
    `);

    const CHUNK_SIZE = 10;
    for (let i = 0; i < prs.length; i += CHUNK_SIZE) {
      const chunk = prs.slice(i, i + CHUNK_SIZE);
      const reviewsData = await Promise.all(chunk.map(p => this.fetchReviews(p.number)));
      
      const reviewTx = db.transaction(() => {
        reviewsData.forEach((reviews, idx) => {
          const prNumber = chunk[idx].number;
          deleteReviews.run(this.repoId, prNumber);
          for (const r of reviews) {
            insertReview.run(this.repoId, prNumber, r.user?.login || 'Desconhecido', r.submitted_at);
          }
        });
      });
      reviewTx();

      if (i + CHUNK_SIZE < prs.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Upsert issues (filter out PRs)
    const upsertIssue = db.prepare(`
      INSERT INTO issues (repo_id, number, title, state, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET
        state = excluded.state,
        closed_at = excluded.closed_at
    `);

    const issueTx = db.transaction((items) => {
      for (const i of items) {
        if (i.pull_request) continue; // Skip PRs in issues list
        const result = upsertIssue.run(
          this.repoId, i.number, i.title?.substring(0, 500),
          i.state, i.created_at, i.closed_at || null
        );
        if (result.changes > 0) issuesAdded++;
      }
    });
    issueTx(issues);

    // Log sync
    db.prepare(`
      INSERT INTO sync_log (repo_id, commits_added, prs_added, issues_added)
      VALUES (?, ?, ?, ?)
    `).run(this.repoId, commitsAdded, prsAdded, issuesAdded);

    this.updateLastSynced();

    console.log(`[GitHub] ✓ ${this.repo}: +${commitsAdded} commits, +${prsAdded} PRs, +${issuesAdded} issues`);
    return { commitsAdded, prsAdded, issuesAdded };
  }

  async fetchCommits(since) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/commits?since=${since}&per_page=100`;
    const data = await this.fetchJSON(url, this.headers);
    return data || [];
  }

  async fetchPRs(since) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/pulls?state=all&per_page=100`;
    const data = await this.fetchJSON(url, this.headers);
    if (!data) return [];
    return data.filter(p => new Date(p.created_at) >= new Date(since));
  }

  async fetchIssues(since) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/issues?state=all&since=${since}&per_page=100`;
    const data = await this.fetchJSON(url, this.headers);
    return data || [];
  }

  async fetchReviews(prNumber) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/pulls/${prNumber}/reviews`;
    const data = await this.fetchJSON(url, this.headers);
    return data || [];
  }
}
