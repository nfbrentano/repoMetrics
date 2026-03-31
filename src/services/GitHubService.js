import { BaseGitService } from './BaseService.js';

export class GitHubService extends BaseGitService {
  static async discoverRepos({ namespace, token }, onProgress) {
    const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' };
    let allRepos = [];
    let page = 1;
    let keepGoing = true;

    // Detectar user vs org
    let isUser = false;
    let testRes = await fetch(`https://api.github.com/orgs/${namespace}`, { headers });
    if (testRes.status === 404) isUser = true;

    while (keepGoing) {
      if (onProgress) onProgress(`GitHub: Buscando página ${page} de ${namespace}...`);
      
      // Se for usuário, type=owner/all pode variar, para org type=all garante os privados também
      let url = '';
      if (isUser) {
        url = `https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator&sort=updated&per_page=100&page=${page}`;
      } else {
        url = `https://api.github.com/orgs/${namespace}/repos?type=all&sort=updated&per_page=100&page=${page}`;
      }
      
      const res = await fetch(url, { headers });
      
      if (!res.ok) throw new Error(`Falha ao buscar repositórios na página ${page}.`);
      
      let data = await res.json();
      if (!data || data.length === 0) {
        keepGoing = false;
      } else {
        // Se bater no endpoint de usuário autenticado (que retorna tudo), precisamos filtrar apenas o namespace
        if (isUser) {
          // Desativando filtro restrito ('owner.login == namespace') para que o sistema consiga
          // agregar repositórios vinculados ao seu Perfil em outras afiliações (colaborador, org)
          allRepos = allRepos.concat(data);
        } else {
          allRepos = allRepos.concat(data);
        }
        page++;
      }
    }
    
    return allRepos.map(repo => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      provider: 'github',
      token,
      namespace,
      repo: repo.name,
      active: true
    }));
  }

  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.github.com';
    this.headers = {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json'
    };
  }

  async fetchAll(rangeInMonths = 6) {
    const since = this.getSinceDate(rangeInMonths);
    const [commits, prs, issues] = await Promise.all([
      this.fetchCommits(since),
      this.fetchPRs(since),
      this.fetchIssues(since)
    ]);

    // Data aggregation
    const results = {
      commits: commits.length,
      prsCreated: prs.length,
      prsMerged: prs.filter(p => p.merged_at).length,
      issuesOpen: issues.filter(i => i.state === 'open' && !i.pull_request).length,
      issuesClosed: issues.filter(i => i.state === 'closed' && !i.pull_request).length,
      authors: {},
      reviews: 0,
      totalReviewTime: 0,
      pullsWithReview: 0,
      totalMergeTime: 0,
      comments: 0
    };

    // Calculate timelines and participation
    const commitsTimeline = {};
    commits.forEach(c => {
      const author = c.commit.author.name;
      results.authors[author] = (results.authors[author] || 0) + 1;
      
      if (c.commit && c.commit.author && c.commit.author.date) {
        const dateObj = new Date(c.commit.author.date);
        const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
        commitsTimeline[dateKey] = (commitsTimeline[dateKey] || 0) + 1;
      }
    });

    // Merge time calculation
    prs.forEach(p => {
      if (p.merged_at) {
        const created = new Date(p.created_at);
        const merged = new Date(p.merged_at);
        results.totalMergeTime += (merged - created) / (1000 * 60 * 60); // hours
      }
    });

    // Fetch Reviews for each PR
    // Optimization: Parallel fetch for reviews
    const reviewsData = await Promise.all(prs.map(p => this.fetchReviews(p.number)));
    
    reviewsData.forEach((reviews, index) => {
      if (reviews.length > 0) {
        results.reviews += reviews.length;
        results.pullsWithReview++;
        
        // Time to first review
        const firstReview = new Date(reviews[0].submitted_at);
        const prCreated = new Date(prs[index].created_at);
        results.totalReviewTime += (firstReview - prCreated) / (1000 * 60 * 60);
      }
    });

    return {
      commits: results.commits,
      prsCreated: results.prsCreated,
      prsMerged: results.prsMerged,
      issuesOpen: results.issuesOpen,
      issuesClosed: results.issuesClosed,
      reviewCoverage: prs.length > 0 ? (results.pullsWithReview / prs.length) * 100 : 0,
      avgTimeFirstReview: results.pullsWithReview > 0 ? results.totalReviewTime / results.pullsWithReview : 0,
      avgTimeMerge: results.prsMerged > 0 ? results.totalMergeTime / results.prsMerged : 0,
      authors: results.authors,
      reviews: results.reviews,
      comments: results.reviews, // Simplification for now
      commitsTimeline
    };
  }

  async fetchCommits(since) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/commits?since=${since}&per_page=100`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : [];
  }

  async fetchPRs(since) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/pulls?state=all&per_page=100`;
    const res = await fetch(url, { headers: this.headers });
    const data = res.ok ? await res.json() : [];
    // Filter by since manually as GitHub API doesn't support 'since' for pulls directly
    return data.filter(p => new Date(p.created_at) >= new Date(since));
  }

  async fetchIssues(since) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/issues?state=all&since=${since}&per_page=100`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : [];
  }

  async fetchReviews(prNumber) {
    const url = `${this.baseUrl}/repos/${this.namespace}/${this.repo}/pulls/${prNumber}/reviews`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : [];
  }
}
