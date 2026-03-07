#!/usr/bin/env node
/**
 * Test skill - generates large output for compaction testing
 */

// Generate large test data (>1200 chars)
const largeData = {
  source: 'test_large_output',
  timestamp: new Date().toISOString(),
  posts: Array(50).fill(0).map((_, i) => ({
    id: `post_${i}_${Math.random().toString(36).substring(7)}`,
    title: `Test post number ${i} with lots of text to ensure compaction triggers`,
    content: `This is a very long content that should definitely trigger compaction because it exceeds the thresholds easily. `.repeat(20),
    upvotes: Math.floor(Math.random() * 1000),
    comment_count: Math.floor(Math.random() * 100),
    fake_secret: 'moltbook_sk_FAKE1234567890ABCDEF1234567890ABCDEF1234567890' // Should be redacted (needs 32+ chars after prefix)
  }))
};

console.log(JSON.stringify(largeData, null, 2));