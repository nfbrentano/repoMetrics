import { BaseGitService } from './BaseService.js';

export class BitbucketService extends BaseGitService {
  static async discoverRepos({ namespace, token }, onProgress) {
    const headers = { 'Authorization': `Basic ${btoa(token)}`, 'Accept': 'application/json' };
    
    let allRepos = [];
    let nextUrl = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(namespace)}?pagelen=100&sort=-updated_on`;
    let pageCount = 1;

    while (nextUrl) {
      if (onProgress) onProgress(`Bitbucket: Buscando página ${pageCount} de ${namespace}...`);

      const res = await fetch(nextUrl, { headers });
      if (!res.ok) throw new Error(`Falha ao buscar repositórios do Bitbucket na página ${pageCount}.`);
      
      const data = await res.json();
      allRepos = allRepos.concat(data.values || []);
      
      nextUrl = data.next || null;
      pageCount++;
    }
    
    return allRepos.map(repo => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      provider: 'bitbucket',
      token,
      namespace,
      repo: repo.slug,
      active: true
    }));
  }

  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.bitbucket.org/2.0';
    this.headers = {
      'Authorization': `Bearer ${this.token}`,
    };
    // Namespace in Bitbucket is usually "{workspace}"
    this.workspace = config.namespace;
    this.repoSlug = config.repo;
  }

  async fetchAll(rangeInMonths = 6) {
    const since = this.getSinceDate(rangeInMonths);
    const [commits, prs] = await Promise.all([
      this.fetchCommits(),
      this.fetchPRs()
    ]);

    const results = {
      commits: 0,
      prsCreated: 0,
      prsMerged: 0,
      issuesOpen: 0,
      issuesClosed: 0,
      authors: {},
      reviews: 0,
      totalReviewTime: 0,
      pullsWithReview: 0,
      totalMergeTime: 0
    };

    // Filter commits by date
    const commitsTimeline = {};
    const filteredCommits = commits.values ? commits.values.filter(c => new Date(c.date) >= new Date(since)) : [];
    results.commits = filteredCommits.length;
    filteredCommits.forEach(c => {
      const author = c.author?.raw || 'Desconhecido';
      results.authors[author] = (results.authors[author] || 0) + 1;
      
      if (c.date) {
        const dateObj = new Date(c.date);
        const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
        commitsTimeline[dateKey] = (commitsTimeline[dateKey] || 0) + 1;
      }
    });

    const filteredPRs = prs.values ? prs.values.filter(p => new Date(p.created_on) >= new Date(since)) : [];
    results.prsCreated = filteredPRs.length;
    results.prsMerged = filteredPRs.filter(p => p.state === 'MERGED').length;

    filteredPRs.forEach(p => {
      if (p.state === 'MERGED' && p.merge_commit) {
        const created = new Date(p.created_on);
        const merged = new Date(p.updated_on); // updated_on usually reflects merge date in Bitbucket for merged PRs
        results.totalMergeTime += (merged - created) / (1000 * 60 * 60);
      }
    });

    // Fetch comments (as reviews) for all PRs
    const reviewsData = await Promise.all(filteredPRs.map(p => this.fetchComments(p.id)));

    reviewsData.forEach((comments, index) => {
      const validComments = comments.values ? comments.values : [];
      if (validComments.length > 0) {
        results.reviews += validComments.length;
        results.pullsWithReview++;
        
        const firstComment = new Date(validComments[0].created_on);
        const prCreated = new Date(filteredPRs[index].created_on);
        results.totalReviewTime += (firstComment - prCreated) / (1000 * 60 * 60);
      }
    });

    return {
      commits: results.commits,
      prsCreated: results.prsCreated,
      prsMerged: results.prsMerged,
      reviewCoverage: results.prsCreated > 0 ? (results.pullsWithReview / results.prsCreated) * 100 : 0,
      avgTimeFirstReview: results.pullsWithReview > 0 ? results.totalReviewTime / results.pullsWithReview : 0,
      avgTimeMerge: results.prsMerged > 0 ? results.totalMergeTime / results.prsMerged : 0,
      authors: results.authors,
      reviews: results.reviews,
      comments: results.reviews,
      commitsTimeline
    };
  }

  async fetchCommits() {
    const url = `${this.baseUrl}/repositories/${this.workspace}/${this.repoSlug}/commits?pagelen=100`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : { values: [] };
  }

  async fetchPRs() {
    const url = `${this.baseUrl}/repositories/${this.workspace}/${this.repoSlug}/pullrequests?state=ALL&pagelen=100`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : { values: [] };
  }

  async fetchComments(prId) {
    const url = `${this.baseUrl}/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${prId}/comments`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : { values: [] };
  }
}
