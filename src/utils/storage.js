export const STORAGE_KEYS = {
  REPOS: 'repometrics_repos',
  THEME: 'repometrics_theme',
  RANGE: 'repometrics_range'
};

export const loadRepos = () => {
  const data = localStorage.getItem(STORAGE_KEYS.REPOS);
  return data ? JSON.parse(data) : [];
};

export const saveRepos = (repos) => {
  localStorage.setItem(STORAGE_KEYS.REPOS, JSON.stringify(repos));
};

export const loadRange = () => {
  return localStorage.getItem(STORAGE_KEYS.RANGE) || '6m';
};

export const saveRange = (range) => {
  localStorage.setItem(STORAGE_KEYS.RANGE, range);
};
