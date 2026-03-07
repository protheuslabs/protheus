#!/usr/bin/env node
/**
 * Eye: arxiv_ai
 * Source: arXiv.org AI/ML papers (cs.AI, cs.LG, cs.CL, cs.AR)
 * Parsers: atom, rss
 */

const https = require('https');
const { parseStringPromise } = require('xml2js');
const { createHash } = require('crypto');

const CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.AR', 'cs.CV', 'cs.IR'];
const BASE_URL = 'https://export.arxiv.org/api/query';

async function fetchArxivPapers(maxResults = 50) {
  const categoryQuery = CATEGORIES.map(c => `cat:${c}`).join(' OR ');
  const url = `${BASE_URL}?search_query=${encodeURIComponent(categoryQuery)}&sortBy=submittedDate&sortOrder=descending&maxResults=${maxResults}`;
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        try {
          const parsed = await parseStringPromise(data);
          const entries = parsed.feed?.entry || [];
          const papers = entries.map(entry => ({
            id: entry.id?.[0]?.split('/').pop() || '',
            title: entry.title?.[0]?.replace(/\s+/g, ' ').trim() || '',
            authors: entry.author?.map(a => a.name?.[0]).filter(Boolean) || [],
            abstract: entry.summary?.[0]?.replace(/\s+/g, ' ').trim() || '',
            url: entry.id?.[0] || '',
            pdf_url: entry.link?.find(l => l.$.title === 'pdf')?.$.href || '',
            published: entry.published?.[0] || '',
            updated: entry.updated?.[0] || '',
            categories: entry.category?.map(c => c.$.term).filter(Boolean) || [],
            primary_category: entry['arxiv:primary_category']?.[0]?.$.term || '',
            fetched_at: new Date().toISOString(),
            source: 'arxiv_ai'
          }));
          resolve(papers);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function hashPaper(paper) {
  return createHash('sha256').update(paper.id + paper.updated).digest('hex').slice(0, 16);
}

async function collect(options = {}) {
  const { maxResults = 50, since } = options;
  
  try {
    const papers = await fetchArxivPapers(maxResults);
    
    const filtered = since 
      ? papers.filter(p => new Date(p.published) > new Date(since))
      : papers;
    
    return {
      ok: true,
      eye: 'arxiv_ai',
      count: filtered.length,
      papers: filtered.map(p => ({
        ...p,
        hash: hashPaper(p)
      })),
      meta: {
        categories: CATEGORIES,
        filtered_by: since ? `published > ${since}` : 'none'
      }
    };
  } catch (err) {
    return {
      ok: false,
      eye: 'arxiv_ai',
      error: err.message
    };
  }
}

// CLI
if (require.main === module) {
  collect({ maxResults: process.argv[2] ? parseInt(process.argv[2]) : 25 })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    });
}

module.exports = { collect, fetchArxivPapers };
