import { BaseSyncService } from './BaseSyncService.js';
import db from '../db.js';

export class BitbucketSync extends BaseSyncService {
  constructor(repoConfig) {
    super(repoConfig);
    this.baseUrl = 'https://api.bitbucket.org/2.0';
    this.bbHeaders = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }

  static async discoverRepos({ namespace, token }) {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    let allRepos = [];
    let url = `https://api.bitbucket.org/2.0/repositories/${namespace}?pagelen=50`;

    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = await res.json();
      allRepos = allRepos.concat(data.values || []);
      url = data.next || null;
    }

    return allRepos.map(repo => ({
      id: `bitbucket_${namespace}_${repo.slug}`,
      provider: 'bitbucket',
      namespace,
      repo: repo.slug,
      active: true
    }));
  }

  async sync(rangeInMonths = 6) {
    const lastSync = this.getLastSyncedAt();
    const sinceDate = lastSync || this.getSinceDate(rangeInMonths);

    console.log(`[Bitbucket] Syncing ${this.namespace}/${this.repo} since ${sinceDate}`);

    const [commitsData, prsData] = await Promise.all([
      this.fetchCommits(),
      this.fetchPRs()
    ]);

    const allCommits = commitsData?.values || [];
    const filteredCommits = allCommits.filter(c => new Date(c.date) >= new Date(sinceDate));

    const allPRs = prsData?.values || [];
    const filteredPRs = allPRs.filter(p => new Date(p.created_on) >= new Date(sinceDate));

    let commitsAdded = 0;
    let prsAdded = 0;

    // Upsert commits
    const insertCommit = db.prepare(`
      INSERT OR IGNORE INTO commits (repo_id, sha, author, date, message)
      VALUES (?, ?, ?, ?, ?)
    `);

    const commitTx = db.transaction((items) => {
      for (const c of items) {
        const author = c.author?.raw || c.author?.user?.display_name || 'Desconhecido';
        const result = insertCommit.run(
          this.repoId, c.hash, author, c.date, c.message?.substring(0, 500) || ''
        );
        if (result.changes > 0) commitsAdded++;
      }
    });
    commitTx(filteredCommits);

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
        const state = p.state === 'MERGED' ? 'merged' : (p.state === 'OPEN' ? 'open' : p.state.toLowerCase());
        const result = upsertPR.run(
          this.repoId, p.id, p.title?.substring(0, 500),
          state, p.created_on, null,
          p.state === 'MERGED' ? p.updated_on : null,
          p.author?.display_name || 'Desconhecido'
        );
        if (result.changes > 0) prsAdded++;
      }
    });
    prTx(filteredPRs);

    // Fetch and store comments (as reviews)
    const deleteReviews = db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?');
    const insertReview = db.prepare(`
      INSERT INTO reviews (repo_id, pr_number, reviewer, submitted_at)
      VALUES (?, ?, ?, ?)
    `);

    const commentsData = await Promise.all(filteredPRs.map(p => this.fetchComments(p.id)));

    const reviewTx = db.transaction(() => {
      commentsData.forEach((comments, index) => {
        const prNumber = filteredPRs[index].id;
        const validComments = comments?.values || [];
        deleteReviews.run(this.repoId, prNumber);
        for (const c of validComments) {
          insertReview.run(this.repoId, prNumber, c.user?.display_name || 'Desconhecido', c.created_on);
        }
      });
    });
    reviewTx();

    db.prepare(`
      INSERT INTO sync_log (repo_id, commits_added, prs_added, issues_added)
      VALUES (?, ?, ?, 0)
    `).run(this.repoId, commitsAdded, prsAdded);

    this.updateLastSynced();

    console.log(`[Bitbucket] ✓ ${this.repo}: +${commitsAdded} commits, +${prsAdded} PRs`);
    return { commitsAdded, prsAdded, issuesAdded: 0 };
  }

  async fetchCommits() {
    const url = `${this.baseUrl}/repositories/${this.namespace}/${this.repo}/commits?pagelen=50`;
    return this.fetchJSON(url, this.bbHeaders);
  }

  async fetchPRs() {
    const url = `${this.baseUrl}/repositories/${this.namespace}/${this.repo}/pullrequests?state=all&pagelen=50`;
    return this.fetchJSON(url, this.bbHeaders);
  }

  async fetchComments(prId) {
    const url = `${this.baseUrl}/repositories/${this.namespace}/${this.repo}/pullrequests/${prId}/comments`;
    return this.fetchJSON(url, this.bbHeaders);
  }
}
