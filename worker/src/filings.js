import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_CHARS = 80_000;
const ALLOWED_DOCUMENT_HOSTS = new Set([
  'nsearchives.nseindia.com', 'archives.nseindia.com', 'www.nseindia.com',
  'www.bseindia.com', 'api.bseindia.com',
]);
const MATERIAL_TYPES = [
  'financial-results', 'shareholding', 'promoter-pledge', 'related-party',
  'auditor', 'insider-trading', 'regulatory-legal', 'credit-rating',
  'capital-raise', 'board-management', 'corporate-action', 'business-update',
];

export async function extractFilingQuarter(env, { from, to, limit = 3 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    throw new Error('from and to must be YYYY-MM-DD dates');
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 3, 5));
  const placeholders = MATERIAL_TYPES.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT f.* FROM exchange_filings f
     LEFT JOIN filing_documents d ON d.filing_id = f.id
     WHERE f.filed_at >= ? AND f.filed_at < ? AND f.document_url IS NOT NULL
       AND f.filing_type IN (${placeholders})
       AND f.document_url LIKE 'http%'
       AND (d.id IS NULL OR d.extraction_status IN ('retry'))
     ORDER BY f.filed_at, f.id LIMIT ?`
  ).bind(from, to, ...MATERIAL_TYPES, safeLimit).all();

  const outcomes = [];
  for (const filing of results || []) outcomes.push(await extractOne(env, filing));
  const status = await filingExtractionStatus(env, { from, to });
  return { from, to, processed: outcomes.length, outcomes, status };
}

export async function filingExtractionStatus(env, { from, to } = {}) {
  const dateClause = from && to ? 'AND f.filed_at >= ? AND f.filed_at < ?' : '';
  const placeholders = MATERIAL_TYPES.map(() => '?').join(',');
  const query = `SELECT COALESCE(d.extraction_status, 'pending') AS status, COUNT(*) AS count
    FROM exchange_filings f LEFT JOIN filing_documents d ON d.filing_id = f.id
    WHERE f.filing_type IN (${placeholders}) ${dateClause}
    GROUP BY COALESCE(d.extraction_status, 'pending') ORDER BY status`;
  const statement = env.DB.prepare(query);
  const { results } = from && to
    ? await statement.bind(...MATERIAL_TYPES, from, to).all()
    : await statement.bind(...MATERIAL_TYPES).all();
  return Object.fromEntries((results || []).map((row) => [row.status, row.count]));
}

export async function cleanupFilingDocuments(env, { from, to } = {}) {
  const dateClause = from && to ? 'AND f.filed_at >= ? AND f.filed_at < ?' : '';
  const statement = env.DB.prepare(
    `SELECT d.*, f.filed_at FROM filing_documents d JOIN exchange_filings f ON f.id = d.filing_id
     WHERE d.content_sha256 IS NOT NULL ${dateClause} ORDER BY f.filed_at, d.filing_id`
  );
  const { results } = from && to ? await statement.bind(from, to).all() : await statement.all();
  const canonicalByHash = new Map();
  let deduplicated = 0;
  for (const document of results || []) {
    const canonical = canonicalByHash.get(document.content_sha256);
    if (!canonical) {
      canonicalByHash.set(document.content_sha256, document.filing_id);
      continue;
    }
    if (canonical === document.filing_id) continue;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM filing_pages WHERE filing_id = ?').bind(document.filing_id),
      env.DB.prepare("UPDATE filing_documents SET extraction_status = 'duplicate', error = NULL WHERE filing_id = ?").bind(document.filing_id),
      env.DB.prepare(
        `INSERT INTO filing_document_aliases (filing_id, canonical_filing_id) VALUES (?, ?)
         ON CONFLICT(filing_id) DO UPDATE SET canonical_filing_id=excluded.canonical_filing_id`
      ).bind(document.filing_id, canonical),
    ]);
    deduplicated++;
  }
  const invalid = await env.DB.prepare(
    `UPDATE filing_documents SET extraction_status = 'invalid-source-url'
     WHERE filing_id IN (SELECT id FROM exchange_filings WHERE document_url IS NULL OR document_url NOT LIKE 'http%')`
  ).run();
  const retryable = await env.DB.prepare(
    `UPDATE filing_documents SET extraction_status = 'retry'
     WHERE extraction_status = 'failed' AND error LIKE '%document-too-large:%'
       AND CAST(substr(error, instr(error, ':') + 1) AS INTEGER) <= ?`
  ).bind(MAX_PDF_BYTES).run();
  return {
    deduplicated,
    invalidSourceUrls: invalid.meta.changes,
    retryableAfterLimitReview: retryable.meta.changes,
    status: await filingExtractionStatus(env, { from, to }),
  };
}

async function extractOne(env, filing) {
  const startedAt = new Date().toISOString();
  try {
    const documentUrl = new URL(filing.document_url);
    if (documentUrl.protocol !== 'https:' || !ALLOWED_DOCUMENT_HOSTS.has(documentUrl.hostname)) {
      throw new Error(`untrusted-document-host:${documentUrl.hostname}`);
    }
    const response = await fetch(filing.document_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompoundingDhanResearch/1.0)', Accept: 'application/pdf,*/*' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`download-http-${response.status}`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_PDF_BYTES) throw new Error(`document-too-large:${declaredSize}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) throw new Error(`document-too-large:${bytes.byteLength}`);
    if (String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') throw new Error('response-is-not-pdf');

    const hash = await sha256(bytes);
    const duplicate = await env.DB.prepare(
      `SELECT filing_id FROM filing_documents
       WHERE content_sha256 = ? AND extraction_status IN ('extracted', 'needs-ocr')
       ORDER BY filing_id LIMIT 1`
    ).bind(hash).first();
    if (duplicate && duplicate.filing_id !== filing.id) {
      await upsertDocument(env, filing.id, {
        hash, mimeType: response.headers.get('content-type') || 'application/pdf', bytes: bytes.byteLength,
        status: 'duplicate', extractedAt: startedAt, error: null,
      });
      await env.DB.prepare(
        `INSERT INTO filing_document_aliases (filing_id, canonical_filing_id) VALUES (?, ?)
         ON CONFLICT(filing_id) DO UPDATE SET canonical_filing_id=excluded.canonical_filing_id`
      ).bind(filing.id, duplicate.filing_id).run();
      return { filingId: filing.id, symbol: filing.symbol, type: filing.filing_type, status: 'duplicate', canonicalFilingId: duplicate.filing_id };
    }
    const pdf = await getDocumentProxy(bytes);
    const extracted = await withTimeout(extractText(pdf, { mergePages: false }), 25_000, 'pdf-extraction-timeout');
    const pages = (extracted.text || []).map((value, index) => ({
      page: index + 1,
      text: normalizeText(value).slice(0, MAX_PAGE_CHARS),
    }));
    const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
    const quality = extractionQuality(pages, extracted.totalPages);

    await env.DB.prepare('DELETE FROM filing_pages WHERE filing_id = ?').bind(filing.id).run();
    for (let offset = 0; offset < pages.length; offset += 50) {
      await env.DB.batch(pages.slice(offset, offset + 50).map((page) => env.DB.prepare(
        `INSERT INTO filing_pages (filing_id, page_number, text_content, character_count)
         VALUES (?, ?, ?, ?)`
      ).bind(filing.id, page.page, page.text, page.text.length)));
    }
    const status = quality === 'no-text' ? 'needs-ocr' : 'extracted';
    await upsertDocument(env, filing.id, {
      hash, mimeType: response.headers.get('content-type') || 'application/pdf', bytes: bytes.byteLength,
      pages: extracted.totalPages, characters: characterCount, status, quality, extractedAt: startedAt, error: null,
    });
    return { filingId: filing.id, symbol: filing.symbol, type: filing.filing_type, status, pages: extracted.totalPages, characters: characterCount, quality };
  } catch (error) {
    await upsertDocument(env, filing.id, { status: 'failed', extractedAt: startedAt, error: String(error).slice(0, 500) });
    return { filingId: filing.id, symbol: filing.symbol, type: filing.filing_type, status: 'failed', error: String(error) };
  }
}

async function upsertDocument(env, filingId, data) {
  await env.DB.prepare(
    `INSERT INTO filing_documents
       (filing_id, content_sha256, mime_type, byte_size, page_count, character_count,
        extraction_status, extraction_quality, extracted_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(filing_id) DO UPDATE SET
       content_sha256=excluded.content_sha256, mime_type=excluded.mime_type,
       byte_size=excluded.byte_size, page_count=excluded.page_count,
       character_count=excluded.character_count, extraction_status=excluded.extraction_status,
       extraction_quality=excluded.extraction_quality, extracted_at=excluded.extracted_at, error=excluded.error`
  ).bind(filingId, data.hash || null, data.mimeType || null, data.bytes || null, data.pages || null,
    data.characters || 0, data.status, data.quality || null, data.extractedAt, data.error || null).run();
}

function normalizeText(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractionQuality(pages, totalPages) {
  const characters = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (!characters) return 'no-text';
  const perPage = characters / Math.max(totalPages || pages.length, 1);
  if (perPage < 100) return 'sparse';
  return 'text';
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
