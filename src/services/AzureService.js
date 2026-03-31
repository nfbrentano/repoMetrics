import { BaseGitService } from './BaseService.js';

export class AzureService extends BaseGitService {
  static async discoverRepos({ namespace, token }, onProgress) {
    const authHeaders = {
      'Authorization': `Basic ${btoa(':' + token)}`,
      'Accept': 'application/json'
    };
    
    const parts = namespace.split('/');
    const org = parts[0];
    const proj = parts[1]; // Pode ser undefined se o usuário digitar só a org

    if (!org) throw new Error('Organização inválida para o Azure DevOps.');

    let allRepos = [];

    if (proj) {
      if (onProgress) onProgress(`Azure: Buscando repositórios de ${namespace}...`);
      try {
        const url = `https://dev.azure.com/${org}/${proj}/_apis/git/repositories?api-version=6.0`;
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) throw new Error(`Falha ao buscar repositórios do Azure DevOps. Status: ${res.status}`);
        
        const data = await res.json();
        allRepos = data.value || [];
      } catch (e) {
        console.warn(`Erro no Azure DevOps projeto: ${e.message}`);
        throw e;
      }
    } else {
      // Buscar todos os projetos primeiro
      if (onProgress) onProgress(`Azure: Buscando projetos da organização ${org}...`);
      
      let projects = [];
      let skipProj = 0;
      let keepGoingProj = true;
      let projectIds = new Set();
      
      while (keepGoingProj) {
        // Atenção: Azure DevOps exige 'skip' e não '$skip' na maioria das rotas
        const url = `https://dev.azure.com/${org}/_apis/projects?$top=100&skip=${skipProj}&api-version=6.0`;
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) throw new Error(`Falha ao buscar projetos do Azure DevOps. Status: ${res.status}`);
        
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
            // Se a API ignorar o pagination e retornar o mesmo bloco, nós quebramos o loop
            keepGoingProj = false;
          } else {
            skipProj += chunk.length;
            if (chunk.length < 100) keepGoingProj = false;
          }
        }
      }
      
      // Para cada projeto, buscar os repositórios
      for (const p of projects) {
        if (onProgress) onProgress(`Azure: Buscando repositórios do projeto ${p.name}...`);
        
        try {
          const url = `https://dev.azure.com/${org}/${p.id}/_apis/git/repositories?api-version=6.0`;
          const res = await fetch(url, { headers: authHeaders });
          if (!res.ok) {
            console.warn(`Aviso: falha ao buscar repositórios do projeto ${p.name}`);
            continue; // Se falhar um projeto, pula e tenta o próximo
          }
          
          const data = await res.json();
          const chunk = data.value || [];
          allRepos = allRepos.concat(chunk);
        } catch (e) {
          console.warn(`Aviso: Erro inesperado no projeto ${p.name} - ${e.message}`);
        }
      }
    }
    
    return allRepos.map(repo => {
      // O endpoint do repository no Azure sempre retorna a qual project ele pertence em repo.project.name
      const projectName = repo.project && repo.project.name ? repo.project.name : proj;
      const fullNamespace = `${org}/${projectName}`;

      return {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        provider: 'azure',
        token,
        namespace: fullNamespace,
        repo: repo.name,
        active: true
      };
    });
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
      pullsWithReview: results.pullsWithReview,
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
