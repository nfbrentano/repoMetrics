import { GitHubService } from './GitHubService.js';
import { AzureService } from './AzureService.js';
import { GitLabService } from './GitLabService.js';
import { BitbucketService } from './BitbucketService.js';

const API_BASE = '/api';

export class DataAggregator {

  /**
   * Try to get cached metrics from the backend (instant, no API calls)
   */
  static async getCachedMetrics(rangeInMonths = 6) {
    try {
      const res = await fetch(`${API_BASE}/metrics?range=${rangeInMonths}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.metrics && data.repoCount > 0) {
        return data.metrics;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Sync repos through the backend (incremental, saves to SQLite)
   * Returns metrics calculated from the local DB after sync.
   */
  static async syncAndAggregate(repos, rangeInMonths, onProgress) {
    try {
      if (onProgress) onProgress(0, repos.length, { repo: 'Enviando para o servidor...' });

      const res = await fetch(`${API_BASE}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos, rangeMonths: rangeInMonths })
      });

      if (!res.ok) {
        throw new Error(`Sync falhou: ${res.status}`);
      }

      const data = await res.json();

      if (onProgress) onProgress(repos.length, repos.length, { repo: 'Concluído' });

      return {
        metrics: data.metrics,
        resolvedRepos: data.resolvedRepos || []
      };
    } catch (err) {
      console.error('Backend sync failed, falling back to direct fetch:', err);
      // Fallback: use the old direct-fetch approach
      return this.fallbackAggregate(repos, rangeInMonths, onProgress);
    }
  }

  /**
   * Fallback: original client-side aggregation (if backend unavailable)
   */
  static async fallbackAggregate(repos, rangeInMonths, onProgress) {
    const resolvedRepos = await this.expandWildcardRepos(repos);

    if (!resolvedRepos || resolvedRepos.length === 0) return { metrics: this.getEmptyState(), resolvedRepos: [] };

    let completed = 0;
    const total = resolvedRepos.length;
    let allResults = [];

    const CONCURRENCY_LIMIT = 4;
    const queue = [...resolvedRepos];

    const worker = async () => {
      while (queue.length > 0) {
        const repo = queue.shift();
        try {
          const service = this.getService(repo);
          const res = await service.fetchAll(rangeInMonths);
          if (res) {
            res.repoInfo = repo;
            allResults.push(res);
          }
        } catch (err) {
          console.error(`Falha ao buscar dados para ${repo.repo}:`, err);
        } finally {
          completed++;
          if (onProgress) onProgress(completed, total, repo);
        }
      }
    };

    const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
    await Promise.all(workers);

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

      if (res.commitsTimeline) {
        Object.entries(res.commitsTimeline).forEach(([dateKey, count]) => {
          commitsTimelineMap[dateKey] = (commitsTimelineMap[dateKey] || 0) + count;
        });
      }

      combined.totalReviewTime += (res.avgTimeFirstReview || 0) * (res.prsCreated || 0);
      combined.totalMergeTime += (res.avgTimeMerge || 0) * (res.prsMerged || 0);

      Object.entries(res.authors || {}).forEach(([author, count]) => {
        authorsMap[author] = (authorsMap[author] || 0) + count;
      });
    });

    combined.avgTimeFirstReview = combined.prsCreated > 0 ? combined.totalReviewTime / combined.prsCreated : 0;
    combined.avgTimeMerge = combined.prsMerged > 0 ? combined.totalMergeTime / combined.prsMerged : 0;
    combined.reviewCoverage = combined.prsCreated > 0 ? (combined.pullsWithReview / combined.prsCreated) * 100 : 0;
    combined.authors = authorsMap;
    combined.commitsTimeline = commitsTimelineMap;
    combined.repoDetails = allResults;

    return { metrics: combined, resolvedRepos };
  }

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
      commitsTimeline: {},
      repoDetails: []
    };
  }
}
