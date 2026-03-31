export class BaseGitService {
  constructor(config) {
    this.token = config.token;
    this.namespace = config.namespace;
    this.repo = config.repo;
    this.provider = config.provider;
  }

  async fetchAll(rangeInMonths) {
    throw new Error('Method fetchAll() must be implemented.');
  }

  // Helper to calculate date range
  getSinceDate(months) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString();
  }

  // Unified formatting for metrics
  normalizeMetrics(data) {
    return {
      activity: {
        commits: data.commits || 0,
        prsCreated: data.prsCreated || 0,
        prsMerged: data.prsMerged || 0,
        issuesOpen: data.issuesOpen || 0,
        issuesClosed: data.issuesClosed || 0,
        timeline: data.timeline || [] // { date: 'YYYY-MM-DD', commits: 0, prs: 0, issues: 0 }
      },
      collaboration: {
        reviews: data.reviews || 0,
        avgTimeFirstReview: data.avgTimeFirstReview || 0, // in hours
        avgTimeMerge: data.avgTimeMerge || 0, // in hours
        reviewCoverage: data.reviewCoverage || 0, // %
        comments: data.comments || 0,
        authors: data.authors || {} // { 'name': count }
      }
    };
  }
}
