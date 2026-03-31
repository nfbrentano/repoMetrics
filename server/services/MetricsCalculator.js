import db from '../db.js';

/**
 * MetricsCalculator - Computes dashboard metrics from SQLite data
 * No API calls needed — everything is calculated from cached local data.
 */
export class MetricsCalculator {
  /**
   * Get aggregated metrics for given repos within a date range
   */
  static getMetrics(repoIds, rangeInMonths = 6) {
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - rangeInMonths);
    const sinceISO = sinceDate.toISOString();

    const placeholders = repoIds.map(() => '?').join(',');

    // Commits
    const commits = db.prepare(`
      SELECT repo_id, sha, author, date FROM commits
      WHERE repo_id IN (${placeholders}) AND date >= ?
      ORDER BY date DESC
    `).all(...repoIds, sinceISO);

    // PRs
    const prs = db.prepare(`
      SELECT repo_id, number, state, created_at, merged_at, closed_at, author FROM pull_requests
      WHERE repo_id IN (${placeholders}) AND created_at >= ?
    `).all(...repoIds, sinceISO);

    // Issues
    const issues = db.prepare(`
      SELECT repo_id, number, state, created_at, closed_at FROM issues
      WHERE repo_id IN (${placeholders}) AND created_at >= ?
    `).all(...repoIds, sinceISO);

    // Reviews
    const reviews = db.prepare(`
      SELECT r.repo_id, r.pr_number, r.reviewer, r.submitted_at
      FROM reviews r
      WHERE r.repo_id IN (${placeholders})
    `).all(...repoIds);

    // Calculate aggregate metrics
    const totalCommits = commits.length;
    const totalPRsCreated = prs.length;
    const totalPRsMerged = prs.filter(p => p.state === 'merged').length;
    const totalPRsOpen = prs.filter(p => p.state === 'open').length;
    const totalIssuesOpen = issues.filter(i => i.state === 'open').length;
    const totalIssuesClosed = issues.filter(i => i.state === 'closed').length;
    const totalIssues = issues.length;
    const totalReviews = reviews.length;

    // Authors map
    const authorsMap = {};
    commits.forEach(c => {
      authorsMap[c.author] = (authorsMap[c.author] || 0) + 1;
    });

    // Commits timeline
    const commitsTimeline = {};
    commits.forEach(c => {
      if (c.date) {
        const d = new Date(c.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        commitsTimeline[key] = (commitsTimeline[key] || 0) + 1;
      }
    });

    // PRs with at least 1 review
    const prsWithReviewSet = new Set();
    reviews.forEach(r => {
      const key = `${r.repo_id}_${r.pr_number}`;
      prsWithReviewSet.add(key);
    });
    const pullsWithReview = prsWithReviewSet.size;

    // Time to first review (avg)
    let totalReviewTime = 0;
    let reviewTimeCount = 0;

    // Group reviews by PR, find earliest
    const reviewsByPR = {};
    reviews.forEach(r => {
      const key = `${r.repo_id}_${r.pr_number}`;
      if (!reviewsByPR[key] || new Date(r.submitted_at) < new Date(reviewsByPR[key])) {
        reviewsByPR[key] = r.submitted_at;
      }
    });

    // Match with PR creation date
    prs.forEach(p => {
      const key = `${p.repo_id}_${p.number}`;
      if (reviewsByPR[key] && p.created_at) {
        const firstReview = new Date(reviewsByPR[key]);
        const created = new Date(p.created_at);
        const diff = (firstReview - created) / (1000 * 60 * 60);
        if (diff >= 0) {
          totalReviewTime += diff;
          reviewTimeCount++;
        }
      }
    });

    // Time to merge (avg)
    let totalMergeTime = 0;
    let mergeCount = 0;
    prs.forEach(p => {
      if (p.state === 'merged' && p.merged_at && p.created_at) {
        const created = new Date(p.created_at);
        const merged = new Date(p.merged_at);
        totalMergeTime += (merged - created) / (1000 * 60 * 60);
        mergeCount++;
      }
    });

    const reviewCoverage = totalPRsCreated > 0 ? (pullsWithReview / totalPRsCreated) * 100 : 0;
    const avgTimeFirstReview = reviewTimeCount > 0 ? totalReviewTime / reviewTimeCount : 0;
    const avgTimeMerge = mergeCount > 0 ? totalMergeTime / mergeCount : 0;

    // Last update per repo
    const lastUpdateByRepo = {};
    commits.forEach(c => {
      if (!lastUpdateByRepo[c.repo_id] || new Date(c.date) > new Date(lastUpdateByRepo[c.repo_id])) {
        lastUpdateByRepo[c.repo_id] = c.date;
      }
    });

    // Per-repo details
    const repoDetails = repoIds.map(repoId => {
      const repoCommits = commits.filter(c => c.repo_id === repoId);
      const repoPRs = prs.filter(p => p.repo_id === repoId);
      const repoIssues = issues.filter(i => i.repo_id === repoId);
      const repoReviews = reviews.filter(r => r.repo_id === repoId);

      const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);

      return {
        repoInfo: repoRow ? {
          id: repoRow.id,
          provider: repoRow.provider,
          namespace: repoRow.namespace,
          repo: repoRow.repo
        } : null,
        commits: repoCommits.length,
        prsCreated: repoPRs.length,
        prsMerged: repoPRs.filter(p => p.state === 'merged').length,
        prsOpen: repoPRs.filter(p => p.state === 'open').length,
        issuesOpen: repoIssues.filter(i => i.state === 'open').length,
        issuesTotal: repoIssues.length,
        lastUpdate: lastUpdateByRepo[repoId] || null,
        reviews: repoReviews.length,
        pullsWithReview: new Set(repoReviews.map(r => r.pr_number)).size
      };
    });

    return {
      commits: totalCommits,
      prsCreated: totalPRsCreated,
      prsMerged: totalPRsMerged,
      prsOpen: totalPRsOpen,
      issuesOpen: totalIssuesOpen,
      issuesClosed: totalIssuesClosed,
      issuesTotal: totalIssues,
      reviews: totalReviews,
      comments: totalReviews,
      pullsWithReview,
      avgTimeFirstReview,
      avgTimeMerge,
      reviewCoverage,
      totalReviewTime,
      totalMergeTime,
      authors: authorsMap,
      commitsTimeline,
      repoDetails
    };
  }

  /**
   * Get sync status for all repos
   */
  static getSyncStatus() {
    return db.prepare(`
      SELECT r.id, r.provider, r.namespace, r.repo, r.last_synced_at,
        (SELECT COUNT(*) FROM commits WHERE repo_id = r.id) as total_commits,
        (SELECT COUNT(*) FROM pull_requests WHERE repo_id = r.id) as total_prs
      FROM repos r
      ORDER BY r.last_synced_at DESC
    `).all();
  }
}
