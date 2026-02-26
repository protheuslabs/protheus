#!/usr/bin/env node
/**
 * Eye: openreview_venues
 * Source: OpenReview.net (ICLR, ICML, NeurIPS papers)
 * Parsers: json, html
 */

const https = require('https');
const { createHash } = require('crypto');

const VENUES = [
  { id: 'ICLR.cc/2025/Conference', name: 'ICLR 2025' },
  { id: 'ICML.cc/2025/Conference', name: 'ICML 2025' },
  { id: 'NeurIPS.cc/2024/Conference', name: 'NeurIPS 2024' },
  { id: 'NeurIPS.cc/2025/Conference', name: 'NeurIPS 2025' },
];

async function fetchOpenReviewNotes(invitation, limit = 50) {
  const url = `https://api.openreview.net/notes?invitation=${encodeURIComponent(invitation + '/-/Blind_Submission')}&limit=${limit}`;
  
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OpenClaw-Agent-Eye/1.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.notes || []);
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

function normalizePaper(note, venue) {
  const content = note.content || {};
  return {
    id: `or_${note.id}`,
    title: content.title?.value || content.title || '',
    abstract: content.abstract?.value || content.abstract || '',
    url: `https://openreview.net/forum?id=${note.forum}`,
    pdf_url: content.pdf?.value || `https://openreview.net/pdf?id=${note.id}`,
    authors: content.authors?.value || content.authors || [],
    tl_dr: content.tldr?.value || content.tldr || '',
    keywords: content.keywords?.value || content.keywords || [],
    venue: venue.name,
    venue_id: venue.id,
    created: note.tcdate || note.cdate,
    updated: note.tmdate || note.mdate,
    source: 'openreview_venues',
    fetched_at: new Date().toISOString()
  };
}

function hashPaper(paper) {
  return createHash('sha256').update(paper.id + paper.updated).digest('hex').slice(0, 16);
}

async function collect(options = {}) {
  const { venues = VENUES, since } = options;
  
  try {
    const allPapers = [];
    
    for (const venue of venues) {
      try {
        const notes = await fetchOpenReviewNotes(venue.id, 25);
        const papers = notes.map(n => normalizePaper(n, venue));
        allPapers.push(...papers);
      } catch (err) {
        console.error(`Warning: Failed to fetch ${venue.name}: ${err.message}`);
      }
    }
    
    const filtered = since 
      ? allPapers.filter(p => new Date(p.created) > new Date(since))
      : allPapers;
    
    return {
      ok: true,
      eye: 'openreview_venues',
      count: filtered.length,
      papers: filtered.map(p => ({ ...p, hash: hashPaper(p) })),
      meta: {
        venues: venues.map(v => v.name),
        filtered_by: since ? `created > ${since}` : 'none'
      }
    };
  } catch (err) {
    return {
      ok: false,
      eye: 'openreview_venues',
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

module.exports = { collect, fetchOpenReviewNotes, VENUES };
