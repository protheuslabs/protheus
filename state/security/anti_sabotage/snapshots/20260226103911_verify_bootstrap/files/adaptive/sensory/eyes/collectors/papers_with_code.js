#!/usr/bin/env node
/**
 * Eye: papers_with_code
 * Source: Papers With Code - trending/recent papers with GitHub repos
 * Parsers: json, rss
 */

const https = require('https');
const { createHash } = require('crypto');

const BASE_URL = 'https://paperswithcode.com/api/v1';

async function fetchPWC(endpoint) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE_URL}${endpoint}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OpenClaw-Agent-Eye/1.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchTrendingPapers() {
  // Papers With Code trending
  const data = await fetchPWC('/papers/?ordering=-published&page_size=50');
  return data.results || [];
}

async function fetchPapersWithRepos() {
  // Papers that have GitHub implementations
  const data = await fetchPWC('/papers/?ordering=-stars_github&page_size=25');
  return data.results || [];
}

function normalizePaper(pwcPaper) {
  return {
    id: `pwc_${pwcPaper.id}`,
    title: pwcPaper.title?.trim() || '',
    abstract: pwcPaper.abstract?.trim() || '',
    url: pwcPaper.url_abs || pwcPaper.paper_url || '',
    pdf_url: pwcPaper.url_pdf || '',
    authors: pwcPaper.authors?.map(a => a.name) || [],
    published: pwcPaper.published || '',
    arxiv_id: pwcPaper.arxiv_id || null,
    github_url: pwcPaper.repository_url || pwcPaper.github_url || null,
    github_stars: pwcPaper.stars_github || 0,
    framework: pwcPaper.framework || null,
    tasks: pwcPaper.tasks?.map(t => t.task) || [],
    datasets: pwcPaper.datasets?.map(d => d.dataset) || [],
    methods: pwcPaper.methods?.map(m => m.name) || [],
    source: 'papers_with_code',
    fetched_at: new Date().toISOString()
  };
}

function hashPaper(paper) {
  return createHash('sha256').update(paper.id + paper.published).digest('hex').slice(0, 16);
}

async function collect(options = {}) {
  const { trending = true, withRepos = true, since } = options;
  
  try {
    const promises = [];
    if (trending) promises.push(fetchTrendingPapers());
    if (withRepos) promises.push(fetchPapersWithRepos());
    
    const results = await Promise.all(promises);
    const allPapers = results.flat();
    
    // Deduplicate by ID
    const seen = new Set();
    const unique = [];
    for (const paper of allPapers) {
      if (!seen.has(paper.id)) {
        seen.add(paper.id);
        unique.push(paper);
      }
    }
    
    const normalized = unique.map(normalizePaper);
    
    const filtered = since 
      ? normalized.filter(p => new Date(p.published) > new Date(since))
      : normalized;
    
    return {
      ok: true,
      eye: 'papers_with_code',
      count: filtered.length,
      papers: filtered.map(p => ({ ...p, hash: hashPaper(p) })),
      meta: {
        sources: ['trending', 'with_repos'].filter(s => 
          (s === 'trending' && trending) || (s === 'with_repos' && withRepos)
        ),
        filtered_by: since ? `published > ${since}` : 'none'
      }
    };
  } catch (err) {
    return {
      ok: false,
      eye: 'papers_with_code',
      error: err.message
    };
  }
}

// CLI
if (require.main === module) {
  collect()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    });
}

module.exports = { collect, fetchTrendingPapers, fetchPapersWithRepos };
