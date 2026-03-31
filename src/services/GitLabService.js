import { BaseGitService } from './BaseService.js';

export class GitLabService extends BaseGitService {
  static async discoverRepos({ namespace, token }, onProgress) {
    const headers = { 'PRIVATE-TOKEN': token };
    const ns = encodeURIComponent(namespace);
    let allRepos = [];
    let page = 1;
    let keepGoing = true;
    
    // Detectar group vs user
    let isUser = false;
    let testRes = await fetch(`https://gitlab.com/api/v4/groups/${ns}`, { headers });
    if (testRes.status === 404) isUser = true;

    while (keepGoing) {
      if (onProgress) onProgress(`GitLab: Buscando página ${page} de ${namespace}...`);

      const baseUrl = isUser ? `https://gitlab.com/api/v4/users/${ns}/projects` : `https://gitlab.com/api/v4/groups/${ns}/projects`;
      const res = await fetch(`${baseUrl}?per_page=100&order_by=updated_at&sort=desc&page=${page}`, { headers });

      if (!res.ok) throw new Error(`Falha ao buscar repositórios na página ${page}.`);
      
      const data = await res.json();
      if (!data || data.length === 0) {
        keepGoing = false;
      } else {
        allRepos = allRepos.concat(data);
        page++;
      }
    }
    
    return allRepos.map(repo => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      provider: 'gitlab',
      token,
      namespace,
      repo: repo.path,
      active: true
    }));
  }

  constructor(config) {
    super(config);
    this.baseUrl = 'https://gitlab.com/api/v4';
    this.headers = {
      'Authorization': `Bearer ${this.token}`,
    };
    this.projectId = config.repo; // Repo name or ID
  }

  async fetchAll(rangeInMonths = 6) {
    const since = this.getSinceDate(rangeInMonths);
    const [commits, mrs] = await Promise.all([
      this.fetchCommits(since),
      this.fetchMRs(since)
    ]);

    const results = {
      commits: commits.length,
      prsCreated: mrs.length,
      prsMerged: mrs.filter(m => m.state === 'merged').length,
      prsOpen: mrs.filter(m => m.state === 'opened').length,
      issuesOpen: 0,
      issuesClosed: 0,
      issuesTotal: 0,
      lastUpdate: commits.length > 0 && commits[0].created_at ? commits[0].created_at : null,
      authors: {},
      reviews: 0,
      totalReviewTime: 0,
      pullsWithReview: 0,
      totalMergeTime: 0
    };

    const commitsTimeline = {};
    commits.forEach(c => {
      const author = c.author_name;
      results.authors[author] = (results.authors[author] || 0) + 1;
      
      if (c.created_at) {
        const dateObj = new Date(c.created_at);
        const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
        commitsTimeline[dateKey] = (commitsTimeline[dateKey] || 0) + 1;
      }
    });

    mrs.forEach(m => {
      if (m.state === 'merged' && m.merged_at) {
        const created = new Date(m.created_at);
        const merged = new Date(m.merged_at);
        results.totalMergeTime += (merged - created) / (1000 * 60 * 60);
      }
    });

    // GitLab MR Notes as Reviews
    const notesData = await Promise.all(mrs.map(m => this.fetchNotes(m.iid)));

    notesData.forEach((notes, index) => {
      const humanNotes = notes.filter(n => !n.system);
      if (humanNotes.length > 0) {
        results.reviews += humanNotes.length;
        results.pullsWithReview++;
        
        const firstNote = new Date(humanNotes[0].created_at);
        const mrCreated = new Date(mrs[index].created_at);
        results.totalReviewTime += (firstNote - mrCreated) / (1000 * 60 * 60);
      }
    });

    return {
      commits: results.commits,
      prsCreated: results.prsCreated,
      prsMerged: results.prsMerged,
      prsOpen: results.prsOpen,
      issuesOpen: results.issuesOpen,
      issuesClosed: results.issuesClosed,
      issuesTotal: results.issuesTotal,
      lastUpdate: results.lastUpdate,
      reviewCoverage: mrs.length > 0 ? (results.pullsWithReview / mrs.length) * 100 : 0,
      avgTimeFirstReview: results.pullsWithReview > 0 ? results.totalReviewTime / results.pullsWithReview : 0,
      avgTimeMerge: results.prsMerged > 0 ? results.totalMergeTime / results.prsMerged : 0,
      authors: results.authors,
      reviews: results.reviews,
      comments: results.reviews,
      pullsWithReview: results.pullsWithReview,
      commitsTimeline
    };
  }

  async fetchCommits(since) {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/repository/commits?since=${since}&per_page=100`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : [];
  }

  async fetchMRs(since) {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/merge_requests?created_after=${since}&per_page=100`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : [];
  }

  async fetchNotes(mrIid) {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/merge_requests/${mrIid}/notes`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : [];
  }
}
