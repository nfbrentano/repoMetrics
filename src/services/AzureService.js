import { BaseGitService } from './BaseService.js';

export class AzureService extends BaseGitService {
  static async discoverRepos({ namespace, token }, onProgress) {
    const authHeaders = {
      'Authorization': `Basic ${btoa(':' + token)}`,
      'Accept': 'application/json'
    };
    
    // Supondo namespace no formato 'org/project'
    const parts = namespace.split('/');
    if (parts.length < 2) throw new Error('Para o Azure, o namespace deve ser no formato "organizacao/projeto".');
    const [org, proj] = parts;

    let allRepos = [];
    let skip = 0;
    const top = 100;
    let keepGoing = true;

    while (keepGoing) {
      if (onProgress) onProgress(`Azure: Buscando repositórios (${skip} até ${skip+top}) de ${namespace}...`);

      const res = await fetch(`https://dev.azure.com/${org}/${proj}/_apis/git/repositories?$top=${top}&$skip=${skip}&api-version=6.0`, { headers: authHeaders });
      if (!res.ok) throw new Error(`Falha ao buscar repositórios do Azure DevOps (skip ${skip}).`);
      
      const data = await res.json();
      const chunk = data.value || [];
      if (chunk.length === 0) {
        keepGoing = false;
      } else {
        allRepos = allRepos.concat(chunk);
        skip += chunk.length;
        if (chunk.length < top) keepGoing = false; // exhausted
      }
    }
    
    return allRepos.map(repo => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      provider: 'azure',
      token,
      namespace,
      repo: repo.name,
      active: true
    }));
  }

  constructor(config) {
    super(config);
    // Namespace in Azure is "org/project"
    const [org, project] = config.namespace.split('/');
    this.org = org;
    this.project = project;
    this.baseUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${config.repo}`;
    this.headers = {
      'Authorization': `Basic ${btoa(':' + this.token)}`,
      'Content-Type': 'application/json'
    };
  }

  async fetchAll(rangeInMonths = 6) {
    const since = this.getSinceDate(rangeInMonths);
    const [commits, prs] = await Promise.all([
      this.fetchCommits(since),
      this.fetchPRs(since)
    ]);

    const results = {
      commits: commits.value ? commits.value.length : 0,
      prsCreated: prs.value ? prs.value.length : 0,
      prsMerged: prs.value ? prs.value.filter(p => p.status === 'completed').length : 0,
      issuesOpen: 0, // Azure Devops Issues (Work Items) require a different API
      issuesClosed: 0,
      authors: {},
      reviews: 0,
      totalReviewTime: 0,
      pullsWithReview: 0,
      totalMergeTime: 0
    };

    // Authors and Merge Time
    const commitsTimeline = {};
    if (commits.value) {
      commits.value.forEach(c => {
        const author = c.author.name;
        results.authors[author] = (results.authors[author] || 0) + 1;
        
        if (c.author.date) {
          const dateObj = new Date(c.author.date);
          const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
          commitsTimeline[dateKey] = (commitsTimeline[dateKey] || 0) + 1;
        }
      });
    }

    if (prs.value) {
      prs.value.forEach(p => {
        if (p.status === 'completed' && p.closedDate) {
          const created = new Date(p.creationDate);
          const closed = new Date(p.closedDate);
          results.totalMergeTime += (closed - created) / (1000 * 60 * 60);
        }
      });
    }

    // Parallel fetch for threads (reviews) of all PRs
    const threadsData = await Promise.all(prs.value ? prs.value.map(p => this.fetchThreads(p.pullRequestId)) : []);

    threadsData.forEach((threads, index) => {
      const validThreads = threads.value ? threads.value.filter(t => !t.isCheckIn) : [];
      if (validThreads.length > 0) {
        results.reviews += validThreads.length;
        results.pullsWithReview++;
        
        const firstThread = new Date(validThreads[0].publishedDate);
        const prCreated = new Date(prs.value[index].creationDate);
        results.totalReviewTime += (firstThread - prCreated) / (1000 * 60 * 60);
      }
    });

    return {
      commits: results.commits,
      prsCreated: results.prsCreated,
      prsMerged: results.prsMerged,
      issuesOpen: results.issuesOpen,
      issuesClosed: results.issuesClosed,
      reviewCoverage: results.prsCreated > 0 ? (results.pullsWithReview / results.prsCreated) * 100 : 0,
      avgTimeFirstReview: results.pullsWithReview > 0 ? results.totalReviewTime / results.pullsWithReview : 0,
      avgTimeMerge: results.prsMerged > 0 ? results.totalMergeTime / results.prsMerged : 0,
      authors: results.authors,
      reviews: results.reviews,
      comments: results.reviews,
      commitsTimeline
    };
  }

  async fetchCommits(since) {
    const url = `${this.baseUrl}/commits?searchCriteria.fromDate=${since}&api-version=6.0`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : { value: [] };
  }

  async fetchPRs(since) {
    const url = `${this.baseUrl}/pullrequests?searchCriteria.status=all&api-version=6.0`;
    const res = await fetch(url, { headers: this.headers });
    const data = res.ok ? await res.json() : { value: [] };
    // Filter manually by date if needed
    return data;
  }

  async fetchThreads(prId) {
    const url = `${this.baseUrl}/pullRequests/${prId}/threads?api-version=6.0`;
    const res = await fetch(url, { headers: this.headers });
    return res.ok ? await res.json() : { value: [] };
  }
}
