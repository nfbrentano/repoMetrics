import { BaseSyncService } from './BaseSyncService.js';
import db from '../db.js';

export class AzureSync extends BaseSyncService {
  constructor(repoConfig) {
    super(repoConfig);
    const [org, project] = this.namespace.split('/');
    this.org = org;
    this.project = project;
    this.azureBaseUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${this.repo}`;
    this.azureHeaders = {
      'Authorization': `Basic ${Buffer.from(':' + this.token).toString('base64')}`,
      'Content-Type': 'application/json'
    };
  }

  static async discoverRepos({ namespace, token }) {
    const authHeaders = {
      'Authorization': `Basic ${Buffer.from(':' + token).toString('base64')}`,
      'Accept': 'application/json'
    };

    const parts = namespace.split('/');
    const org = parts[0];
    const proj = parts[1];

    if (!org) throw new Error('Organização inválida para o Azure DevOps.');

    let allRepos = [];

    if (proj) {
      const url = `https://dev.azure.com/${org}/${proj}/_apis/git/repositories?api-version=6.0`;
      const res = await fetch(url, { headers: authHeaders });
      if (!res.ok) throw new Error(`Falha ao buscar repositórios do Azure DevOps. Status: ${res.status}`);
      const data = await res.json();
      allRepos = data.value || [];
    } else {
      // Fetch all projects first
      let projects = [];
      let skipProj = 0;
      let keepGoingProj = true;
      const projectIds = new Set();

      while (keepGoingProj) {
        const url = `https://dev.azure.com/${org}/_apis/projects?$top=100&skip=${skipProj}&api-version=6.0`;
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) throw new Error(`Falha ao buscar projetos. Status: ${res.status}`);
        const data = await res.json();
        const chunk = data.value || [];

        if (chunk.length === 0) {
          keepGoingProj = false;
        } else {
          let newProjects = false;
          for (const c of chunk) {
            if (!projectIds.has(c.id)) {
              projectIds.add(c.id);
              projects.push(c);
              newProjects = true;
            }
          }
          if (!newProjects) {
            keepGoingProj = false;
          } else {
            skipProj += chunk.length;
            if (chunk.length < 100) keepGoingProj = false;
          }
        }
      }

      for (const p of projects) {
        try {
          const url = `https://dev.azure.com/${org}/${p.id}/_apis/git/repositories?api-version=6.0`;
          const res = await fetch(url, { headers: authHeaders });
          if (!res.ok) continue;
          const data = await res.json();
          allRepos = allRepos.concat(data.value || []);
        } catch (e) {
          console.warn(`Azure: Erro no projeto ${p.name}: ${e.message}`);
        }
      }
    }

    return allRepos.map(repo => {
      const projectName = repo.project?.name || proj;
      const fullNamespace = `${org}/${projectName}`;
      return {
        id: `azure_${fullNamespace}_${repo.name}`,
        provider: 'azure',
        namespace: fullNamespace,
        repo: repo.name,
        active: true
      };
    });
  }

  async sync(rangeInMonths = 6) {
    const lastSync = this.getLastSyncedAt();
    const sinceDate = lastSync || this.getSinceDate(rangeInMonths);

    console.log(`[Azure] Syncing ${this.namespace}/${this.repo} since ${sinceDate}`);

    const [commitsData, prsData] = await Promise.all([
      this.fetchCommits(sinceDate),
      this.fetchPRs(sinceDate)
    ]);

    const commits = commitsData?.value || [];
    const prs = prsData?.value || [];

    let commitsAdded = 0;
    let prsAdded = 0;

    // Upsert commits
    const insertCommit = db.prepare(`
      INSERT OR IGNORE INTO commits (repo_id, sha, author, date, message)
      VALUES (?, ?, ?, ?, ?)
    `);

    const commitTx = db.transaction((items) => {
      for (const c of items) {
        const author = c.author?.name || 'Desconhecido';
        const date = c.author?.date || null;
        const message = c.comment?.substring(0, 500) || '';
        const sha = c.commitId || '';
        const result = insertCommit.run(this.repoId, sha, author, date, message);
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
        const state = p.status === 'completed' ? 'merged' : (p.status === 'active' ? 'open' : p.status);
        const result = upsertPR.run(
          this.repoId, p.pullRequestId, p.title?.substring(0, 500),
          state, p.creationDate, p.closedDate || null,
          p.closedDate || null, p.createdBy?.displayName || 'Desconhecido'
        );
        if (result.changes > 0) prsAdded++;
      }
    });
    prTx(prs);

    // Fetch and store reviews (threads)
    const deleteReviews = db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?');
    const insertReview = db.prepare(`
      INSERT INTO reviews (repo_id, pr_number, reviewer, submitted_at)
      VALUES (?, ?, ?, ?)
    `);

    const threadsData = await Promise.all(prs.map(p => this.fetchThreads(p.pullRequestId)));

    const reviewTx = db.transaction(() => {
      threadsData.forEach((threads, index) => {
        const prNumber = prs[index].pullRequestId;
        const validThreads = threads?.value?.filter(t => !t.isCheckIn) || [];
        deleteReviews.run(this.repoId, prNumber);
        for (const t of validThreads) {
          insertReview.run(
            this.repoId, prNumber,
            t.comments?.[0]?.author?.displayName || 'Desconhecido',
            t.publishedDate
          );
        }
      });
    });
    reviewTx();

    db.prepare(`
      INSERT INTO sync_log (repo_id, commits_added, prs_added, issues_added)
      VALUES (?, ?, ?, 0)
    `).run(this.repoId, commitsAdded, prsAdded);

    this.updateLastSynced();

    console.log(`[Azure] ✓ ${this.repo}: +${commitsAdded} commits, +${prsAdded} PRs`);
    return { commitsAdded, prsAdded, issuesAdded: 0 };
  }

  async fetchCommits(since) {
    const encodedSince = encodeURIComponent(since);
    const url = `${this.azureBaseUrl}/commits?searchCriteria.fromDate=${encodedSince}&api-version=6.0`;
    return this.fetchJSON(url, this.azureHeaders) || { value: [] };
  }

  async fetchPRs(since) {
    const url = `${this.azureBaseUrl}/pullrequests?searchCriteria.status=all&api-version=6.0`;
    return this.fetchJSON(url, this.azureHeaders) || { value: [] };
  }

  async fetchThreads(prId) {
    const url = `${this.azureBaseUrl}/pullRequests/${prId}/threads?api-version=6.0`;
    return this.fetchJSON(url, this.azureHeaders) || { value: [] };
  }
}
