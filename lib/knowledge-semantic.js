'use strict';
const { createIndex, validate, PROFILE, LEGACY_PROFILE } = require('../public/knowledge-semantic');
const { createEncoder } = require('./semantic-encoder');
const encoder = createEncoder();
const { aliasesFor } = require('../public/knowledge-search').createSearchEngine();

async function build(records, onProgress = () => {}, { legacy = false } = {}) {
  const chunks = await encoder.chunksFor(records, { legacy }), vectors = [];
  for (let start = 0; start < chunks.length; start += 16) {
    vectors.push(...await encoder.encode(chunks.slice(start, start + 16).map(chunk => chunk.text)));
    onProgress(Math.min(start + 16, chunks.length), chunks.length);
  }
  return createIndex(chunks, vectors, legacy ? LEGACY_PROFILE : PROFILE);
}

async function search(records, index, query, lexical, { manualId = '', module = '', mode = '', limit = 10, semanticOnly = false } = {}) {
  const vectors = validate(records, index);
  const [question] = await encoder.encode([query], true), byChapter = new Map();
  const entities = query.toLowerCase().match(/at\+[a-z0-9_]+|cm_[a-z0-9_]+|\b(?:https?|ftp|mqtt|webui|gpio|pdp|apn|ssl|tls|tcp|udp|dns|ntp)\b/g) || [];
  const secondaryAuth = /二次(?:认证|验证)|二级认证|双重认证|两步(?:认证|验证)|双因素认证|\b(?:2fa|mfa)\b/i;
  const needsSecondaryAuth = secondaryAuth.test(query);
  const webuiScope = !entities.length && query.includes('网页') && records.some(record => /webui/i.test(record.manualTitle));
  const inScope = record => (!manualId || record.manualId === manualId) && (!module || record.module.toLowerCase() === module.toLowerCase()) &&
    (!mode || record.mode.toLowerCase() === mode.toLowerCase()) && (!webuiScope || /webui/i.test(record.manualTitle)) &&
    (!needsSecondaryAuth || secondaryAuth.test([record.title, record.text, ...(record.aliases || [])].join(' '))) &&
    entities.every(term => [record.title, record.text, record.manualTitle, record.module, ...aliasesFor(record)].join(' ').toLowerCase().includes(term));
  for (const [i, chunk] of index.chunks.entries()) {
    const record = records[chunk.position];
    if (!inScope(record)) continue;
    let similarity = 0;
    for (let j = 0; j < PROFILE.dimensions; j++) similarity += question[j] * vectors[i * PROFILE.dimensions + j];
    const old = byChapter.get(chunk.position);
    if (!old || similarity > old.similarity) byChapter.set(chunk.position, { position: chunk.position, similarity, excerpt: chunk.text });
  }
  const semanticHits = [...byChapter.values()].sort((a, b) => b.similarity - a.similarity);
  const eligibleLexical = lexical.filter(hit => inScope(records[hit.position]));
  const lexicalRank = new Map(eligibleLexical.map((hit, rank) => [hit.position, rank]));
  const combined = semanticHits.filter(hit => hit.similarity >= 0.55).map((hit, rank) => ({
    ...hit, score: semanticOnly ? hit.similarity : 1 / (60 + rank + 1) + (lexicalRank.has(hit.position) ? 1 / (60 + lexicalRank.get(hit.position) + 1) : 0),
    reason: lexicalRank.has(hit.position) ? '关键词与语义匹配' : '语义相关片段', matchedTerms: [],
    semanticScore: Math.round(hit.similarity * 1000) / 1000
  }));
  if (!semanticOnly) {
    const positions = new Set(combined.map(hit => hit.position));
    for (const [rank, hit] of eligibleLexical.entries()) {
      if (!positions.has(hit.position)) combined.push({ ...hit, score: 1 / (60 + rank + 1) });
    }
    // Strong exact titles and explicit aliases retain lexical precedence.
    const first = eligibleLexical[0], next = eligibleLexical[1];
    const clearLexical = first && first.reason === '章节关键词匹配' && first.matchedTerms.length >= 3 &&
      (!next || first.score >= next.score * 2);
    if (first?.score >= 1500 || clearLexical) return eligibleLexical.slice(0, limit);
  }
  return combined.sort((a, b) => b.score - a.score).slice(0, limit);
}
const requiresLexical = query => /^(?:at\+[a-z0-9_]+|[a-z_][a-z0-9_]*_[a-z0-9_]*|-?\d+)$/i.test(query) || /(?:错误|状态码|返回值|结果码|返回).*\d|\d.*(?:错误|状态码)/i.test(query);
module.exports = { build, search, encoder, requiresLexical };
