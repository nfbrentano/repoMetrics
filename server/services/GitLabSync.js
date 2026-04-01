import { BaseSyncService } from './BaseSyncService.js';
import db from '../db.js';

export class GitLabSync extends BaseSyncService {
  constructor(repoConfig) {
    super(repoConfig);
    this.baseUrl = 'https://gitlab.com/api/v4';
    this.projectId = `${this.namespace}/${this.repo}`;
    this.glHeaders = {
      'PRIVATE-TOKEN': this.token
    };
  }

  static async discoverRepos({ namespace, token }) {
    const headers = { 'PRIVATE-TOKEN': token };
    let allRepos = [];
    let page = 1;
    let keepGoing = true;

    while (keepGoing) {
      const url = `https://gitlab.com/api/v4/groups/${encodeURIComponent(namespace)}/projects?per_page=100&page=${page}&include_subgroups=true`;
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
    }

    return allRepos.map(repo => ({
      id: `gitlab_${namespace}_${repo.path}`,
      provider: 'gitlab',
      namespace,
      repo: repo.path,
      active: true
    }));
  }

  async sync(rangeInMonths = 6) {
    const lastSync = this.getLastSyncedAt();
    const sinceDate = lastSync || this.getSinceDate(rangeInMonths);

    console.log(`[GitLab] Syncing ${this.namespace}/${this.repo} since ${sinceDate}`);

    const [commits, mrs] = await Promise.all([
      this.fetchCommits(sinceDate),
      this.fetchMRs(sinceDate)
    ]);

    let commitsAdded = 0;
    let prsAdded = 0;

    // Upsert commits
    const insertCommit = db.prepare(`
      INSERT OR IGNORE INTO commits (repo_id, sha, author, date, message)
      VALUES (?, ?, ?, ?, ?)
    `);

    const commitTx = db.transaction((items) => {
      for (const c of items) {
        const result = insertCommit.run(
          this.repoId, c.id, c.author_name || 'Desconhecido',
          c.created_at, c.title?.substring(0, 500) || ''
        );
        if (result.changes > 0) commitsAdded++;
      }
    });
    commitTx(commits);

    // Upsert MRs as PRs
    const upsertPR = db.prepare(`
      INSERT INTO pull_requests (repo_id, number, title, state, created_at, merged_at, closed_at, author)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET
        state = excluded.state,
        merged_at = excluded.merged_at,
        closed_at = excluded.closed_at
    `);

    const prTx = db.transaction((items) => {
      for (const m of items) {
        const state = m.state === 'merged' ? 'merged' : (m.state === 'opened' ? 'open' : m.state);
        const result = upsertPR.run(
          this.repoId, m.iid, m.title?.substring(0, 500),
          state, m.created_at, m.merged_at || null,
          m.closed_at || null, m.author?.username || 'Desconhecido'
        );
        if (result.changes > 0) prsAdded++;
      }
    });
    prTx(mrs);

    // Fetch and store notes (reviews)
    const deleteReviews = db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?');
    const insertReview = db.prepare(`
      INSERT INTO reviews (repo_id, pr_number, reviewer, submitted_at)
      VALUES (?, ?, ?, ?)
    `);

    const notesData = await Promise.all(mrs.map(m => this.fetchNotes(m.iid)));

    const reviewTx = db.transaction(() => {
      notesData.forEach((notes, index) => {
        const mrIid = mrs[index].iid;
        const humanNotes = notes.filter(n => !n.system);
        deleteReviews.run(this.repoId, mrIid);
        for (const n of humanNotes) {
          insertReview.run(this.repoId, mrIid, n.author?.username || 'Desconhecido', n.created_at);
        }
      });
    });
    reviewTx();

    db.prepare(`
      INSERT INTO sync_log (repo_id, commits_added, prs_added, issues_added)
      VALUES (?, ?, ?, 0)
    `).run(this.repoId, commitsAdded, prsAdded);

    this.updateLastSynced();

    console.log(`[GitLab] ✓ ${this.repo}: +${commitsAdded} commits, +${prsAdded} MRs`);
    return { commitsAdded, prsAdded, issuesAdded: 0 };
  }

  async fetchCommits(since) {
    const encodedSince = encodeURIComponent(since);
    const url = `${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/repository/commits?since=${encodedSince}&per_page=100`;
    return await this.fetchJSON(url, this.glHeaders) || [];
  }
 
  async fetchMRs(since) {
    const encodedSince = encodeURIComponent(since);
    const url = `${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/merge_requests?created_after=${encodedSince}&per_page=100`;
    return await this.fetchJSON(url, this.glHeaders) || [];
  }
 
  async fetchNotes(mrIid) {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/merge_requests/${mrIid}/notes`;
    return await this.fetchJSON(url, this.glHeaders) || [];
  }
}
