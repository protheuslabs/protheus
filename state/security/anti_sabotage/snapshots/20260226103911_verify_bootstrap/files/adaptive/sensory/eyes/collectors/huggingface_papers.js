#!/usr/bin/env node
/**
 * Eye: huggingface_papers
 * Source: Hugging Face Daily Papers
 * Parsers: json, rss
 */

const https = require('https');
const { createHash } = require('crypto');

const BASE_URL = 'https://huggingface.co/api/daily_papers';

async function fetchHFPapers() {
  return new Promise((resolve, reject) => {
    https.get(BASE_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OpenClaw-Agent-Eye/1.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const papers = JSON.parse(data);
          resolve(Array.isArray(papers) ? papers : []);
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

function normalizePaper(hfPaper) {
  return {
    id: `hf_${hfPaper.id || hfPaper.paper?.id}`,
    title: hfPaper.title || hfPaper.paper?.title?.trim() || '',
    abstract: hfPaper.summary || hfPaper.paper?.summary?.trim() || '',
    url: hfPaper.url || hfPaper.paper?.url || '',
    pdf_url: hfPaper.pdf_url || hfPaper.paper?.pdf_url || '',
    authors: hfPaper.authors || hfPaper.paper?.authors?.map(a => a.name) || [],
    published: hfPaper.published_at || hfPaper.publishedOn || new Date().toISOString(),
    votes: hfPaper.reactions?.length || hfPaper.upvotes || 0,
    comment_count: hfPaper.numComments || 0,
    thumbnail: hfPaper.thumbnail || null,
    source: 'huggingface_papers',
    fetched_at: new Date().toISOString()
  };
}

function hashPaper(paper) {
  return createHash('sha256').update(paper.id + paper.published).digest('hex').slice(0, 16);
}

async function collect(options = {}) {
  const { since } = options;
  
  try {
    const papers = await fetchHFPapers();
    const normalized = papers.map(normalizePaper);
    
    const filtered = since 
      ? normalized.filter(p => new Date(p.published) > new Date(since))
      : normalized;
    
    return {
      ok: true,
      eye: 'huggingface_papers',
      count: filtered.length,
      papers: filtered.map(p => ({ ...p, hash: hashPaper(p) })).sort((a, b) => b.votes - a.votes),
      meta: {
        source: 'huggingface.co/daily_papers',
        sorted_by: 'votes_desc',
        filtered_by: since ? `published > ${since}` : 'none'
      }
    };
  } catch (err) {
    return {
      ok: false,
      eye: 'huggingface_papers',
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

module.exports = { collect, fetchHFPapers };
