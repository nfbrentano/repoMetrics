import { GitHubService } from './GitHubService.js';
import { AzureService } from './AzureService.js';
import { GitLabService } from './GitLabService.js';
import { BitbucketService } from './BitbucketService.js';

export class DataAggregator {
  static getService(repoConfig) {
    switch (repoConfig.provider) {
      case 'github': return new GitHubService(repoConfig);
      case 'azure': return new AzureService(repoConfig);
      case 'gitlab': return new GitLabService(repoConfig);
      case 'bitbucket': return new BitbucketService(repoConfig);
      default: throw new Error(`Provider desconhecido: ${repoConfig.provider}`);
    }
  }

  static async expandWildcardRepos(rawRepos, onProgress) {
    let resolvedRepos = [];

    for (const repoConfig of rawRepos) {
      if (repoConfig.type === 'wildcard' || repoConfig.repo === '*') {
        try {
          if (onProgress) onProgress(`Resolvendo wildcard para ${repoConfig.namespace}...`);
          let discovered = [];

          if (repoConfig.provider === 'github') discovered = await GitHubService.discoverRepos(repoConfig, onProgress);
          if (repoConfig.provider === 'gitlab') discovered = await GitLabService.discoverRepos(repoConfig, onProgress);
          if (repoConfig.provider === 'bitbucket') discovered = await BitbucketService.discoverRepos(repoConfig, onProgress);
          if (repoConfig.provider === 'azure') discovered = await AzureService.discoverRepos(repoConfig, onProgress);

          resolvedRepos = resolvedRepos.concat(discovered);
        } catch (e) {
          console.error(`Falha ao expandir organizacao ${repoConfig.namespace}`, e);
        }
      } else {
        resolvedRepos.push(repoConfig);
      }
    }

    return resolvedRepos;
  }

  static async aggregate(repos, rangeInMonths, onProgress) {
    if (!repos || repos.length === 0) return this.getEmptyState();

    let completed = 0;
    const total = repos.length;
    let allResults = [];
    
    // Otimização: Fila de concorrência inteligente (Worker Pool)
    // Processa até 4 repositórios simultaneamente de forma contínua, sem pausas artificiais de 500ms.
    // Isso mantém as requisições fluindo na capacidade máxima permitida pela rede do navegador.
    const CONCURRENCY_LIMIT = 4;
    const queue = [...repos]; // Clone para consumir como fila segura
    
    const worker = async () => {
      while (queue.length > 0) {
        const repo = queue.shift(); // Pega o próximo da fila
        try {
          const service = this.getService(repo);
          const res = await service.fetchAll(rangeInMonths);
          if (res) allResults.push(res);
        } catch (err) {
          console.error(`Falha ao buscar dados para ${repo.repo}:`, err);
        } finally {
          completed++;
          if (onProgress) onProgress(completed, total, repo);
        }
      }
    };

    // Inicializa 4 executores trabalhando paralelamente consumindo a fila
    const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
    await Promise.all(workers);

    // Consolidate values
    const combined = this.getEmptyState();
    const authorsMap = {};
    const commitsTimelineMap = {};

    allResults.forEach(res => {
      combined.commits += res.commits;
      combined.prsCreated += res.prsCreated;
      combined.prsMerged += res.prsMerged;
      combined.issuesOpen += res.issuesOpen || 0;
      combined.issuesClosed += res.issuesClosed || 0;
      combined.reviews += res.reviews || 0;
      combined.comments += res.comments || 0;
      combined.pullsWithReview += res.pullsWithReview || 0;

      // Merge commits timeline
      if (res.commitsTimeline) {
        Object.entries(res.commitsTimeline).forEach(([dateKey, count]) => {
          commitsTimelineMap[dateKey] = (commitsTimelineMap[dateKey] || 0) + count;
        });
      }

      // Weighted average for time-based metrics
      combined.totalReviewTime += (res.avgTimeFirstReview || 0) * (res.prsCreated || 0);
      combined.totalMergeTime += (res.avgTimeMerge || 0) * (res.prsMerged || 0);

      // Authors merge
      Object.entries(res.authors || {}).forEach(([author, count]) => {
        authorsMap[author] = (authorsMap[author] || 0) + count;
      });
    });

    combined.avgTimeFirstReview = combined.prsCreated > 0 ? combined.totalReviewTime / combined.prsCreated : 0;
    combined.avgTimeMerge = combined.prsMerged > 0 ? combined.totalMergeTime / combined.prsMerged : 0;
    
    // Cálculo de cobertura real: % de PRs que receberam ao menos uma revisão/comentário
    combined.reviewCoverage = combined.prsCreated > 0 ? (combined.pullsWithReview / combined.prsCreated) * 100 : 0;
    
    combined.authors = authorsMap;
    combined.commitsTimeline = commitsTimelineMap;

    return combined;
  }

  static getEmptyState() {
    return {
      commits: 0,
      prsCreated: 0,
      prsMerged: 0,
      issuesOpen: 0,
      issuesClosed: 0,
      reviews: 0,
      comments: 0,
      pullsWithReview: 0,
      avgTimeFirstReview: 0,
      avgTimeMerge: 0,
      reviewCoverage: 0,
      totalReviewTime: 0,
      totalMergeTime: 0,
      authors: {},
      commitsTimeline: {}
    };
  }
}
