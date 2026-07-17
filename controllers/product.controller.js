const Product = require('../models/Product');
const Category = require('../models/Category');
const ProductTag = require('../models/ProductTag');
const mongoose = require('mongoose');
const slugify = require('slugify');
const { generateSlug, generateSku } = require('../utils/productUtils');
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  optimizeProductImageBuffer
} = require('../utils/cloudinaryHelper');
const fs = require('fs');
const csv = require('csv-parser');
const unzipper = require('unzipper');
const path = require('path');
const axios = require('axios');
const AdmZip = require("adm-zip");
const { Parser } = require("json2csv");   //  ADD THIS
const { generateSEOData } = require("../utils/seoUtils");
const {
  applyVariantCatalogFieldsToTarget,
  buildVariantCatalogFieldsFromImportRow,
  parseVariantShippingForStorage,
  parseVariantTextForStorage,
  validateVariantsResolvableShipping
} = require("../utils/variantCatalogFields");
const {
  deriveProductChannelStatusFromLegacy,
  deriveVariantChannelVisibilityFromLegacy,
  mergeProductChannelStatus,
  mergeVariantChannelVisibility,
  hasWholesalePricingConfig,
  hasWholesalePricingEligibleVariant,
  hasActiveWholesaleVariantForCatalog,
  getVariantAvailabilityByStorefront,
  deriveProductChannelStatusFromVariants,
  propagateProductChannelStatusToVariants,
  reconcileProductCatalogState
} = require("../utils/storefrontCatalog");


// =============================================
//  CACHE INVALIDATION HELPERS (SINGLE DEFINITION)
// =============================================
const invalidateProductCaches = async (productSlug = null) => {
  try {
    const cacheService = require('../services/cache.service');
    const cacheConfig = require('../config/cache.config');
    
    // Invalidate ALL product caches - simplest approach
    await cacheService.forget(`${cacheConfig.prefixes.PRODUCT}:*`);
    await cacheService.forget(`${cacheConfig.prefixes.SEARCH}:*`);
    
    console.log(`✅ Cache invalidated for product: ${productSlug || 'all'}`);
  } catch (err) {
    console.error('Cache invalidation error:', err);
  }
};

/** Bulk path: same PRODUCT + SEARCH patterns as single-product invalidation. */
const invalidateAllProductCaches = async () => {
  await invalidateProductCaches('all-bulk');
};

// =============================================
// HELPER: Parse boolean from various formats
// =============================================
function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  return false;
}

function parsePositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function validateRequiredShippingFields(rawShipping) {
  const shipping = rawShipping && typeof rawShipping === "object" ? rawShipping : {};
  const dimensions =
    shipping.dimensions && typeof shipping.dimensions === "object"
      ? shipping.dimensions
      : {};

  const weight = parsePositiveNumber(shipping.weight);
  const length = parsePositiveNumber(dimensions.length);
  const width = parsePositiveNumber(dimensions.width);
  const height = parsePositiveNumber(dimensions.height);

  if (weight == null) {
    return {
      valid: false,
      message: "Shipping weight is required and must be greater than 0"
    };
  }
  if (length == null || width == null || height == null) {
    return {
      valid: false,
      message: "Shipping dimensions (length, width, height) are required and must be greater than 0"
    };
  }

  return {
    valid: true,
    shipping: {
      weight,
      dimensions: { length, width, height }
    }
  };
}

function collectWholesaleInventoryWarnings(variants = []) {
  if (!Array.isArray(variants)) return [];
  const warnings = [];
  for (const variant of variants) {
    if (!variant || variant.wholesale !== true) continue;
    if (!hasWholesalePricingConfig(variant)) continue;
    const trackInventory = variant?.inventory?.trackInventory !== false;
    if (!trackInventory) continue;
    const qty = Number(variant?.inventory?.quantity || 0);
    const moq = Math.max(1, Number(variant?.minimumOrderQuantity || 1));
    if (Number.isFinite(qty) && Number.isFinite(moq) && qty > 0 && qty < moq) {
      warnings.push({
        productCode: variant.productCode || null,
        code: 'WHOLESALE_MOQ_EXCEEDS_STOCK',
        message: `Inventory (${qty}) is below wholesale MOQ (${moq}). Variant will show as MOQ unmet on wholesale until stock is replenished.`
      });
    } else if (Number.isFinite(qty) && Number.isFinite(moq) && qty <= 0) {
      warnings.push({
        productCode: variant.productCode || null,
        code: 'WHOLESALE_OUT_OF_STOCK',
        message: 'Variant is wholesale-enabled but currently out of stock.'
      });
    }
  }
  return warnings;
}

/**
 * Multi-variant productCode: exactly one hyphen between BASE and numeric suffix.
 *
 * BASE (left of hyphen):
 * - Any non-empty [A-Z0-9]+ as entered after trim + whole-string uppercase only.
 * - Never parsed as a number — leading zeros and length are preserved (0001 ≠ 000001).
 *
 * Suffix (right of hyphen):
 * - Positive integer; only the suffix is canonicalized (leading zeros dropped: …-01 → …-1).
 */
const SUFFIXED_PRODUCT_CODE_REGEX = /^([A-Z0-9]+)-(\d+)$/;

function normalizeProductCode(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return "";
  const m = s.match(SUFFIXED_PRODUCT_CODE_REGEX);
  if (m) {
    const baseToken = m[1];
    const seq = Number(m[2]);
    if (!Number.isFinite(seq)) return s;
    return `${baseToken}-${seq}`;
  }
  return s;
}

/**
 * Legacy DB rows may still store two-digit padding (e.g. 34354-01). Queries must match both forms.
 */
function getProductCodeStorageAliases(value) {
  const canonical = normalizeProductCode(value);
  if (!canonical) return [];
  const out = new Set([canonical]);
  try {
    const p = parseProductCodeParts(canonical, "productCode", { requireSuffix: false });
    if (p.sequence != null && p.sequence >= 1) {
      const padded2 = `${p.base}-${String(p.sequence).padStart(2, "0")}`;
      if (padded2 !== canonical) out.add(padded2);
    }
  } catch {
    // bare code or non-standard — only canonical
  }
  return [...out];
}

/** Value for Mongo filter on variants.productCode (string or { $in: [...] }). */
function productCodeToDbQuery(value) {
  const aliases = getProductCodeStorageAliases(value);
  if (aliases.length === 0) return normalizeProductCode(value);
  if (aliases.length === 1) return aliases[0];
  return { $in: aliases };
}

function normalizeKeyForAliasMatch(key) {
  return String(key || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function getRowFieldByAliases(row, aliases) {
  if (!row || typeof row !== "object") return undefined;
  const aliasSet = new Set((aliases || []).map((a) => normalizeKeyForAliasMatch(a)));
  for (const key of Object.keys(row)) {
    if (aliasSet.has(normalizeKeyForAliasMatch(key))) {
      return row[key];
    }
  }
  return undefined;
}

/**
 * Backward-compatible mapping for productCode column names coming from CSV/Excel.
 * Supports common variants/typos used by different sheets.
 */
function normalizeBulkImportRow(row) {
  if (!row || typeof row !== "object") return row;
  const rawProductCode = getRowFieldByAliases(row, [
    "productCode",
    "productcode",
  ]);
  if (rawProductCode != null && String(rawProductCode).trim() !== "") {
    row.productCode = String(rawProductCode).trim();
  }
  return row;
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BARE_PRODUCT_CODE_REGEX = /^[A-Z0-9]+$/;

function parseProductCodeParts(productCode, contextLabel = 'productCode', { requireSuffix = false } = {}) {
  const normalized = normalizeProductCode(productCode);
  const match = normalized.match(SUFFIXED_PRODUCT_CODE_REGEX);
  if (match) {
    const seq = Number(match[2]);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(
        `${contextLabel}: invalid productCode "${normalized}". Multi-variant suffix must be a whole number starting at 1.`
      );
    }
    return {
      normalized,
      /** Literal BASE token; not numeric-coerced (leading zeros preserved). */
      base: match[1],
      sequence: seq
    };
  }

  if (BARE_PRODUCT_CODE_REGEX.test(normalized)) {
    if (requireSuffix) {
      throw new Error(`${contextLabel}: "${normalized}" must use BASE-N format (example: 4321-1)`);
    }
    return {
      normalized,
      base: normalized,
      sequence: null
    };
  }

  throw new Error(
    `${contextLabel}: invalid productCode "${normalized}". Use BASE (single variant) or BASE-N (multi-variant, e.g. 4321-1).`
  );
}

/**
 * Multipart / legacy clients may send productCode or ProductCode on each variant object.
 * @returns {string} trimmed raw code or empty string
 */
function getIncomingVariantProductCode(variant) {
  if (!variant || typeof variant !== 'object') return '';
  const raw =
    variant.productCode !== undefined && variant.productCode !== null
      ? variant.productCode
      : variant.ProductCode;
  return String(raw ?? '').trim();
}

function assertVariantCodeSeries(codes, contextLabel = 'variants') {
  if (!Array.isArray(codes) || codes.length === 0) return;
  if (codes.length === 1) {
    const first = parseProductCodeParts(codes[0], `${contextLabel}[0] productCode`, { requireSuffix: true });
    if (first.sequence !== 1) {
      throw new Error(
        `First productCode for ${contextLabel} must be ${first.base}-1. Received ${first.normalized}.`
      );
    }
    return;
  }

  const parsed = codes.map((c, idx) =>
    parseProductCodeParts(c, `${contextLabel}[${idx}] productCode`, { requireSuffix: true })
  );
  const base = parsed[0].base;
  const seen = new Set();
  const sequences = [];

  for (const p of parsed) {
    if (p.base !== base) {
      throw new Error(`All ${contextLabel} productCodes must share same base. Expected ${base}-N, got ${p.normalized}`);
    }
    if (seen.has(p.normalized)) {
      throw new Error(`Duplicate productCode in ${contextLabel}: ${p.normalized}`);
    }
    seen.add(p.normalized);
    sequences.push(p.sequence);
  }

  sequences.sort((a, b) => a - b);
  for (let i = 0; i < sequences.length; i++) {
    const expected = i + 1;
    if (sequences[i] !== expected) {
      throw new Error(
        `productCode sequence must be continuous from 1 to ${codes.length} for ${contextLabel}`
      );
    }
  }
}

function deriveSequenceNumberFromParsedCode(parsedCode) {
  return parsedCode.sequence == null ? 1 : parsedCode.sequence;
}

function formatSequenceSuffix(n) {
  return String(n);
}

function alignIncomingCodeWithExistingSeries(rawCode, existingCodes = []) {
  const normalized = normalizeProductCode(rawCode);
  if (!normalized) return normalized;

  let incoming;
  try {
    incoming = parseProductCodeParts(normalized, "incoming productCode");
  } catch {
    return normalized;
  }
  if (incoming.sequence != null) return incoming.normalized;

  const parsedExisting = (Array.isArray(existingCodes) ? existingCodes : [])
    .map((c) => normalizeProductCode(c))
    .filter(Boolean)
    .map((c) => {
      try {
        return parseProductCodeParts(c, "existing productCode");
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const sameBase = parsedExisting.filter((p) => p.base === incoming.base);
  const hasSuffixedSeries = sameBase.some((p) => p.sequence != null);
  if (hasSuffixedSeries) {
    return `${incoming.base}-${formatSequenceSuffix(1)}`;
  }
  return incoming.normalized;
}

function alignIncomingRowsWithExistingSeries(productRows, existingCodes = []) {
  if (!Array.isArray(productRows)) return;
  // Strict mode for bulk flows: do not auto-adjust productCode formats.
  // We preserve user-entered values and let strict validation return actionable errors.
  for (const row of productRows) {
    const before = normalizeProductCode(row?.productCode);
    if (!before) continue;
    row.productCode = before;
  }
}

function suggestNextVariantCodeForProduct(productDoc, incomingCode) {
  if (!productDoc || !Array.isArray(productDoc.variants)) return null;
  const normalizedIncoming = normalizeProductCode(incomingCode);
  if (!normalizedIncoming) return null;

  let incomingParts;
  try {
    incomingParts = parseProductCodeParts(normalizedIncoming, "incoming productCode");
  } catch {
    return null;
  }

  const existingCodes = productDoc.variants
    .map((v) => normalizeProductCode(v?.productCode))
    .filter(Boolean);
  if (existingCodes.length === 0) {
    return `${incomingParts.base}-${formatSequenceSuffix(1)}`;
  }

  const alignedIncoming = alignIncomingCodeWithExistingSeries(normalizedIncoming, existingCodes);
  let alignedParts;
  try {
    alignedParts = parseProductCodeParts(alignedIncoming, "aligned productCode");
  } catch {
    return null;
  }

  const sameBase = existingCodes
    .map((code) => {
      try {
        return parseProductCodeParts(code, "existing productCode");
      } catch {
        return null;
      }
    })
    .filter((p) => p && p.base === alignedParts.base);

  if (sameBase.length === 0) return `${alignedParts.base}-${formatSequenceSuffix(1)}`;
  const hasSuffixed = sameBase.some((p) => p.sequence != null);
  if (!hasSuffixed) {
    return `${alignedParts.base}-${formatSequenceSuffix(1)}`;
  }
  const maxSeq = Math.max(...sameBase.map((p) => deriveSequenceNumberFromParsedCode(p)));
  return `${alignedParts.base}-${formatSequenceSuffix(maxSeq + 1)}`;
}

function createNextVariantCodeSuggester(productDoc) {
  const existingCodes = Array.isArray(productDoc?.variants)
    ? productDoc.variants.map((v) => normalizeProductCode(v?.productCode)).filter(Boolean)
    : [];
  const reserved = new Set(existingCodes);

  return (incomingCode) => {
    const syntheticProduct = {
      variants: [...reserved].map((code) => ({ productCode: code }))
    };
    const suggested = suggestNextVariantCodeForProduct(syntheticProduct, incomingCode);
    if (suggested) reserved.add(normalizeProductCode(suggested));
    return suggested;
  };
}

function getExistingSeriesInfo(productDoc, incomingCode) {
  const existingCodes = Array.isArray(productDoc?.variants)
    ? productDoc.variants.map((v) => normalizeProductCode(v?.productCode)).filter(Boolean)
    : [];
  if (!existingCodes.length) return null;
  const aligned = alignIncomingCodeWithExistingSeries(incomingCode, existingCodes);
  let parts;
  try {
    parts = parseProductCodeParts(aligned, "incoming productCode");
  } catch {
    return null;
  }
  const sameBase = existingCodes
    .map((code) => {
      try {
        return parseProductCodeParts(code, "existing productCode");
      } catch {
        return null;
      }
    })
    .filter((p) => p && p.base === parts.base);
  if (!sameBase.length) return null;
  const hasSuffixed = sameBase.some((p) => p.sequence != null);
  const maxSeq = hasSuffixed
    ? Math.max(...sameBase.map((p) => deriveSequenceNumberFromParsedCode(p)))
    : 1;
  const lastCode = hasSuffixed
    ? `${parts.base}-${formatSequenceSuffix(maxSeq)}`
    : parts.base;
  const nextCode = hasSuffixed
    ? `${parts.base}-${formatSequenceSuffix(maxSeq + 1)}`
    : `${parts.base}-${formatSequenceSuffix(1)}`;
  return {
    base: parts.base,
    maxSeq,
    hasSuffixed,
    lastCode,
    nextCode
  };
}

function getProductCodeFolderLookupKeys(val) {
  const keys = [];
  const pushUnique = (k) => {
    if (k && !keys.includes(k)) keys.push(k);
  };
  const canonical = normalizeProductCode(val);
  if (!canonical) return keys;
  pushUnique(canonical);
  try {
    const p = parseProductCodeParts(canonical, "folder", { requireSuffix: false });
    if (p.sequence != null && p.sequence >= 1) {
      const padded2 = `${p.base}-${String(p.sequence).padStart(2, "0")}`;
      pushUnique(padded2);
    }
  } catch {
    // bare code: folder name is usually the bare token only
  }
  return keys;
}

function getImageFolderCandidatesForRow(row) {
  const candidates = [];
  const addVal = (val) => {
    for (const k of getProductCodeFolderLookupKeys(val)) {
      if (k && !candidates.includes(k)) candidates.push(k);
    }
  };
  addVal(row?.productCode);
  addVal(row?._productCodeAdjustedFrom);
  return candidates;
}

/**
 * OS-level junk that gets bundled into zips on macOS/Windows. These entries
 * must be ignored when deciding whether a zip is "wrapped" in a single folder
 * or counted as real product folders.
 *
 * Examples we routinely see in production:
 *   - __MACOSX/        (macOS resource forks)
 *   - .DS_Store        (macOS Finder metadata)
 *   - Thumbs.db        (Windows Explorer thumbnails)
 *   - desktop.ini      (Windows folder customization)
 *   - ._something      (macOS AppleDouble companion files)
 */
const ZIP_OS_JUNK_NAMES = new Set([
  '__MACOSX',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.localized'
]);

function isOsJunkEntryName(name) {
  if (!name || typeof name !== 'string') return true;
  if (ZIP_OS_JUNK_NAMES.has(name)) return true;
  // Mac AppleDouble companions ("._filename")
  if (name.startsWith('._')) return true;
  // Generic hidden files (.git, .gitignore, .hidden, etc.) — never product folders.
  if (name.startsWith('.')) return true;
  return false;
}

/**
 * Safely list real (non-junk) directory entries. Returns [] on any I/O error.
 * Uses withFileTypes to avoid an extra statSync round-trip per entry.
 */
function listRealEntries(dirPath) {
  if (!dirPath) return [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries.filter((e) => !isOsJunkEntryName(e.name));
}

/**
 * Resolve the "real" content root of an extracted zip.
 *
 * Many archives wrap content in a single top-level folder (e.g. `imgz.zip`
 * extracts to `imgz/<product-code>/...`). Some users zip with a deeper nesting
 * (e.g. `imgz/inner/<product-code>/...`). And many archives include OS junk
 * (`__MACOSX/`, `.DS_Store`) at the root that breaks naive "single child"
 * detection.
 *
 * Strategy: starting at `extractPath`, while the only real child is a single
 * directory, descend into it. Stop at the first directory that contains either
 *   - multiple real entries, or
 *   - one entry that is not a directory (i.e. actual content files), or
 *   - nothing at all,
 * and treat that level as the content root. Capped at `maxDepth` for safety.
 */
function resolveZipContentRoot(extractPath, { maxDepth = 5 } = {}) {
  if (!extractPath) return extractPath;
  let current = extractPath;
  for (let depth = 0; depth < maxDepth; depth++) {
    const entries = listRealEntries(current);
    if (entries.length === 1 && entries[0].isDirectory()) {
      current = path.join(current, entries[0].name);
      continue;
    }
    break;
  }
  return current;
}

/**
 * Resolve the product-image folder inside an extracted zip root.
 *
 * Match precedence:
 *   1. Exact case-sensitive match against the supplied candidates.
 *   2. Case-insensitive match (handles zips authored on case-insensitive
 *      filesystems — Windows/macOS — then deployed on Linux servers where
 *      directory names are case-sensitive).
 *
 * OS junk entries are ignored when scanning. Returns the matched folder path
 * plus the exact on-disk folder name that matched (used for downstream logs
 * and bookkeeping).
 */
function resolveImageFolderByCandidates(rootFolder, candidates = []) {
  if (!rootFolder || !Array.isArray(candidates) || candidates.length === 0) {
    return { folderPath: null, matchedCode: null };
  }

  // Fast path — exact case match.
  for (const code of candidates) {
    if (!code) continue;
    const dir = path.join(rootFolder, String(code));
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return { folderPath: dir, matchedCode: String(code) };
      }
    } catch {
      // ignore and continue to fallback
    }
  }

  // Fallback — case-insensitive directory scan.
  const realDirsByLower = new Map();
  for (const entry of listRealEntries(rootFolder)) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    // First writer wins; preserve the on-disk casing.
    if (!realDirsByLower.has(lower)) realDirsByLower.set(lower, entry.name);
  }
  for (const code of candidates) {
    if (!code) continue;
    const found = realDirsByLower.get(String(code).toLowerCase());
    if (found) {
      return { folderPath: path.join(rootFolder, found), matchedCode: found };
    }
  }

  return { folderPath: null, matchedCode: null };
}

/**
 * Build a human-readable, length-capped sample of real subdirectories under
 * `rootFolder`. Used only for error diagnostics so users can see exactly what
 * the server "sees" inside their uploaded zip.
 */
function describeAvailableImageFolders(rootFolder, sampleSize = 8) {
  const names = listRealEntries(rootFolder)
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  if (names.length === 0) return 'none';
  const head = names.slice(0, sampleSize).join(', ');
  return names.length > sampleSize
    ? `${head} (+${names.length - sampleSize} more)`
    : head;
}

/**
 * Bulk imports are incremental; validate series against DB + incoming rows.
 * - Existing + incoming codes are treated as one timeline.
 * - Same code repeated between DB and incoming is tolerated for series calculation
 *   (actual duplicate handling happens separately as skip/warning logic).
 */
function assertBulkSeriesAgainstExisting({
  incomingCodes,
  existingCodes = [],
  contextLabel = 'variants'
}) {
  const incomingNormalized = (Array.isArray(incomingCodes) ? incomingCodes : [])
    .map((c) => normalizeProductCode(c))
    .filter(Boolean);
  if (incomingNormalized.length === 0) {
    return { base: null, nextSuggestedProductCode: null };
  }

  const existingNormalized = (Array.isArray(existingCodes) ? existingCodes : [])
    .map((c) => normalizeProductCode(c))
    .filter(Boolean);

  const parsedIncoming = incomingNormalized.map((c, idx) =>
    parseProductCodeParts(c, `${contextLabel}[incoming ${idx}] productCode`, { requireSuffix: true })
  );
  const parsedExisting = existingNormalized.map((c, idx) =>
    parseProductCodeParts(c, `${contextLabel}[existing ${idx}] productCode`)
  );

  const combined = [...parsedExisting, ...parsedIncoming];
  const base = combined[0].base;
  for (const p of combined) {
    if (p.base !== base) {
      throw new Error(
        `All ${contextLabel} productCodes must share same base. Expected ${base}-N, got ${p.normalized}`
      );
    }
  }

  const dedupByCode = new Map();
  for (const p of combined) {
    if (!dedupByCode.has(p.normalized)) {
      dedupByCode.set(p.normalized, p);
    }
  }

  const sequenceToParsed = new Map();
  for (const p of dedupByCode.values()) {
    const seq = deriveSequenceNumberFromParsedCode(p);
    if (sequenceToParsed.has(seq)) {
      const prev = sequenceToParsed.get(seq);
      const isToleratedBaseVs01 =
        seq === 1 &&
        ((prev.sequence == null && p.sequence === 1) ||
          (prev.sequence === 1 && p.sequence == null));
      if (!isToleratedBaseVs01) {
        throw new Error(
          `${contextLabel}: conflicting productCodes detected around ${base}-${formatSequenceSuffix(seq)} (example: using both "${base}" and "${base}-1"). Use one consistent series format.`
        );
      }
      continue;
    }
    sequenceToParsed.set(seq, p);
  }

  const seenSequence = new Set(sequenceToParsed.keys());
  const sortedSeq = [...seenSequence].sort((a, b) => a - b);
  const maxSeq = sortedSeq[sortedSeq.length - 1];

  const hasBareCode = [...dedupByCode.values()].some((p) => p.sequence == null);
  const hasExplicit01 = [...dedupByCode.values()].some((p) => p.sequence === 1);
  if (hasBareCode && maxSeq > 1 && !hasExplicit01) {
    throw new Error(
      `${contextLabel}: ${base} exists as a bare productCode, but suffixed variants are being added without ${base}-1. Use ${base}-1 before ${base}-${formatSequenceSuffix(maxSeq)}.`
    );
  }

  for (let expected = 1; expected <= maxSeq; expected++) {
    if (!seenSequence.has(expected)) {
      throw new Error(
        `productCode sequence for ${contextLabel} must be continuous when combined with existing variants. Missing ${base}-${formatSequenceSuffix(expected)}.`
      );
    }
  }

  return {
    base,
    nextSuggestedProductCode: `${base}-${formatSequenceSuffix(maxSeq + 1)}`
  };
}

/** CSV bulk: normalize and keep user-entered productCodes as-is (no forced suffix). */
function normalizeBareProductCodesForBulkGroup(productRows) {
  if (!Array.isArray(productRows)) return;
  for (const row of productRows) {
    if (row.productCode != null) {
      row.productCode = normalizeProductCode(row.productCode);
    }
  }
}

function sanitizeBaseToken(rawBase) {
  const cleaned = String(rawBase || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned || null;
}

async function ensureMissingVariantProductCodes(productDoc, preferredBase) {
  if (!productDoc || !Array.isArray(productDoc.variants) || productDoc.variants.length === 0) {
    return 0;
  }

  const usedCodes = new Set();
  const usedSequences = new Set();
  const parsedExisting = [];

  for (const v of productDoc.variants) {
    const code = normalizeProductCode(v?.productCode);
    if (!code) continue;
    usedCodes.add(code);
    try {
      const parsed = parseProductCodeParts(code, "existing variant productCode");
      parsedExisting.push(parsed);
    } catch {
      // ignore invalid legacy values here; they will fail normal validators later.
    }
  }

  const base =
    sanitizeBaseToken(preferredBase) ||
    sanitizeBaseToken(parsedExisting[0]?.base) ||
    sanitizeBaseToken(String(productDoc.name || "").slice(0, 12)) ||
    `PROD${String(productDoc._id || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-6) || "LEGACY"}`;

  for (const p of parsedExisting) {
    if (p.base === base) {
      usedSequences.add(deriveSequenceNumberFromParsedCode(p));
    }
  }

  let changed = 0;
  for (const v of productDoc.variants) {
    const hasCode = normalizeProductCode(v?.productCode);
    if (hasCode) continue;

    let seq = 1;
    while (usedSequences.has(seq) || usedCodes.has(`${base}-${formatSequenceSuffix(seq)}`)) {
      seq += 1;
    }
    const generated = `${base}-${formatSequenceSuffix(seq)}`;
    v.productCode = generated;
    usedCodes.add(generated);
    usedSequences.add(seq);
    changed += 1;
  }

  if (changed > 0) {
    productDoc.markModified("variants");
  }
  return changed;
}

async function findExistingProductByProductCode(rawCode) {
  const normalized = normalizeProductCode(rawCode);
  if (!normalized) return null;
  return Product.findOne({ "variants.productCode": productCodeToDbQuery(normalized) }).select(
    "name slug variants.productCode"
  );
}



// Create new product
const createProduct = async (req, res) => {
  try {
    const {
      name,
      title,
      description,
      category,
      brand,
      status,
      isFeatured,
      soldInfo,
      fomo,
      shipping,
      attributes,
      variants: variantsRaw,
      hsnCode,
      gstRate,
      isFragile
    } = req.body;

    if (!name || !title || !category || !description) {
      return res.status(400).json({
        success: false,
        message: "Name, title, category and description are required"
      });
    }

    if (!mongoose.Types.ObjectId.isValid(category)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID format"
      });
    }

    const existingCategory = await Category.findById(category);
    if (!existingCategory) {
      return res.status(400).json({
        success: false,
        message: "Selected category does not exist."
      });
    }

    // If product already exists (same name), do not create duplicate; return existing variant codes.
    const existingProductByName = await Product.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(String(name).trim())}$`, 'i') }
    }).select('name slug variants.productCode');
    if (existingProductByName) {
      return res.status(409).json({
        success: false,
        message: "Product already exists with these variants",
        product: {
          name: existingProductByName.name,
          slug: existingProductByName.slug
        },
        existingVariantProductCodes: (existingProductByName.variants || [])
          .map((v) => normalizeProductCode(v.productCode))
          .filter(Boolean)
      });
    }

    let variantsInput = variantsRaw;
    if (typeof variantsRaw === "string") {
      try {
        variantsInput = JSON.parse(variantsRaw);
      } catch {
        return res.status(400).json({
          success: false,
          code: "VARIANTS_JSON_INVALID",
          message: "Invalid JSON in variants field"
        });
      }
    }

    if (!Array.isArray(variantsInput) || variantsInput.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one variant is required"
      });
    }

    // Validate productCode format + series before uploads. Same rules as addVariant: BASE-N (suffix ≥ 1),
    // shared base, continuous 01..N. Accept productCode or ProductCode on each row.
    const normalizedCodes = [];
    for (let i = 0; i < variantsInput.length; i++) {
      const codeRaw = getIncomingVariantProductCode(variantsInput[i]);
      if (!codeRaw) {
        return res.status(400).json({
          success: false,
          code: "PRODUCT_CODE_REQUIRED",
          message: `productCode is required for variant ${i}`
        });
      }
      try {
        const parsed = parseProductCodeParts(codeRaw, `variant ${i} productCode`, { requireSuffix: true });
        normalizedCodes.push(parsed.normalized);
        variantsInput[i].productCode = parsed.normalized;
        if (Object.prototype.hasOwnProperty.call(variantsInput[i], "ProductCode")) {
          delete variantsInput[i].ProductCode;
        }
      } catch (err) {
        return res.status(400).json({
          success: false,
          code: "PRODUCT_CODE_INVALID",
          message: err.message || "Invalid productCode"
        });
      }
    }

    try {
      assertVariantCodeSeries(normalizedCodes, 'createProduct variants');
    } catch (err) {
      return res.status(400).json({
        success: false,
        code: "PRODUCT_CODE_SERIES_INVALID",
        message: err.message || "Invalid productCode series for create"
      });
    }

    // Global uniqueness: no two variants across products can share productCode
    for (const code of normalizedCodes) {
      const existingproductCode = await Product.findOne({ "variants.productCode": productCodeToDbQuery(code) }).select('_id name');
      if (existingproductCode) {
        return res.status(400).json({
          success: false,
          message: `productCode ${code} already exists in product "${existingproductCode.name}"`
        });
      }
    }

    const slug = await generateSlug(name);
    const variants = [];
    const filesByVariant = {};

    // =============================
    // Group variant images
    // =============================
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const match = file.fieldname.match(/^variantImages_(\d+)$/);
        if (match) {
          const index = Number(match[1]);
          if (!filesByVariant[index]) filesByVariant[index] = [];
          filesByVariant[index].push(file);
        }
      }
    }

    for (const idxStr of Object.keys(filesByVariant)) {
      const idx = Number(idxStr);
      if (filesByVariant[idx].length > 5) {
        return res.status(400).json({
          success: false,
          message: `Variant ${idx} can have at most 5 images`
        });
      }
    }

    // =============================
    // PROCESS EACH VARIANT
    // =============================
    for (let i = 0; i < variantsInput.length; i++) {
      const v = variantsInput[i];

      const productCode = normalizeProductCode(v.productCode);

      // AUTO GENERATE SKU
      const skuVal = await generateSku();

      // Wholesale flag
      const wholesale = !!v.wholesale;

      // Price object
      const priceObj = {
        base: Number(v.price?.base) || 0,
        sale: v.price?.sale != null ? Number(v.price.sale) : null,
        wholesaleBase: wholesale ? Number(v.price?.wholesaleBase) : undefined,
        wholesaleSale: wholesale ? (v.price?.wholesaleSale != null ? Number(v.price.wholesaleSale) : null) : undefined
      };

      if (priceObj.sale != null && priceObj.sale >= priceObj.base) {
        return res.status(400).json({
          success: false,
          message: `Sale price must be less than base price for variant ${i}`
        });
      }

      if (wholesale && priceObj.wholesaleSale != null && priceObj.wholesaleSale >= priceObj.wholesaleBase) {
        return res.status(400).json({
          success: false,
          message: `Wholesale sale price must be less than wholesale base price for variant ${i}`
        });
      }

      // MOQ logic
      let moq = 1;
      if (wholesale) {
        if (!v.minimumOrderQuantity || v.minimumOrderQuantity < 1) {
          return res.status(400).json({
            success: false,
            message: `Minimum order quantity is required and must be at least 1 for wholesale variant ${i}`
          });
        }
        moq = Number(v.minimumOrderQuantity);
      }

      const inventoryObj = {
        quantity: Number(v.inventory?.quantity) || 0,
        trackInventory: v.inventory?.trackInventory !== false,
        lowStockThreshold: v.inventory?.lowStockThreshold || 5
      };

      const variantImages = [];

      // =============================
      // Upload Variant Images
      // =============================
      if (filesByVariant[i]) {
        for (let imgIndex = 0; imgIndex < filesByVariant[i].length; imgIndex++) {
          const file = filesByVariant[i][imgIndex];

          const optimizedBuffer = await optimizeProductImageBuffer(file.buffer);

          const publicIdName = `${slug}_${skuVal}_img${imgIndex + 1}_${Date.now()}`;

          const { url, publicId } = await uploadToCloudinary(
            optimizedBuffer,
            `products/${slug}`,
            publicIdName
          );

          variantImages.push({
            url,
            publicId,
            altText: `${name} ${skuVal} image ${imgIndex + 1}`,
            order: imgIndex
          });
        }
      }

      const isActiveFlag = v.isActive !== false;
      const wholesaleEligible = wholesale && Number(priceObj.wholesaleBase) > 0;
      const variantDoc = {
        sku: skuVal,
        productCode,
        wholesale,
        attributes: Array.isArray(v.attributes)
          ? v.attributes.map(a => ({ key: a.key, value: a.value }))
          : [],
        price: priceObj,
        minimumOrderQuantity: moq,
        inventory: inventoryObj,
        images: variantImages,
        isActive: isActiveFlag,
        channelVisibility: deriveVariantChannelVisibilityFromLegacy(
          isActiveFlag,
          v.channelVisibility,
          { isWholesaleEligible: wholesaleEligible }
        )
      };
      if (i === 0) {
        applyVariantCatalogFieldsToTarget(variantDoc, {}, { isPrimary: true });
      } else {
        applyVariantCatalogFieldsToTarget(variantDoc, {
          title: v.title,
          description: v.description,
          shipping: v.shipping
        });
      }
      variants.push(variantDoc);
    }

    // =============================
    // Parse Optional JSON Fields
    // =============================
    let parsedSoldInfo = soldInfo;
    let parsedFomo = fomo;
    let parsedShipping = shipping;
    let parsedAttributes = attributes;

    try {
      if (typeof soldInfo === "string") parsedSoldInfo = JSON.parse(soldInfo);
      if (typeof fomo === "string") parsedFomo = JSON.parse(fomo);
      if (typeof shipping === "string") parsedShipping = JSON.parse(shipping);
      if (typeof attributes === "string") parsedAttributes = JSON.parse(attributes);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON format in request body"
      });
    }

    const shippingValidation = validateRequiredShippingFields(parsedShipping);
    if (!shippingValidation.valid) {
      return res.status(400).json({
        success: false,
        code: "SHIPPING_FIELDS_REQUIRED",
        message: shippingValidation.message
      });
    }
    const normalizedShipping = shippingValidation.shipping;

    const variantsShippingCheck = validateVariantsResolvableShipping(normalizedShipping, variants);
    if (!variantsShippingCheck.valid) {
      return res.status(400).json({
        success: false,
        code: "VARIANT_SHIPPING_REQUIRED",
        message: variantsShippingCheck.message
      });
    }

    // =============================
    //  VALIDATE HSN CODE (Optional)
    // =============================
    let finalHsnCode = null;
    if (hsnCode && hsnCode.trim()) {
      finalHsnCode = hsnCode.trim().toUpperCase();
      if (finalHsnCode.length > 20) {
        return res.status(400).json({
          success: false,
          message: "HSN code cannot exceed 20 characters"
        });
      }
    }

    // =============================
    //  VALIDATE TAX RATE (Optional - no default)
    // =============================
    let finalgstRate = null;
    if (gstRate !== undefined && gstRate !== null) {
      const parsedgstRate = Number(gstRate);
      if (isNaN(parsedgstRate) || parsedgstRate < 0) {
        return res.status(400).json({
          success: false,
          message: "Tax rate must be a valid number greater than or equal to 0"
        });
      }
      finalgstRate = parsedgstRate;
    }
    //  No default value - if not provided, stays null

    // =============================
    //  FRAGILE FLAG (Boolean)
    // =============================
    const finalIsFragile = isFragile === true || isFragile === "true";

    const resolvedStatus =
      status && ["draft", "active", "archived"].includes(String(status).toLowerCase())
        ? String(status).toLowerCase()
        : "draft";
    const channelStatus = deriveProductChannelStatusFromLegacy(
      resolvedStatus,
      req.body.channelStatus
    );

    // =============================
    //  CREATE PRODUCT
    // =============================
    const product = new Product({
      name,
      slug,
      title,
      description: description || "",
      category: existingCategory._id,
      brand: brand || "Generic",
      status: resolvedStatus,
      channelStatus,
      isFeatured,
      soldInfo: parsedSoldInfo || { enabled: false, count: 0 },
      fomo: parsedFomo || { enabled: false, type: "viewing_now", viewingNow: 0 },
      shipping: normalizedShipping,
      attributes: parsedAttributes || [],
      variants,
      price: {
        base: Number(req.body.price?.base) || 0,
        sale: req.body.price?.sale != null ? Number(req.body.price.sale) : null,
        wholesaleBase: Number(req.body.price?.wholesaleBase) || 0,
        wholesaleSale: req.body.price?.wholesaleSale != null ? Number(req.body.price.wholesaleSale) : null
      },
      minimumOrderQuantity: Number(req.body.minimumOrderQuantity) || 1,
      isVisibleToRetail: req.body.isVisibleToRetail || false,
      isVisibleToWholesale: req.body.isVisibleToWholesale || false,
      
      //  NEW FIELDS (NO DEFAULTS)
      hsnCode: finalHsnCode,
      gstRate: finalgstRate,
      isFragile: finalIsFragile
    });

    if (
      product.channelStatus?.wholesale === "active" &&
      !hasWholesalePricingEligibleVariant(product)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot enable wholesale storefront: no variant has wholesale=true and wholesaleBase > 0. Update at least one variant first."
      });
    }

    // =============================
    //  AUTO-GENERATE SEO DATA
    // =============================
    const categoryForSEO = existingCategory ? { name: existingCategory.name } : null;

    const seoData = generateSEOData({
        name: product.name,
        description: product.description,
        category: categoryForSEO,
        variants: product.variants
    });

    product.seo = seoData;

    await product.save();
    const warnings = collectWholesaleInventoryWarnings(product.variants);

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
      categoryDetails: existingCategory.name,
      warnings
    });

  } catch (error) {
    console.error("Create product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error creating product",
      error: error.message
    });
  }
};


//Bulk upload from CSV (with image URLs)
const importProductsFromCSV = async (req, res) => {
  let filePath = null;
  const BATCH_SIZE = 50;
  
  // Track overall stats
  const stats = {
    totalRows: 0,
    uniqueProducts: 0,
    inserted: 0,
    updated: 0,
    failed: [],
    skipped: []
  };
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const absolutePath = path.resolve(req.file.path);
    filePath = absolutePath;
    
    console.log(`📁 CSV file at: ${absolutePath}`);

    if (!fs.existsSync(absolutePath)) {
      return res.status(400).json({
        success: false,
        message: "Uploaded file not found",
      });
    }

    // =============================================
    // STEP 1: Read and validate CSV
    // =============================================
    const rows = [];
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }));
      
      stream.on("data", (row) => rows.push(normalizeBulkImportRow(row)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    
    stats.totalRows = rows.length;
    console.log(`📊 Total rows in CSV: ${stats.totalRows}`);
    
    // =============================================
    // STEP 2: Validate CSV structure
    // =============================================
    const requiredColumns = ['name', 'category', 'basePrice'];
    const firstRow = rows[0];
    const missingColumns = requiredColumns.filter(col => !firstRow.hasOwnProperty(col));
    
    if (missingColumns.length > 0) {
      // Cleanup file
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        message: `Missing required columns: ${missingColumns.join(', ')}`,
        requiredColumns
      });
    }
    
    // =============================================
    // STEP 3: Group rows by product name
    // =============================================
    const productMap = new Map();
    
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      
      // Trim all values
      Object.keys(row).forEach((key) => {
        if (typeof row[key] === "string") {
          row[key] = row[key].trim();
        }
      });
      normalizeBulkImportRow(row);
      
      const productName = row.name;
      if (!productName) {
        stats.failed.push({
          product: "Unknown",
          reason: "Product name is missing",
          rowNumber: idx + 2
        });
        continue;
      }
      
      const key = productName.toLowerCase();
      
      if (!productMap.has(key)) {
        productMap.set(key, {
          name: productName,
          rows: [],
          originalIndex: idx
        });
      }
      productMap.get(key).rows.push({ ...row, rowNumber: idx + 2 });
    }
    
    stats.uniqueProducts = productMap.size;
    console.log(`📦 Unique products: ${stats.uniqueProducts}`);

    // =============================================
    // STEP 3.5: Pre-validate productCode series (same behavior as ZIP bulk flow)
    // =============================================
    for (const [, productData] of productMap) {
      const productRows = productData.rows || [];
      normalizeBareProductCodesForBulkGroup(productRows);

      const existingProduct = await Product.findOne({
        name: { $regex: new RegExp(`^${escapeRegex(String(productData.name || '').trim())}$`, 'i') }
      }).select('variants.productCode');

      alignIncomingRowsWithExistingSeries(
        productRows,
        (existingProduct?.variants || []).map((v) => v.productCode)
      );

      const codes = productRows.map((r) => normalizeProductCode(r.productCode)).filter(Boolean);
      if (codes.length === 0) continue;

      try {
        assertBulkSeriesAgainstExisting({
          incomingCodes: codes,
          existingCodes: (existingProduct?.variants || []).map((v) => v.productCode),
          contextLabel: `CSV import product "${productData.name}"`
        });
      } catch (err) {
        const isNewProduct = !existingProduct;
        let msg = err.message;
        if (isNewProduct) {
          const sampleCode = codes[0];
          try {
            const parsed = parseProductCodeParts(sampleCode, "productCode");
            if (parsed.sequence != null && parsed.sequence > 1) {
              msg = `${msg} This looks like a new product; start from ${parsed.base} or ${parsed.base}-1.`;
            }
          } catch {
            // keep original message
          }
        }
        for (const row of productRows) {
          row._preValidationError = msg;
        }
      }
    }
    
    // =============================================
    // STEP 4: Process products (SYNCHRONOUSLY)
    // =============================================
    let batchNumber = 0;
    let currentBatch = [];
    
    const productsArray = Array.from(productMap.values());
    
    for (let i = 0; i < productsArray.length; i++) {
      const { name: productName, rows: productRows } = productsArray[i];
      
      try {
        const preValidationError = productRows.find((r) => r._preValidationError)?._preValidationError;
        if (preValidationError) {
          stats.failed.push({
            product: productName,
            reason: preValidationError,
            rows: productRows.map(r => r.rowNumber)
          });
          const progress = ((i + 1) / productsArray.length * 100).toFixed(2);
          console.log(`📈 Progress: ${progress}% | Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed.length}`);
          continue;
        }
        // Process single product with all its variants
        const result = await processProductWithRollback(productName, productRows, stats);
        
        if (result.success) {
          if (result.action === 'inserted') {
            stats.inserted++;
          } else if (result.action === 'updated') {
            stats.updated++;
          }
          currentBatch.push(result.product);
        } else {
          stats.failed.push({
            product: productName,
            reason: result.error,
            rows: productRows.map(r => r.rowNumber)
          });
        }
        
        // Insert batch when full
        if (currentBatch.length >= BATCH_SIZE) {
          batchNumber++;
          await flushBatch(currentBatch, batchNumber, stats);
          currentBatch = [];
        }
        
        const progress = ((i + 1) / productsArray.length * 100).toFixed(2);
        console.log(`📈 Progress: ${progress}% | Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed.length}`);
        
      } catch (productError) {
        console.error(`❌ Error processing ${productName}:`, productError.message);
        stats.failed.push({
          product: productName,
          reason: productError.message,
          rows: productRows.map(r => r.rowNumber)
        });
      }
    }
    
    // Final batch
    if (currentBatch.length > 0) {
      batchNumber++;
      await flushBatch(currentBatch, batchNumber, stats);
    }
    
    // =============================================
    // STEP 5: Generate failure report
    // =============================================
    let errorReportUrl = null;
    
    if (stats.failed.length > 0) {
      const report = await generateErrorReport(stats.failed, req);
      errorReportUrl = report.downloadUrl;
      console.log(`📄 Error report ready: ${errorReportUrl}`);
    }
    
    // Cleanup
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // =============================================
    // STEP 6: Send FINAL response with download link
    // =============================================
    console.log(`\n🎉 IMPORT COMPLETED!`);
    console.log(`📊 Summary:`);
    console.log(`   ✅ Inserted: ${stats.inserted}`);
    console.log(`   🔄 Updated: ${stats.updated}`);
    console.log(`   ❌ Failed: ${stats.failed.length}`);
    
    return res.status(200).json({
      success: true,
      message: "Import completed",
      totalRows: stats.totalRows,
      uniqueProducts: stats.uniqueProducts,
      inserted: stats.inserted,
      updated: stats.updated,
      failed: stats.failed.length,
      downloadUrl: errorReportUrl  // ✅ Direct download link in response
    });
    
  } catch (error) {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch(e) {}
    }
    console.error("CSV import error:", error);
    return res.status(500).json({
      success: false,
      message: "CSV import failed",
      error: error.message,
    });
  }
};

// =============================================
// PREVIEW: CSV import (image URLs) — same rules as import-csv, no DB writes / no uploads
// =============================================
function collectImportCsvRowFieldErrors(row, productName) {
  const errors = [];
  const warnings = [];
  const cleanBasePrice = parseFloat(String(row.basePrice || '').replace(/[^0-9.]/g, '') || 0);
  if (isNaN(cleanBasePrice) || cleanBasePrice <= 0) {
    errors.push(`Invalid basePrice: ${row.basePrice}`);
  }
  const cleanSalePrice = row.salePrice
    ? parseFloat(String(row.salePrice).replace(/[^0-9.]/g, ''))
    : null;
  if (cleanSalePrice !== null && (isNaN(cleanSalePrice) || cleanSalePrice <= 0)) {
    errors.push(`Invalid salePrice: ${row.salePrice}`);
  }
  if (
    cleanSalePrice != null &&
    !isNaN(cleanBasePrice) &&
    !isNaN(cleanSalePrice) &&
    cleanSalePrice >= cleanBasePrice
  ) {
    errors.push(`Sale price (${cleanSalePrice}) must be less than base price (${cleanBasePrice})`);
  }

  const wholesale = parseBoolean(row.wholesale);
  if (wholesale) {
    const wholesaleCfg = parseWholesaleConfigForImportRow(row);
    warnings.push(...wholesaleCfg.warnings);
  }

  if (row.productCode != null && String(row.productCode).trim()) {
    try {
      parseProductCodeParts(row.productCode, `Row ${row.rowNumber || '?'}`);
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (row.images && String(row.images).trim()) {
    const urls = row.images.split(',').map((u) => u.trim()).filter(Boolean);
    for (const url of urls) {
      if (!url.startsWith('http') && !url.startsWith('data:image')) {
        warnings.push(`Image entry may be invalid (use http(s) or data:image): ${url.slice(0, 80)}`);
      }
    }
  } else {
    warnings.push('No image URLs in images column (variant will have no images on import)');
  }

  return { errors, warnings };
}

async function validateImportCsvProductGroupPreview(productName, productRows) {
  const productErrors = [];
  const productWarnings = [];
  const variants = [];

  const existingProduct = await Product.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(String(productName).trim())}$`, 'i') }
  }).select('name slug category variants.productCode');

  const firstRow = productRows[0];
  const categoryDoc = await Category.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(String(firstRow.category || '').trim())}$`, 'i') }
  });
  if (!categoryDoc) {
    productErrors.push(`Category not found: ${firstRow.category}`);
  } else if (
    existingProduct &&
    String(existingProduct.category) !== String(categoryDoc._id)
  ) {
    productErrors.push(
      `Category mismatch: CSV has "${firstRow.category}" but this product exists under a different category in DB`
    );
  }

  normalizeBareProductCodesForBulkGroup(productRows);
  alignIncomingRowsWithExistingSeries(
    productRows,
    (existingProduct?.variants || []).map((v) => v.productCode)
  );
  let nextSuggestedProductCode = null;

  const seriesCodes = productRows.map((r) => normalizeProductCode(r.productCode));
  if (seriesCodes.some((c) => !c)) {
    productErrors.push('productCode is required on every variant row');
  } else {
    try {
      const seriesInfo = assertBulkSeriesAgainstExisting({
        incomingCodes: seriesCodes,
        existingCodes: (existingProduct?.variants || []).map((v) => v.productCode),
        contextLabel: `CSV import product "${productName}"`
      });
      nextSuggestedProductCode = seriesInfo.nextSuggestedProductCode;
    } catch (e) {
      productErrors.push(e.message);
    }
  }

  const duplicateproductCodes = new Map();
  const nextCodeForSameProduct = createNextVariantCodeSuggester(existingProduct);
  for (const row of productRows) {
    const variantErrors = [];
    const variantWarnings = [];
    const productCode = normalizeProductCode(row.productCode);
    row.productCode = productCode;

    if (row._productCodeAdjustedFrom) {
      variantWarnings.push(
        `Adjusted productCode ${row._productCodeAdjustedFrom} -> ${productCode} to match existing series format`
      );
    }

    if (!productCode) {
      variantErrors.push('productCode is missing');
    } else if (duplicateproductCodes.has(productCode)) {
      variantErrors.push(
        `Duplicate productCode ${productCode} in same product (row ${duplicateproductCodes.get(productCode)})`
      );
    } else {
      duplicateproductCodes.set(productCode, row.rowNumber);
      if (!existingProduct) {
        try {
          const parsedForNew = parseProductCodeParts(productCode, "productCode");
          if (parsedForNew.sequence != null && parsedForNew.sequence > 1) {
            variantWarnings.push(
              `This looks like a new product, but productCode starts from ${parsedForNew.normalized}. Prefer ${parsedForNew.base} or ${parsedForNew.base}-1 for first variant.`
            );
          }
        } catch {
          // format issues handled elsewhere
        }
      }
      try {
        const existingProductWithCode = await findExistingProductByProductCode(productCode);
        if (existingProductWithCode) {
          if (
            existingProduct &&
            existingProduct._id.toString() === existingProductWithCode._id.toString()
          ) {
            const existsInProduct = existingProduct.variants.some(
              (v) => normalizeProductCode(v.productCode) === productCode
            );
            if (existsInProduct) {
              const suggested = nextCodeForSameProduct(productCode);
              const entered = normalizeProductCode(row._productCodeAdjustedFrom);
              const seriesInfo = getExistingSeriesInfo(existingProduct, productCode);
              variantWarnings.push(
                entered && entered !== productCode
                  ? seriesInfo?.hasSuffixed
                    ? `You entered ${entered}. It maps to existing series code ${productCode}. Variants already exist till ${seriesInfo.lastCode}.`
                    : `You entered ${entered}. It maps to existing code ${productCode}. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code for this product"}.`
                  : seriesInfo?.hasSuffixed
                    ? `productCode ${productCode} already exists on this product. Variants already exist till ${seriesInfo.lastCode}.`
                    : `productCode ${productCode} already exists on this product. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code for this product"}.`
              );
            }
          } else {
            const isExistingSameProductByName =
              existingProduct &&
              String(existingProduct.name || "").trim().toLowerCase() ===
                String(existingProductWithCode.name || "").trim().toLowerCase();
            const sameProductHint = isExistingSameProductByName
              ? ` It looks like this row is for the same product; use next variant code ${suggestNextVariantCodeForProduct(existingProduct, productCode) || "BASE-N"}.`
              : "";
            variantErrors.push(
              `productCode ${productCode} already exists on product "${existingProductWithCode.name}". Please change productCode.${sameProductHint}`
            );
          }
        }
      } catch (_) {
        /* ignore */
      }
    }

    const field = collectImportCsvRowFieldErrors(row, productName);
    variantErrors.push(...field.errors);
    variantWarnings.push(...field.warnings);

    const blockedByProduct = productErrors.length > 0;
    const isValid = !blockedByProduct && variantErrors.length === 0;

    variants.push({
      rowNumber: row.rowNumber,
      productCode: productCode || 'N/A',
      errors: variantErrors,
      warnings: variantWarnings,
      isValid
    });
  }

  const hasErrors =
    productErrors.length > 0 || variants.some((v) => !v.isValid);
  const previewVariantsForStatus = productRows.map((row) => {
    const wholesaleCfg = parseWholesaleConfigForImportRow(row);
    return {
      wholesale: wholesaleCfg.wholesale,
      price: { wholesaleBase: wholesaleCfg.wholesaleBase },
      channelVisibility: buildChannelVisibilityFromCsvRow(row, wholesaleCfg.wholesaleEligible),
      isActive: normalizeLifecycleFromRowStatus(row.status, 'active') === 'active'
    };
  });
  const derivedChannelStatus = deriveProductChannelStatusFromVariants(previewVariantsForStatus);
  const ineligibleWholesaleCount = productRows.filter((row) => {
    const cfg = parseWholesaleConfigForImportRow(row);
    return cfg.wholesale && !cfg.wholesaleEligible;
  }).length;

  if (ineligibleWholesaleCount > 0) {
    productWarnings.push(
      `${ineligibleWholesaleCount} variant(s) are not wholesale-eligible; wholesale visibility will be set to draft for them.`
    );
  }
  if (derivedChannelStatus.wholesale === 'active') {
    productWarnings.push('Product wholesale channel will be active (at least one eligible wholesale variant found).');
  }

  return {
    name: productName,
    category: firstRow?.category,
    brand: firstRow?.brand || 'Generic',
    productErrors,
    variants,
    nextSuggestedProductCode,
    hasErrors,
    productWarnings,
    derivedChannelStatus,
    existingInDb: Boolean(existingProduct),
    existingSlug: existingProduct?.slug || null
  };
}

const previewImportProductsFromCSV = async (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'CSV file is required'
      });
    }

    filePath = path.resolve(req.file.path);
    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ success: false, message: 'Uploaded file not found' });
    }

    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
        .on('data', (row) => rows.push(normalizeBulkImportRow(row)))
        .on('end', resolve)
        .on('error', reject);
    });

    if (!rows.length) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
      return res.status(422).json({ success: false, message: 'CSV file is empty' });
    }

    const requiredColumns = ['name', 'category', 'basePrice'];
    const firstRow = rows[0];
    const missingColumns = requiredColumns.filter((col) => !firstRow.hasOwnProperty(col));
    if (missingColumns.length > 0) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
      return res.status(422).json({
        success: false,
        message: `Missing required columns: ${missingColumns.join(', ')}`,
        missingColumns,
        foundColumns: Object.keys(firstRow)
      });
    }

    const productMap = new Map();
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      Object.keys(row).forEach((key) => {
        if (typeof row[key] === 'string') row[key] = row[key].trim();
      });
      normalizeBulkImportRow(row);
      const productName = row.name;
      if (!productName) continue;
      const key = productName.toLowerCase();
      if (!productMap.has(key)) {
        productMap.set(key, { name: productName, rows: [] });
      }
      productMap.get(key).rows.push({ ...row, rowNumber: idx + 2 });
    }

    const products = [];
    let validProducts = 0;
    let invalidProducts = 0;

    for (const [, productData] of productMap) {
      const preview = await validateImportCsvProductGroupPreview(
        productData.name,
        productData.rows
      );
      products.push({
        ...preview,
        variantCount: preview.variants.length,
        validVariants: preview.variants.filter((v) => v.isValid).length,
        invalidVariants: preview.variants.filter((v) => !v.isValid).length
      });
      if (preview.hasErrors) invalidProducts++;
      else validProducts++;
    }

    try {
      fs.unlinkSync(filePath);
    } catch (_) {}

    return res.status(200).json({
      success: true,
      message: 'Import preview (URL images CSV) — no changes saved',
      uploadType: 'CSV import (image URLs)',
      summary: {
        totalRows: rows.length,
        totalProducts: products.length,
        validProducts,
        invalidProducts,
        hasValidationErrors: invalidProducts > 0
      },
      products,
      hint: 'Fix errors then call POST /api/admin/products/import-csv with the same file.'
    });
  } catch (error) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
    console.error('previewImportProductsFromCSV:', error);
    return res.status(500).json({
      success: false,
      message: 'Preview failed',
      error: error.message
    });
  }
};

// =============================================
// HELPER: Process single product with rollback
// =============================================
async function processProductWithRollback(productName, productRows, stats) {
  const firstRow = productRows[0];
  
  try {
    let existingProduct = await Product.findOne({ 
      name: { $regex: new RegExp(`^${escapeRegex(String(productName).trim())}$`, 'i') }
    });
    const firstIncomingCode = normalizeProductCode(productRows?.[0]?.productCode);
    const preferredBase = firstIncomingCode
      ? parseProductCodeParts(firstIncomingCode, "incoming productCode").base
      : null;
    await ensureMissingVariantProductCodes(existingProduct, preferredBase);

    // Category must exist (same rule as ZIP bulk — fail whole product, not silent create)
    const categoryDoc = await Category.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(String(firstRow.category || '').trim())}$`, 'i') }
    });
    if (!categoryDoc) {
      throw new Error(`Category not found: ${firstRow.category}`);
    }
    if (existingProduct && String(existingProduct.category) !== String(categoryDoc._id)) {
      throw new Error(
        `Category mismatch for "${productName}": CSV has "${firstRow.category}" but this product is under a different category in DB`
      );
    }

    normalizeBareProductCodesForBulkGroup(productRows);
    alignIncomingRowsWithExistingSeries(
      productRows,
      (existingProduct?.variants || []).map((v) => v.productCode)
    );

    const seriesCodes = productRows.map((r) => normalizeProductCode(r.productCode));
    if (seriesCodes.some((c) => !c)) {
      throw new Error('productCode is required on every variant row');
    }
    assertBulkSeriesAgainstExisting({
      incomingCodes: seriesCodes,
      existingCodes: (existingProduct?.variants || []).map((v) => v.productCode),
      contextLabel: `CSV import product "${productName}"`
    });
    
    const variants = [];
    const duplicateproductCodes = new Map();
    
    // FIRST: Validate all productCodes before building anything (same uniqueness rules as ZIP bulk)
    for (const row of productRows) {
      const productCode = normalizeProductCode(row.productCode);
      row.productCode = productCode;
      
      if (duplicateproductCodes.has(productCode)) {
        throw new Error(`Duplicate productCode ${productCode} found in same product. Row ${row.rowNumber} and ${duplicateproductCodes.get(productCode)}`);
      }
      duplicateproductCodes.set(productCode, row.rowNumber);
      
      const existingProductWithproductCode = await Product.findOne({
        'variants.productCode': productCodeToDbQuery(productCode)
      });
      
      if (existingProductWithproductCode) {
        if (existingProduct && existingProduct._id.toString() === existingProductWithproductCode._id.toString()) {
          const productCodeExistsInProduct = existingProduct.variants.some(
            (v) => normalizeProductCode(v.productCode) === productCode
          );
          if (productCodeExistsInProduct) {
            // Existing variant on same product: keep as non-fatal, save loop will skip it.
            continue;
          }
        } else {
          throw new Error(`productCode ${productCode} already exists in product "${existingProductWithproductCode.name}". Please use unique productCode.`);
        }
      }
    }
    
    // SECOND: Build all variants (validation passed)
    for (let i = 0; i < productRows.length; i++) {
      const row = productRows[i];
      const isPrimary = !existingProduct && i === 0;
      const variant = await buildVariantWithValidation(row, productName, { isPrimary });
      variants.push(variant);
    }
    
    // THIRD: Save to database
    if (existingProduct) {
      let addedCount = 0;
      
      for (const variant of variants) {
        // Final safety check - verify productCode not already in product
        const productCodeExists = existingProduct.variants.some(
          (v) => normalizeProductCode(v.productCode) === normalizeProductCode(variant.productCode)
        );
        if (productCodeExists) {
          stats.skipped.push({
            product: productName,
            productCode: variant.productCode,
            reason: "Variant with same productCode already exists in this product"
          });
          continue;
        }
        
        // Check for duplicate attributes
        const attributeMatch = existingProduct.variants.some(v => 
          JSON.stringify(v.attributes) === JSON.stringify(variant.attributes)
        );
        
        if (attributeMatch) {
          stats.skipped.push({
            product: productName,
            productCode: variant.productCode,
            attributes: variant.attributes,
            reason: "Variant with same attributes already exists"
          });
          continue;
        }
        
        existingProduct.variants.push(variant);
        addedCount++;
      }
      
      if (addedCount === 0) {
        return { success: true, action: 'skipped', product: existingProduct };
      }
      
      // Update SEO
      const category = await Category.findById(existingProduct.category);
      const seoData = generateSEOData({
        name: existingProduct.name,
        slug: existingProduct.slug,
        description: existingProduct.description,
        category: category ? { name: category.name } : null,
        variants: existingProduct.variants,
      });
      existingProduct.seo = seoData;
      reconcileProductCatalogState(existingProduct);
      
      await existingProduct.save();
      return { success: true, action: 'updated', product: existingProduct };
      
    } else {
      // New product - create directly
      const newProduct = await buildNewProductWithVariants(productName, productRows, variants);
      return { success: true, action: 'inserted', product: newProduct };
    }
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// =============================================
// HELPER: Build variant with wholesale validation
// =============================================
async function buildVariantWithValidation(row, productName, options = {}) {
  const cleanBasePrice = parseFloat(row.basePrice?.replace(/[^0-9.]/g, "") || 0);
  const cleanSalePrice = row.salePrice ? parseFloat(row.salePrice.replace(/[^0-9.]/g, "")) : null;
  
  if (isNaN(cleanBasePrice)) {
    throw new Error(`Invalid basePrice: ${row.basePrice} (Row ${row.rowNumber})`);
  }
  
  // Wholesale config: do not fail row when wholesaleBase is missing/invalid.
  const wholesaleCfg = parseWholesaleConfigForImportRow(row);
  const wholesale = wholesaleCfg.wholesale;
  const wholesaleBase = wholesaleCfg.wholesaleBase;
  const wholesaleSale = wholesaleCfg.wholesaleSale;
  const moq = wholesaleCfg.minimumOrderQuantity;
  
  // ✅ Validate sale price < base price
  if (cleanSalePrice && cleanSalePrice >= cleanBasePrice) {
    throw new Error(`Sale price (${cleanSalePrice}) must be less than base price (${cleanBasePrice}) (Row ${row.rowNumber})`);
  }
  
  // Attributes
  const variantAttributes = row.variantAttributes
    ? row.variantAttributes.split("|").map((pair) => {
        const [key, value] = pair.split(":");
        return { key: key?.trim(), value: value?.trim() };
      }).filter(attr => attr.key && attr.value)
    : [];
  
  // Images with retry
  let imagesArr = [];
  if (row.images) {
    const imageUrls = row.images.split(",").map((u) => u.trim()).slice(0, 5);
    
    for (let url of imageUrls) {
      if (!url) continue;
      
      let uploadSuccess = false;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          let uploadResult;
          
          if (url.startsWith("data:image")) {
            const base64Data = url.split(',')[1];
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const optimizedBuffer = await optimizeProductImageBuffer(imageBuffer);
            const publicIdName = `csv-${slugify(String(productName), { lower: true, strict: true })}-r${row.rowNumber}-img${imagesArr.length}-${Date.now()}`;
            uploadResult = await uploadToCloudinary(optimizedBuffer, 'products', publicIdName);
          } else if (url.startsWith("http")) {
            const response = await axios({
              method: "GET",
              url: url,
              responseType: "arraybuffer",
              timeout: 15000,
              headers: { "User-Agent": "Mozilla/5.0" },
            });
            const optimizedBuffer = await optimizeProductImageBuffer(Buffer.from(response.data));
            const publicIdName = `csv-${slugify(String(productName), { lower: true, strict: true })}-r${row.rowNumber}-img${imagesArr.length}-${Date.now()}`;
            uploadResult = await uploadToCloudinary(optimizedBuffer, 'products', publicIdName);
          } else {
            continue;
          }
          
          imagesArr.push({
            url: uploadResult.url,
            publicId: uploadResult.publicId,
            altText: productName,
            order: imagesArr.length,
          });
          
          uploadSuccess = true;
          break;
          
        } catch (err) {
          console.log(`⚠️ Image upload attempt ${attempt} failed for ${url}:`, err.message);
          if (attempt === 3) {
            console.log(`❌ Image upload failed after 3 attempts: ${url}`);
          } else {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      
      if (!uploadSuccess) {
        console.log(`⚠️ Using original URL as fallback: ${url}`);
        imagesArr.push({
          url: url,
          publicId: null,
          altText: productName,
          order: imagesArr.length,
        });
      }
    }
  }
  
  // productCode must come from input CSV (never backend-generated)
  const parsedCode = parseProductCodeParts(row.productCode, `CSV row for ${productName}`);
  const productCode = parsedCode.normalized;
  
  const variantDoc = {
    sku: row.sku || `SKU-${productCode}`,
    productCode,
    wholesale,
    attributes: variantAttributes,
    price: {
      base: cleanBasePrice,
      sale: cleanSalePrice ? Number(cleanSalePrice) : null,
      ...(wholesale && { wholesaleBase }),
      ...(wholesale && wholesaleSale !== null && { wholesaleSale }),
    },
    minimumOrderQuantity: moq,
    inventory: {
      quantity: Number(row.quantity) || 0,
      trackInventory: true,
      lowStockThreshold: 5,
    },
    images: imagesArr,
    isActive: normalizeLifecycleFromRowStatus(row?.status, 'active') === 'active',
    channelVisibility: buildChannelVisibilityFromCsvRow(row, wholesaleCfg.wholesaleEligible),
  };
  if (options.isPrimary) {
    applyVariantCatalogFieldsToTarget(variantDoc, {}, { isPrimary: true });
  } else {
    applyVariantCatalogFieldsToTarget(
      variantDoc,
      buildVariantCatalogFieldsFromImportRow(row, { applyVariantCatalog: options.applyVariantCatalog !== false })
    );
  }
  return variantDoc;
}

// =============================================
// HELPER: Build new product with variants
// =============================================
async function buildNewProductWithVariants(productName, productRows, variants) {
  const firstRow = productRows[0];
  
  // Generate unique slug
  let baseSlug = slugify(productName, { lower: true, strict: true });
  let slug = baseSlug;
  let counter = 1;
  
  while (await Product.findOne({ slug })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  
  // Category must already exist — match by name (same as ZIP bulk + preview)
  const category = await Category.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(String(firstRow.category || '').trim())}$`, 'i') }
  });
  if (!category) {
    throw new Error(`Category not found: ${firstRow.category}`);
  }
  
  // HSN, Tax, Fragile
  const finalHsnCode = firstRow.hsnCode?.trim().toUpperCase() || null;
  const finalgstRate = firstRow.gstRate ? parseFloat(firstRow.gstRate) : null;
 const finalIsFragile = parseBoolean(firstRow.isFragile);
  
  const productObj = {
    name: productName,
    slug,
    title: firstRow.title || productName,
    description: firstRow.description || "",
    category: category._id,
    brand: firstRow.brand || "Generic",
    status: normalizeLifecycleFromRowStatus(firstRow.status, "active"),
    isFeatured: parseBoolean(firstRow.isfeatured),
    variants: variants,
    hsnCode: finalHsnCode,
    gstRate: finalgstRate,
    isFragile: finalIsFragile,
      shipping: {
      weight: Number(firstRow.weight) || 0,
      dimensions: {
        length: Number(firstRow.length) || 0,
        width: Number(firstRow.width) || 0,
        height: Number(firstRow.height) || 0,
      }
    },
    soldInfo: {
      enabled: parseBoolean(firstRow.soldEnabled),
      count: Number(firstRow.soldCount) || 0,
    },
    fomo: {
    enabled: parseBoolean(firstRow.fomoEnabled),
      type: firstRow.fomoType || "viewing_now",
      viewingNow: Number(firstRow.viewingNow) || 0,
      productLeft: Number(firstRow.productLeft) || 0,
      customMessage: firstRow.customMessage || "",
    },
  };
  reconcileProductCatalogState(productObj);

  // Generate SEO
  const seoData = generateSEOData({
    name: productObj.name,
    slug: productObj.slug,
    description: productObj.description,
    category: { name: category.name },
    variants: productObj.variants,
  });
  productObj.seo = seoData;
  
  return await Product.create(productObj);
}
// =============================================
// HELPER: Flush batch to database (FIXED - No updatedAt conflict)
// =============================================
async function flushBatch(batch, batchNumber, stats) {
  try {
    // ✅ FIX: Use insertMany for new products, separate update for existing
    const newProducts = [];
    const existingProducts = [];
    
    for (const product of batch) {
      const exists = await Product.findOne({ slug: product.slug });
      if (exists) {
        existingProducts.push(product);
      } else {
        newProducts.push(product);
      }
    }
    
    // Insert new products
    if (newProducts.length > 0) {
      await Product.insertMany(newProducts, { ordered: false });
      console.log(`✅ Batch ${batchNumber}: ${newProducts.length} new products inserted`);
    }
    
    // Update existing products individually (to avoid updatedAt conflict)
    for (const product of existingProducts) {
      try {
        await Product.updateOne(
          { slug: product.slug },
          { 
            $set: { 
              variants: product.variants,
              seo: product.seo,
              updatedAt: new Date()
            } 
          }
        );
      } catch (updateError) {
        console.log(`⚠️ Failed to update product ${product.name}:`, updateError.message);
        stats.failed.push({
          product: product.name,
          reason: updateError.message
        });
      }
    }
    
    if (existingProducts.length > 0) {
      console.log(`✅ Batch ${batchNumber}: ${existingProducts.length} products updated`);
    }
    
  } catch (error) {
    console.log(`⚠️ Batch ${batchNumber} failed: ${error.message}`);
    
    // Individual inserts for failed
    for (const product of batch) {
      try {
        await Product.create(product);
      } catch (individualError) {
        console.log(`❌ Failed to process product: ${product.name}`, individualError.message);
        stats.failed.push({
          product: product.name,
          reason: individualError.message
        });
      }
    }
  }
}

// =============================================
// HELPER: Generate error report CSV with download URL
// =============================================
// =============================================
// HELPER: Generate error report CSV with download URL
// =============================================
async function generateErrorReport(failedItems, req = null) {
  const { Parser } = require('json2csv');
  
  const parser = new Parser({
    fields: ['product', 'reason', 'rows', 'timestamp']
  });
  
  const reportData = failedItems.map(item => ({
    product: item.product,
    reason: item.reason,
    rows: item.rows ? item.rows.join(', ') : 'N/A',
    timestamp: new Date().toISOString()
  }));
  
  const csvData = parser.parse(reportData);
  const fileName = `failed-import-${Date.now()}.csv`;
  const filePath = path.join(__dirname, '../uploads', fileName);
  
  fs.writeFileSync(filePath, csvData);
  console.log(`📄 Error report generated: ${filePath}`);
  
  // Generate download URL if req is provided
  let downloadUrl = null;
  if (req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    // ✅ FIX: Match your actual route
    downloadUrl = `${baseUrl}/api/admin/products/download-error-report/${fileName}`;
    console.log(`🔗 Download URL: ${downloadUrl}`);
  }
  
  return {
    path: `/uploads/${fileName}`,
    downloadUrl: downloadUrl,
    fileName: fileName,
    fullPath: filePath
  };
}




// =============================================
// DOWNLOAD ERROR REPORT API (Common for both controllers)
// =============================================
const downloadErrorReport = async (req, res) => {
  try {
    const { fileName } = req.params;
    
    // ✅ Security: Allow both types of error reports
    if (!fileName || !fileName.endsWith('.csv')) {
      return res.status(400).json({
        success: false,
        message: "Invalid file format. Only CSV files allowed."
      });
    }
    
    // ✅ Check if it's a valid error report (either failed-import or failed-upload)
    if (!fileName.startsWith('failed-import-') && !fileName.startsWith('failed-upload-')) {
      return res.status(400).json({
        success: false,
        message: "Invalid error report file name"
      });
    }
    
    const filePath = path.join(__dirname, '../uploads', fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "Error report not found or already deleted"
      });
    }
    
    // Send file for download
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Download error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to download file"
        });
      }
      
      // Optional: Delete file after successful download (cleanup)
      // setTimeout(() => {
      //   if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // }, 60 * 60 * 1000); // Delete after 1 hour
    });
    
  } catch (error) {
    console.error("Download error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to download error report",
      error: error.message
    });
  }
};



////////=================================
//=================================
//=================================
// NEW PRORDUCTS UPLOADS WITH ZIP AND CSV
//=================================
//=================================
///////===================================

//Bulk ypload from CSV with images in ZIP

// =============================================
// HELPER: Upload single image with retry
// =============================================
async function uploadSingleImageWithRetry(filePath, productName, productCode, index, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const raw = fs.readFileSync(filePath);
      const buffer = await optimizeProductImageBuffer(raw);
      const publicId = `zip-${slugify(String(productName), { lower: true, strict: true })}-${String(productCode)}-i${index}-${Date.now()}`;
      const upload = await uploadToCloudinary(buffer, "products", publicId);
      return {
        url: upload.url,
        publicId: upload.publicId,
        altText: productName,
        order: index
      };
    } catch (err) {
      console.log(`⚠️ Upload attempt ${attempt} failed for ${filePath}: ${err.message}`);
      if (attempt === maxRetries) {
        throw new Error(`Failed to upload image after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// =============================================
// HELPER: Upload variant images with concurrency limit
// =============================================
async function uploadVariantImages(imageFolder, productName, productCode, concurrencyLimit = 5) {
  if (!fs.existsSync(imageFolder)) {
    throw new Error(`Image folder not found for productCode ${productCode}`);
  }

  const files = fs.readdirSync(imageFolder).filter(file => 
    /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
  );

  if (!files.length) {
    throw new Error(`No valid images found for productCode ${productCode}`);
  }

  // Limit to max 10 images per variant
  const filesToUpload = files.slice(0, 10);
  
  const results = [];
  const batches = [];
  
  // Create batches with concurrency limit
  for (let i = 0; i < filesToUpload.length; i += concurrencyLimit) {
    batches.push(filesToUpload.slice(i, i + concurrencyLimit));
  }
  
  for (const batch of batches) {
    const batchPromises = batch.map((file, idx) => {
      const filePath = path.join(imageFolder, file);
      const globalIndex = results.length;
      return uploadSingleImageWithRetry(filePath, productName, productCode, globalIndex);
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }
  
  return results;
}

/**
 * ZIP bulk: resolve parent product by exact name or by existing variant series base (e.g. 9002-1).
 */
async function findProductForZipBulkRow(row, parsedCode) {
  const name = String(row.name || '').trim();
  if (name) {
    const byName = await Product.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') }
    });
    if (byName) return byName;
  }
  if (parsedCode?.base && parsedCode.sequence != null) {
    const variantCodePattern = new RegExp(`^${escapeRegex(parsedCode.base)}-\\d+$`, 'i');
    const bySeries = await Product.findOne({
      'variants.productCode': { $regex: variantCodePattern }
    });
    if (bySeries) return bySeries;
  }
  return null;
}

// =============================================
// HELPER: Build variant with complete validation (ZIP bulk + shared)
// Primary variant (new product first row): catalog fields live on product doc.
// Additional variants: per-row title, description, weight, dimensions on variant doc.
// =============================================
async function buildCompleteVariant(row, productName, images, options = {}) {
  const isPrimary = options.isPrimary === true;
  // Validate productCode format (BASE-N)
  const parsedCode = parseProductCodeParts(row.productCode, `CSV row for ${productName}`);
  const productCode = parsedCode.normalized;
  
  // Parse and validate price
  const basePrice = Number(row.basePrice);
  if (isNaN(basePrice) || basePrice <= 0) {
    throw new Error(`Invalid basePrice: ${row.basePrice}. Must be a positive number`);
  }
  
  const salePriceRaw = row.salePrice != null ? String(row.salePrice).trim() : '';
  const salePrice = salePriceRaw ? Number(salePriceRaw) : null;
  if (salePrice !== null && (isNaN(salePrice) || salePrice <= 0)) {
    throw new Error(`Invalid salePrice: ${row.salePrice}. Must be a positive number`);
  }
  
  if (salePrice !== null && salePrice >= basePrice) {
    throw new Error(`Sale price (${salePrice}) must be less than base price (${basePrice})`);
  }
  
  const wholesaleCfg = parseWholesaleConfigForImportRow(row);
  const wholesale = wholesaleCfg.wholesale;
  const wholesaleBase = wholesaleCfg.wholesaleBase;
  const wholesaleSale = wholesaleCfg.wholesaleSale;
  const minimumOrderQuantity = wholesaleCfg.minimumOrderQuantity;
  
  // Parse attributes
  const parseAttributes = (attrString) => {
    if (!attrString) return [];
    return attrString.split("|").map(item => {
      const [key, value] = item.split(":");
      return { key: key?.trim(), value: value?.trim() };
    }).filter(attr => attr.key && attr.value);
  };
  
  const variantAttributes = parseAttributes(row.variantAttributes);
  const sku = row.sku?.trim() || `SKU-${productCode}`;
  const wholesaleEligible = wholesaleCfg.wholesaleEligible;

  const variantDoc = {
    sku,
    productCode,
    wholesale,
    attributes: variantAttributes,
    price: {
      base: basePrice,
      sale: salePrice,
      ...(wholesale && wholesaleBase > 0 && { wholesaleBase }),
      ...(wholesale && wholesaleSale !== null && { wholesaleSale }),
    },
    minimumOrderQuantity,
    inventory: {
      quantity: Number(row.quantity) || 0,
      trackInventory: true,
      lowStockThreshold: 5,
    },
    images: images,
    isActive: normalizeLifecycleFromRowStatus(row?.status, 'active') === 'active',
    channelVisibility: buildChannelVisibilityFromCsvRow(row, wholesaleEligible)
  };

  if (isPrimary) {
    applyVariantCatalogFieldsToTarget(variantDoc, {}, { isPrimary: true });
  } else {
    applyVariantCatalogFieldsToTarget(
      variantDoc,
      buildVariantCatalogFieldsFromImportRow(row, { applyVariantCatalog: options.applyVariantCatalog !== false })
    );
  }

  return variantDoc;
}

// =============================================
// MAIN CONTROLLER: Bulk upload with ZIP
// =============================================
const bulkUploadNewProductsWithImages = async (req, res) => {
  let csvPath = null;
  let zipPath = null;
  let extractPath = null;
  
  try {
    if (!req.files?.csvFile || !req.files?.imagesZip) {
      return res.status(400).json({
        success: false,
        message: "CSV file and images ZIP are required"
      });
    }

    csvPath = req.files.csvFile[0].path;
    zipPath = req.files.imagesZip[0].path;
    extractPath = path.join(__dirname, "../uploads/extracted");

    // Clean and create extract folder
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    fs.mkdirSync(extractPath, { recursive: true });

    // Extract ZIP
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    // Resolve the actual content root. Auto-descends through single-folder
    // wrappers and ignores OS junk like __MACOSX/ and .DS_Store so that
    // `imgz.zip → imgz/<product-code>/...` works the same as a flat zip.
    const rootFolder = resolveZipContentRoot(extractPath);
    console.log(
      `📦 ZIP extracted. Content root: ${rootFolder === extractPath ? '(zip root)' : path.relative(extractPath, rootFolder)}. ` +
      `Top-level folders: ${describeAvailableImageFolders(rootFolder)}`
    );

    // Parse CSV
    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
        .on("data", (data) => {
          // Trim all string values
          Object.keys(data).forEach(key => {
            if (typeof data[key] === 'string') {
              data[key] = data[key].trim();
            }
          });
          normalizeBulkImportRow(data);
          data.rowNumber = rows.length + 2; // header is row 1
          rows.push(data);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    console.log(`📊 Total rows in CSV: ${rows.length}`);

    // Normalize and validate productCode series per product upfront.
    // Example for 3 variants: 4321-1, 4321-2, 4321-3 (01, 02 also accepted on input)
    const rowsByProductName = new Map();
    for (const row of rows) {
      row.productCode = normalizeProductCode(row.productCode);
      const key = String(row.name || '').trim().toLowerCase();
      if (!key) continue;
      if (!rowsByProductName.has(key)) rowsByProductName.set(key, []);
      rowsByProductName.get(key).push(row);
    }
    for (const [nameKey, productRows] of rowsByProductName.entries()) {
      normalizeBareProductCodesForBulkGroup(productRows);
      const existingProduct = await Product.findOne({
        name: { $regex: new RegExp(`^${escapeRegex(String(productRows[0]?.name || '').trim())}$`, 'i') }
      }).select('variants.productCode');
      alignIncomingRowsWithExistingSeries(
        productRows,
        (existingProduct?.variants || []).map((v) => v.productCode)
      );
      const codes = productRows.map((r) => r.productCode).filter(Boolean);
      if (codes.length === 0) continue;
      try {
        assertBulkSeriesAgainstExisting({
          incomingCodes: codes,
          existingCodes: (existingProduct?.variants || []).map((v) => v.productCode),
          contextLabel: `bulk product "${nameKey}"`
        });
      } catch (err) {
        const isNewProduct = !existingProduct;
        let msg = err.message;
        if (isNewProduct) {
          const sampleCode = codes[0];
          try {
            const parsed = parseProductCodeParts(sampleCode, "productCode");
            if (parsed.sequence != null && parsed.sequence > 1) {
              msg = `${msg} This looks like a new product; start from ${parsed.base} or ${parsed.base}-1.`;
            }
          } catch {
            // keep original message
          }
        }
        for (const row of productRows) {
          row._preValidationError = msg;
        }
      }
    }

    // Process variant -1 before -2/-3 per product so primary row creates product shipping first.
    rows.sort((a, b) => {
      const nameA = String(a.name || '').trim().toLowerCase();
      const nameB = String(b.name || '').trim().toLowerCase();
      if (nameA !== nameB) return nameA.localeCompare(nameB);
      try {
        const pa = parseProductCodeParts(normalizeProductCode(a.productCode), 'productCode');
        const pb = parseProductCodeParts(normalizeProductCode(b.productCode), 'productCode');
        const seqA = pa.sequence != null ? pa.sequence : 0;
        const seqB = pb.sequence != null ? pb.sequence : 0;
        if (seqA !== seqB) return seqA - seqB;
      } catch {
        // keep stable row order fallback
      }
      return (a.rowNumber || 0) - (b.rowNumber || 0);
    });

    const stats = {
      total: rows.length,
      successful: 0,
      failed: 0,
      errors: [],
      products: [],
      // Rows that were created/updated successfully but with NO images
      // (folder missing / empty / upload skipped). Admin can re-upload later.
      missingImages: []
    };

    const BATCH_SIZE = 50;
    const BATCH_DELAY_MS = 1000;

    // =============================================
    // Process rows sequentially within batch (avoids same-product race on -1/-2)
    // =============================================
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      
      console.log(`🔄 Processing batch ${batchNumber}/${Math.ceil(rows.length / BATCH_SIZE)} (${batch.length} products)`);
      
      for (const row of batch) {
        try {
          if (row._preValidationError) {
            throw new Error(row._preValidationError);
          }
          const rawCode = normalizeProductCode(row.productCode);
          if (!rawCode) {
            throw new Error(
              `productCode is missing in row ${row.rowNumber || "?"}. Use column "productCode" (aliases supported: productcode/prodcutCode).`
            );
          }
          const parsedCode = parseProductCodeParts(row.productCode, `row "${row.name || 'Unknown'}"`);
          const productCode = parsedCode.normalized;

          // Validate category
          const categoryDoc = await Category.findOne({ 
            name: { $regex: new RegExp(`^${row.category}$`, 'i') }
          });
          
          if (!categoryDoc) {
            throw new Error(`Category not found: ${row.category}`);
          }

          // Upload images from productCode folder.
          // Folder names may use canonical or two-digit suffix (e.g. 83478-1 vs 83478-01).
          //
          // POLICY (intentional, requested by product):
          //   Missing images must NOT block product/variant creation. The
          //   product is created with an empty images array and is flagged so
          //   the admin can see in the response which rows lack images and
          //   re-upload them later. This matches the preview controller which
          //   already treats missing images as a warning, not an error.
          const folderCandidates = getImageFolderCandidatesForRow(row);
          const { folderPath: imageFolder, matchedCode } = resolveImageFolderByCandidates(
            rootFolder,
            folderCandidates
          );

          let variantImages = [];
          let imagesWarning = null;

          if (!imageFolder) {
            imagesWarning =
              `Image folder not found for productCode ${productCode}. ` +
              `Tried: ${folderCandidates.join(", ")}. ` +
              `Available folders inside zip: ${describeAvailableImageFolders(rootFolder)}. ` +
              `Product/variant created without images — re-upload images later.`;
            console.warn(`⚠️ ${imagesWarning}`);
          } else {
            try {
              variantImages = await uploadVariantImages(
                imageFolder,
                row.name,
                matchedCode || productCode
              );
            } catch (imgErr) {
              // Folder exists but empty / all uploads failed → don't block
              // product creation. Record the reason for the response report.
              variantImages = [];
              imagesWarning =
                `Image upload skipped for productCode ${productCode}: ${imgErr.message}. ` +
                `Product/variant created without images — re-upload images later.`;
              console.warn(`⚠️ ${imagesWarning}`);
            }
          }

          // Resolve product before variant build — primary only when creating a new product (first row)
          let product = await findProductForZipBulkRow(row, parsedCode);
          await ensureMissingVariantProductCodes(product, parsedCode.base);

          if (!product && parsedCode.sequence != null && parsedCode.sequence > 1) {
            throw new Error(
              `Cannot import variant ${productCode}: product "${String(row.name || '').trim()}" was not found. ` +
                `Import ${parsedCode.base}-1 first with the exact same product name.`
            );
          }

          const isPrimaryVariantRow = !product;
          const newVariant = await buildCompleteVariant(row, row.name, variantImages, {
            isPrimary: isPrimaryVariantRow
          });

          // Parse product-level fields
          const finalHsnCode = row.hsnCode?.trim().toUpperCase() || null;
          const finalgstRate = row.gstRate ? parseFloat(row.gstRate) : null;
          const finalIsFragile = parseBoolean(row.isFragile);
          const parseAttributes = (attrString) => {
            if (!attrString) return [];
            return attrString.split("|").map(item => {
              const [key, value] = item.split(":");
              return { key: key?.trim(), value: value?.trim() };
            }).filter(attr => attr.key && attr.value);
          };
          const productAttributes = parseAttributes(row.productAttributes);

          if (product) {
            // If product already has variants, incoming productCode base must match existing base.
            if (Array.isArray(product.variants) && product.variants.length > 0) {
              const existingCode = normalizeProductCode(product.variants[0].productCode);
              if (existingCode) {
                try {
                  const existingParts = parseProductCodeParts(existingCode, `existing variant of ${product.name}`);
                  if (parsedCode.base !== existingParts.base) {
                    throw new Error(
                      `productCode base mismatch for "${row.name}". Expected ${existingParts.base}-N, got ${productCode}`
                    );
                  }
                } catch (_) {
                  // Legacy productCode format found on existing product; skip base-series enforcement for backward compatibility.
                }
              }
            }

            // Check for duplicate variant attributes
            const variantExists = product.variants.some(v => 
              JSON.stringify(v.attributes) === JSON.stringify(newVariant.attributes)
            );
            
            if (variantExists) {
              throw new Error(`Variant with same attributes already exists for product ${row.name}`);
            }

            const duplicateCodeInSameProduct = product.variants.some(
              (v) => normalizeProductCode(v.productCode) === productCode
            );
            if (duplicateCodeInSameProduct) {
              const suggested = suggestNextVariantCodeForProduct(product, productCode);
              const seriesInfo = getExistingSeriesInfo(product, productCode);
              const entered = normalizeProductCode(row._productCodeAdjustedFrom);
              throw new Error(
                entered && entered !== productCode
                  ? seriesInfo?.hasSuffixed
                    ? `You entered ${entered}. This maps to existing code ${productCode}. Variants already exist till ${seriesInfo.lastCode}.`
                    : `You entered ${entered}. This maps to existing code ${productCode}. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code for this product"}.`
                  : seriesInfo?.hasSuffixed
                    ? `productCode ${productCode} already exists on this product. Variants already exist till ${seriesInfo.lastCode}.`
                    : `productCode ${productCode} already exists on this product. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code for this product"}.`
              );
            }
            
            const shippingCheck = validateVariantsResolvableShipping(product.shipping, [
              ...product.variants,
              newVariant
            ], product);
            if (!shippingCheck.valid) {
              throw new Error(shippingCheck.message || 'Variant shipping weight and dimensions are required.');
            }

            product.variants.push(newVariant);
            
            // Update product-level fields if not set
            if (finalHsnCode && !product.hsnCode) product.hsnCode = finalHsnCode;
            if (finalgstRate !== null && !product.gstRate) product.gstRate = finalgstRate;
            if (finalIsFragile && !product.isFragile) product.isFragile = finalIsFragile;
            if (productAttributes.length && !product.attributes?.length) {
              product.attributes = productAttributes;
            }

            reconcileProductCatalogState(product);
            await product.save();
            stats.successful++;
            stats.products.push({ name: row.name, productCode, action: 'updated' });
            if (imagesWarning) {
              stats.missingImages.push({
                row: `${row.name} (row ${row.rowNumber || '?'})`,
                productCode,
                action: 'updated',
                reason: imagesWarning
              });
            }
          } else {
            const existingProductWithCode = await Product.findOne({
              "variants.productCode": productCodeToDbQuery(productCode)
            }).select("name");
            if (existingProductWithCode) {
              throw new Error(
                `productCode ${productCode} belongs to product "${existingProductWithCode.name}". Please use a different productCode for "${row.name}".`
              );
            }
            // Create new product
            const slug = await generateSlug(row.name);
            
            // Generate SEO
            const seoData = generateSEOData({
              name: row.name,
              title: row.title || row.name,
              description: row.description || '',
              category: { name: categoryDoc.name },
              variants: [newVariant]
            });
            
            product = new Product({
              name: row.name,
              title: row.title || row.name,
              slug,
              description: row.description || "",
              category: categoryDoc._id,
              brand: row.brand || "Generic",
              status: normalizeLifecycleFromRowStatus(row.status, "active"),
              channelStatus: deriveProductChannelStatusFromVariants([newVariant]),
              isFeatured: parseBoolean(row.isfeatured),
              attributes: productAttributes,
              variants: [newVariant],
              seo: seoData,
              hsnCode: finalHsnCode,
              gstRate: finalgstRate,
              isFragile: finalIsFragile,
                shipping: {
    weight: Number(row.weight) || 0,
    dimensions: {
      length: Number(row.length) || 0,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
    }
  },
              soldInfo: {
                enabled: parseBoolean(row.soldEnabled),
                count: Number(row.soldCount) || 0,
              },
              fomo: {
                enabled: parseBoolean(row.fomoEnabled),
                type: row.fomoType || "viewing_now",
                viewingNow: Number(row.viewingNow) || 0,
                productLeft: Number(row.productLeft) || 0,
                customMessage: row.customMessage || "",
              }
            });

            const newProductShippingCheck = validateVariantsResolvableShipping(product.shipping, product.variants, product);
            if (!newProductShippingCheck.valid) {
              throw new Error(newProductShippingCheck.message || 'Product shipping weight and dimensions are required.');
            }
            reconcileProductCatalogState(product);
            await product.save();
            stats.successful++;
            stats.products.push({ name: row.name, productCode, action: 'inserted' });
            if (imagesWarning) {
              stats.missingImages.push({
                row: `${row.name} (row ${row.rowNumber || '?'})`,
                productCode,
                action: 'inserted',
                reason: imagesWarning
              });
            }
          }
          
        } catch (err) {
          stats.failed++;
          stats.errors.push({
            row: `${row.name || "Unknown"} (row ${row.rowNumber || "?"})`,
            productCode: row.productCode,
            error: err.message
          });
          console.error(`❌ Failed to process ${row.name}:`, err.message);
        }
      }
      
      if (i + BATCH_SIZE < rows.length) {
        console.log(`⏳ Waiting ${BATCH_DELAY_MS}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      console.log(`📊 Batch ${batchNumber} completed. Success: ${stats.successful}, Failed: ${stats.failed}`);
    }

    // =============================================
    // Generate error report if any failures
    // =============================================
    let errorReportUrl = null;
    
    if (stats.errors.length > 0) {
      const { Parser } = require('json2csv');
      const parser = new Parser({ fields: ["row", "productCode", "error"] });
      const csvData = parser.parse(stats.errors);
      const fileName = `failed-upload-${Date.now()}.csv`;
      const errorReportPath = path.join(__dirname, "../uploads", fileName);
      fs.writeFileSync(errorReportPath, csvData);
      console.log(`📄 Error report generated: ${errorReportPath}`);
      
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      errorReportUrl = `${baseUrl}/api/admin/products/download-error-report/${fileName}`;
      console.log(`🔗 Download URL: ${errorReportUrl}`);
    }

    // Cleanup
    if (csvPath && fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (extractPath && fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }

    console.log(`\n🎉 BULK UPLOAD COMPLETED!`);
    console.log(`✅ Successful: ${stats.successful}`);
    console.log(`❌ Failed: ${stats.failed}`);
    if (stats.missingImages.length > 0) {
      console.log(`🖼️  Created without images: ${stats.missingImages.length} (admin should re-upload images for these)`);
    }

    // =============================================
    // Send FINAL response with download link
    // =============================================
    return res.status(200).json({
      success: true,
      message: stats.missingImages.length > 0
        ? `Bulk upload completed. ${stats.missingImages.length} product(s) created without images — see "missingImages" to re-upload.`
        : "Bulk upload completed",
      totalRows: rows.length,
      successful: stats.successful,
      failed: stats.failed,
      // Products that succeeded but have no images yet. Empty array when all
      // products had their images uploaded.
      createdWithoutImagesCount: stats.missingImages.length,
      missingImages: stats.missingImages,
      downloadUrl: errorReportUrl  // ✅ Direct download link in response
    });
    
  } catch (error) {
    console.error("Bulk upload error:", error);
    // Cleanup on error
    if (csvPath && fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (extractPath && fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    
    return res.status(500).json({
      success: false,
      message: "Bulk upload failed",
      error: error.message
    });
  }
};


// =============================================
// 🗑️ AUTO CLEANUP OLD ERROR REPORTS
// =============================================

const cleanupOldReports = () => {
  try {
    const uploadsDir = path.join(__dirname, '../uploads');
    
    // Check if uploads folder exists
    if (!fs.existsSync(uploadsDir)) return;
    
    const files = fs.readdirSync(uploadsDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // 1 hour
    let deletedCount = 0;
    
    for (const file of files) {
      // Only target error report files
      if ((file.startsWith('failed-import-') || file.startsWith('failed-upload-')) && file.endsWith('.csv')) {
        const filePath = path.join(uploadsDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < oneHourAgo) {
            fs.unlinkSync(filePath);
            deletedCount++;
            console.log(`🗑️ Deleted old report: ${file}`);
          }
        } catch (err) {
          console.log(`⚠️ Failed to delete ${file}:`, err.message);
        }
      }
    }
    
    if (deletedCount > 0) {
      console.log(`✅ Cleaned up ${deletedCount} old error report(s)`);
    }
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
};

// Run cleanup on server startup
cleanupOldReports();

// Run cleanup every hour
setInterval(cleanupOldReports, 60 * 60 * 1000);

console.log('🗑️ Auto-cleanup initialized for error reports (runs every hour)');

// =============================================
// SMART PREVIEW API - Works for both CSV-only and ZIP+CSV
// =============================================
const previewBulkUpload = async (req, res) => {
  let csvPath = null;
  let zipPath = null;
  let extractPath = null;
  
  try {
    // =============================================
    // STEP 1: Detect which type of upload
    // =============================================
    const hasZip = req.files?.imagesZip && req.files?.imagesZip[0];
    const hasCSV = req.files?.csvFile && req.files?.csvFile[0] || req.file;
    
    // Get CSV file path (works for both single file and multi file)
    if (req.file) {
      csvPath = req.file.path; // Single file upload (CSV only)
    } else if (req.files?.csvFile) {
      csvPath = req.files.csvFile[0].path; // Multi file upload (CSV + ZIP)
    }
    
    if (!csvPath) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required for preview"
      });
    }

    console.log(`📁 Preview - CSV: ${csvPath}`);
    if (hasZip) {
      zipPath = req.files.imagesZip[0].path;
      console.log(`📁 Preview - ZIP: ${zipPath}`);
    }

    // =============================================
    // STEP 2: Extract ZIP if provided
    // =============================================
    let rootFolder = null;
    if (hasZip && zipPath) {
      extractPath = path.join(__dirname, "../uploads/preview_extracted");
      
      if (fs.existsSync(extractPath)) {
        fs.rmSync(extractPath, { recursive: true, force: true });
      }
      fs.mkdirSync(extractPath, { recursive: true });
      
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractPath, true);

      // Same content-root resolution as the live import — see resolveZipContentRoot.
      rootFolder = resolveZipContentRoot(extractPath);
      console.log(
        `📦 Preview ZIP extracted. Content root: ${rootFolder === extractPath ? '(zip root)' : path.relative(extractPath, rootFolder)}. ` +
        `Top-level folders: ${describeAvailableImageFolders(rootFolder)}`
      );
    }

    // =============================================
    // STEP 3: Read and parse CSV
    // =============================================
    const rows = [];
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(csvPath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }));
      
      stream.on("data", (row) => {
        Object.keys(row).forEach(key => {
          if (typeof row[key] === "string") {
            row[key] = row[key].trim();
          }
        });
        normalizeBulkImportRow(row);
        rows.push(row);
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    if (!rows.length) {
      return res.status(422).json({
        success: false,
        message: "CSV file is empty"
      });
    }

    // =============================================
    // STEP 4: Validate required columns
    // =============================================
    const requiredColumns = ['name', 'category', 'basePrice'];
    const firstRow = rows[0];
    const missingColumns = requiredColumns.filter(col => !firstRow.hasOwnProperty(col));
    
    if (missingColumns.length > 0) {
      return res.status(422).json({
        success: false,
        message: `Missing required columns: ${missingColumns.join(', ')}`,
        missingColumns,
        foundColumns: Object.keys(firstRow)
      });
    }

    // =============================================
    // STEP 5: Group rows by product name
    // =============================================
    const productMap = new Map();
    
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const productName = row.name;
      if (!productName) continue;
      
      const key = productName.toLowerCase();
      if (!productMap.has(key)) {
        productMap.set(key, {
          name: productName,
          rows: [],
          originalIndex: idx
        });
      }
      productMap.get(key).rows.push({ ...row, rowNumber: idx + 2 });
    }

    // =============================================
    // STEP 6: Validate each product and variant
    // =============================================
    const products = [];
    let validProducts = 0;
    let invalidProducts = 0;
    let totalVariants = 0;
    let totalImagesFound = 0;
    let missingImagesCount = 0;
    
    for (const [_, productData] of productMap) {
      const { name: productName, rows: productRows } = productData;
      for (const row of productRows) {
        if (row.productCode != null) row.productCode = normalizeProductCode(row.productCode);
      }
      normalizeBareProductCodesForBulkGroup(productRows);
      const existingProduct = await Product.findOne({
        name: { $regex: new RegExp(`^${escapeRegex(String(productName).trim())}$`, 'i') }
      }).select('name slug variants.productCode');
      alignIncomingRowsWithExistingSeries(
        productRows,
        (existingProduct?.variants || []).map((v) => v.productCode)
      );
      const productErrors = [];
      const variants = [];
      const productCodes = new Set();
      let nextSuggestedProductCode = null;
      const nextCodeForSameProduct = createNextVariantCodeSuggester(existingProduct);
      
      for (const row of productRows) {
        const variantErrors = [];
        const variantWarnings = [];
        const productCode = row.productCode;

        if (row._productCodeAdjustedFrom) {
          variantWarnings.push(
            `Adjusted productCode ${row._productCodeAdjustedFrom} -> ${productCode} to match existing series format`
          );
        }
        
        // productCode validation
        if (!productCode) {
          variantErrors.push("productCode is missing");
        } else if (productCodes.has(productCode)) {
          variantErrors.push(`Duplicate productCode ${productCode} in same product`);
        } else {
          productCodes.add(productCode);
          if (!existingProduct) {
            try {
              const parsedForNew = parseProductCodeParts(productCode, "productCode");
              if (parsedForNew.sequence != null && parsedForNew.sequence > 1) {
                const hasFirstVariantInGroup = productRows.some((siblingRow) => {
                  try {
                    const siblingCode = normalizeProductCode(siblingRow.productCode);
                    const siblingParsed = parseProductCodeParts(siblingCode, "productCode");
                    return siblingParsed.base === parsedForNew.base && siblingParsed.sequence === 1;
                  } catch {
                    return false;
                  }
                });
                if (!hasFirstVariantInGroup) {
                  variantWarnings.push(
                    `This looks like a new product, but productCode starts from ${parsedForNew.normalized}. Prefer ${parsedForNew.base} or ${parsedForNew.base}-1 for first variant.`
                  );
                }
              }
            } catch {
              // format issues handled elsewhere
            }
          }
          try {
            parseProductCodeParts(productCode, 'productCode');
          } catch (e) {
            variantErrors.push(
              `Invalid productCode "${productCode}". Single variant: plain BASE (e.g. 87856). Multiple variants: same BASE with numeric suffix 1, 2, 3… (e.g. 87856-1 and 87856-2; leading zeros optional in input).`
            );
          }
          
          // Check if productCode already exists in DB.
          // Preview must mirror real import behavior:
          //   - ZIP import (`bulkUploadNewProductsWithImages`) throws an error
          //     when an incoming productCode duplicates an existing variant on the
          //     same product.
          //   - URL import (`processProductWithRollback`) silently skips the row,
          //     so the variant is still NOT inserted.
          // In both cases the row will not produce a new variant, so we surface it
          // as a blocking ERROR (not a warning) — otherwise admins see "✓ OK" in
          // preview but get failed/skipped rows during the actual import.
          if (productCode) {
            const existingProductWithCode = await Product.findOne({
              'variants.productCode': productCodeToDbQuery(productCode)
            }).select('name variants.productCode');
            if (existingProductWithCode) {
              const isSameProduct =
                String(existingProductWithCode.name || "").trim().toLowerCase() ===
                String(productName || "").trim().toLowerCase();
              if (isSameProduct) {
                const suggested = nextCodeForSameProduct(productCode);
                const entered = normalizeProductCode(row._productCodeAdjustedFrom);
                const seriesInfo = getExistingSeriesInfo(existingProductWithCode, productCode);
                variantErrors.push(
                  entered && entered !== productCode
                    ? seriesInfo?.hasSuffixed
                      ? `You entered ${entered}. It maps to existing series code ${productCode} which already exists on this product. Variants already exist till ${seriesInfo.lastCode}. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code"}.`
                      : `You entered ${entered}. It maps to existing code ${productCode} which already exists on this product. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code for this product"}.`
                    : seriesInfo?.hasSuffixed
                      ? `productCode ${productCode} already exists on this product. Variants already exist till ${seriesInfo.lastCode}. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code"}.`
                      : `productCode ${productCode} already exists on this product. To add a new variant, use ${seriesInfo?.nextCode || suggested || "the next sequential BASE-N code for this product"}.`
                );
              } else {
                variantErrors.push(
                  `productCode ${productCode} belongs to product "${existingProductWithCode.name}". If this row is for "${productName}", use a different productCode.`
                );
              }
            }
          }
        }
        
        // Price validation
        const basePrice = parseFloat(row.basePrice?.replace(/[^0-9.]/g, "") || 0);
        if (isNaN(basePrice) || basePrice <= 0) {
          variantErrors.push(`Invalid basePrice: ${row.basePrice}`);
        }
        
        const salePrice = row.salePrice ? parseFloat(row.salePrice.replace(/[^0-9.]/g, "")) : null;
        if (salePrice !== null && salePrice >= basePrice) {
          variantErrors.push(`Sale price (${salePrice}) must be less than base price (${basePrice})`);
        }
        
        // Wholesale validation
        const wholesale = parseBoolean(row.wholesale);
        if (wholesale && (!row.wholesaleBase || row.wholesaleBase.trim() === "")) {
          variantErrors.push("wholesaleBase is required when wholesale=true");
        }
        
        // Image validation (only if ZIP provided)
        let hasImages = false;
        let imageCount = 0;
        if (hasZip && rootFolder && productCode) {
          const folderCandidates = getImageFolderCandidatesForRow(row);
          const { folderPath: imageFolder } = resolveImageFolderByCandidates(rootFolder, folderCandidates);
          if (imageFolder) {
            const images = fs.readdirSync(imageFolder).filter(file => 
              /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
            );
            imageCount = images.length;
            hasImages = imageCount > 0;
            if (hasImages) totalImagesFound++;
            if (!hasImages) {
              variantWarnings.push(`No images found for productCode ${productCode}`);
              missingImagesCount++;
            }
          } else {
            variantWarnings.push(
              `Image folder not found for productCode ${productCode} ` +
              `(tried: ${folderCandidates.join(", ")}; ` +
              `available: ${describeAvailableImageFolders(rootFolder)})`
            );
            missingImagesCount++;
          }
        } else if (!hasZip && row.images) {
          // CSV-only mode: check if image URLs provided
          const imageUrls = row.images.split(",").filter(url => url.trim());
          hasImages = imageUrls.length > 0;
          imageCount = imageUrls.length;
          if (hasImages) totalImagesFound++;
        }
        
        variants.push({
          rowNumber: row.rowNumber,
          productCode: productCode || "N/A",
          basePrice: basePrice || 0,
          salePrice: salePrice || null,
          wholesale,
          quantity: Number(row.quantity) || 0,
          hasImages,
          imageCount,
          isValid: variantErrors.length === 0,
          errors: variantErrors,
          warnings: variantWarnings
        });
        
        if (variantErrors.length === 0) totalVariants++;
      }

      // Same rules as bulk upload: validate incoming rows against existing + incoming series.
      if (productRows.length > 0) {
        try {
          const seriesCodes = productRows
            .map((r) => normalizeProductCode(r.productCode))
            .filter(Boolean);
          const combinedSeriesInfo = assertBulkSeriesAgainstExisting({
            incomingCodes: seriesCodes,
            existingCodes: (existingProduct?.variants || []).map((v) => v.productCode),
            contextLabel: `product "${productName}"`
          });
          nextSuggestedProductCode = combinedSeriesInfo.nextSuggestedProductCode;
        } catch (e) {
          productErrors.push(e.message);
          for (const v of variants) {
            v.isValid = false;
          }
        }
      }
      
      // Category validation
      let categoryValid = true;
      let categoryWarning = null;
      const categoryDoc = await Category.findOne({ 
        name: { $regex: new RegExp(`^${productRows[0].category}$`, 'i') }
      });
      if (!categoryDoc) {
        categoryValid = false;
        categoryWarning = `Category "${productRows[0].category}" not found in database`;
        productErrors.push(categoryWarning);
      }
      
      const hasErrors = productErrors.length > 0 || variants.some(v => !v.isValid);
      
      if (hasErrors) {
        invalidProducts++;
      } else {
        validProducts++;
      }
      
      products.push({
        name: productName,
        category: productRows[0].category,
        brand: productRows[0].brand || "Generic",
        status: productRows[0].status || "draft",
        variantCount: productRows.length,
        validVariants: variants.filter(v => v.isValid).length,
        invalidVariants: variants.filter(v => !v.isValid).length,
        totalQuantity: variants.reduce((sum, v) => sum + v.quantity, 0),
        priceRange: {
          min: Math.min(...variants.map(v => v.salePrice || v.basePrice)),
          max: Math.max(...variants.map(v => v.basePrice))
        },
        hasImages: variants.some(v => v.hasImages),
        errors: productErrors,
        variants: variants.slice(0, 5), // Show first 5 variants
        nextSuggestedProductCode,
        hasErrors
      });
    }
    
    // =============================================
    // STEP 7: Cleanup
    // =============================================
    if (csvPath && fs.existsSync(csvPath)) {
      try { fs.unlinkSync(csvPath); } catch(e) {}
    }
    if (zipPath && fs.existsSync(zipPath)) {
      try { fs.unlinkSync(zipPath); } catch(e) {}
    }
    if (extractPath && fs.existsSync(extractPath)) {
      try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch(e) {}
    }
    
    // =============================================
    // STEP 8: Send response
    // =============================================
    const uploadType = hasZip ? "ZIP + CSV" : "CSV only (with image URLs)";
    console.log(`📊 Preview Summary (${uploadType}): ${products.length} products, Valid: ${validProducts}, Invalid: ${invalidProducts}`);
    
    return res.status(200).json({
      success: true,
      message: "Preview generated successfully",
      uploadType: uploadType,
      summary: {
        totalRows: rows.length,
        totalProducts: products.length,
        validProducts: validProducts,
        invalidProducts: invalidProducts,
        totalVariants: totalVariants,
        totalProductsWithImages: products.filter(p => p.hasImages).length,
        totalImagesFound: totalImagesFound,
        missingImages: missingImagesCount,
        hasValidationErrors: invalidProducts > 0,
        hasMissingImages: missingImagesCount > 0
      },
      products: products,
      warning: invalidProducts > 0 
        ? `${invalidProducts} product(s) have validation errors. Please fix before uploading.` 
        : (missingImagesCount > 0 ? `${missingImagesCount} variant(s) missing images.` : null)
    });
    
  } catch (error) {
    console.error("Preview error:", error);
    
    // Cleanup on error
    if (csvPath && fs.existsSync(csvPath)) {
      try { fs.unlinkSync(csvPath); } catch(e) {}
    }
    if (zipPath && fs.existsSync(zipPath)) {
      try { fs.unlinkSync(zipPath); } catch(e) {}
    }
    if (extractPath && fs.existsSync(extractPath)) {
      try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch(e) {}
    }
    
    return res.status(500).json({
      success: false,
      message: "Failed to preview upload",
      error: error.message
    });
  }
};

const MAX_VARIANT_IMAGES = 5;

/**
 * Variant images on update:
 * - keptImages === null → neither variantKeptImages nor existingImages sent: new files replace entire set; no files → no image change.
 * - keptImages === []  → explicit clear (optional new files append after, still max 5).
 * - keptImages non-empty → ordered retain by publicId (must exist on variant) + append new uploads.
 * Admin FE sends kept list as `existingImages` (JSON) or `variantKeptImages` (parsed in parseVariantKeptArrayFromBody).
 *
 * Example: variant had 3 images; user keeps 1 in `existingImages` + uploads 3 new `variantImages`
 * → final list length = 1 + 3 = 4 (two removed DB images get Cloudinary cleanup after save).
 */
function normalizeImagePublicId(pid) {
  if (pid == null) return "";
  return String(pid).trim();
}

async function resolveVariantImagesForUpdate({
  existingImages,
  keptImages,
  newFiles,
  uploadPublicIdPrefix,
  productName
}) {
  const existing = Array.isArray(existingImages) ? existingImages : [];
  const existingByPid = new Map();
  for (const img of existing) {
    const pid = normalizeImagePublicId(img?.publicId ?? img?.public_id);
    if (pid) existingByPid.set(pid, img);
  }
  const newBuffers = (Array.isArray(newFiles) ? newFiles : []).filter((f) => f?.buffer);

  if (keptImages === null) {
    if (newBuffers.length === 0) {
      return { nextImages: null, removedPublicIds: [] };
    }
    const removedPublicIds = existing
      .map((img) => normalizeImagePublicId(img?.publicId ?? img?.public_id))
      .filter(Boolean);
    const nextImages = [];
    for (let i = 0; i < newBuffers.length; i++) {
      if (nextImages.length >= MAX_VARIANT_IMAGES) {
        throw new Error(`A variant can have at most ${MAX_VARIANT_IMAGES} images`);
      }
      const optimizedBuffer = await optimizeProductImageBuffer(newBuffers[i].buffer);
      const uploadResult = await uploadToCloudinary(
        optimizedBuffer,
        "products",
        `${uploadPublicIdPrefix}-img-${i}-${Date.now()}`
      );
      nextImages.push({
        url: uploadResult.url,
        publicId: uploadResult.publicId,
        altText: productName,
        order: nextImages.length
      });
    }
    return { nextImages, removedPublicIds };
  }

  if (!Array.isArray(keptImages)) {
    throw new Error("variantKeptImages must be a JSON array");
  }

  const nextImages = [];
  for (const item of keptImages) {
    const pid = normalizeImagePublicId(item?.publicId ?? item?.public_id);
    if (!pid || !existingByPid.has(pid)) {
      throw new Error(
        `existingImages/variantKeptImages: publicId not found on this variant (${pid || "missing"})`
      );
    }
    if (nextImages.length >= MAX_VARIANT_IMAGES) {
      throw new Error(`A variant can have at most ${MAX_VARIANT_IMAGES} images`);
    }
    const orig = existingByPid.get(pid);
    nextImages.push({
      url: orig.url,
      publicId: orig.publicId,
      altText: item.altText != null ? String(item.altText) : orig.altText || productName,
      order: nextImages.length
    });
  }

  for (let i = 0; i < newBuffers.length; i++) {
    if (nextImages.length >= MAX_VARIANT_IMAGES) {
      throw new Error(`A variant can have at most ${MAX_VARIANT_IMAGES} images`);
    }
    const optimizedBuffer = await optimizeProductImageBuffer(newBuffers[i].buffer);
    const uploadResult = await uploadToCloudinary(
      optimizedBuffer,
      "products",
      `${uploadPublicIdPrefix}-add-${i}-${Date.now()}`
    );
    nextImages.push({
      url: uploadResult.url,
      publicId: uploadResult.publicId,
      altText: productName,
      order: nextImages.length
    });
  }

  const keepSet = new Set(
    nextImages
      .map((x) => normalizeImagePublicId(x?.publicId ?? x?.public_id))
      .filter(Boolean)
  );
  const removedPublicIds = existing
    .map((img) => normalizeImagePublicId(img?.publicId ?? img?.public_id))
    .filter((pid) => pid && !keepSet.has(pid));

  return { nextImages, removedPublicIds };
}

function recomputeProductAggregates(doc) {
  const effectivePrices = doc.variants.map((v) =>
    v.price.sale != null ? v.price.sale : v.price.base
  );
  if (effectivePrices.length) {
    doc.priceRange = {
      min: Math.min(...effectivePrices),
      max: Math.max(...effectivePrices)
    };
  } else {
    doc.priceRange = { min: 0, max: 0 };
  }
  doc.totalStock = doc.variants.reduce(
    (sum, v) => sum + (v.inventory?.quantity || 0),
    0
  );
}

/**
 * Admin FE (adminEditProductSlice) sends:
 * - `existingImages` — JSON array of { url, publicId, altText?, order? } to KEEP (in order)
 * - `variantKeptImages` — same shape, preferred if both are sent
 * Returns hasKey=false when neither field is present → image merge defers to "new files only" behaviour.
 */
function parseVariantKeptArrayFromBody(updates) {
  const strictParseArray = (raw, label) => {
    if (raw === "" || raw == null) {
      return { ok: true, value: [] };
    }
    if (Array.isArray(raw)) {
      return { ok: true, value: raw };
    }
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) {
        return { ok: true, value: [] };
      }
      try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) {
          return { ok: false, message: `${label} must be a JSON array` };
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, message: `${label} must be valid JSON` };
      }
    }
    return { ok: false, message: `${label} must be a JSON array or stringified JSON array` };
  };

  const toKeptEntries = (items) =>
    [...items]
      .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
      .map((item) => ({
        publicId: item?.publicId || item?.public_id,
        altText: item?.altText
      }));

  if (Object.prototype.hasOwnProperty.call(updates, "variantKeptImages")) {
    const r = strictParseArray(updates.variantKeptImages, "variantKeptImages");
    if (!r.ok) {
      return { ok: false, message: r.message };
    }
    return { ok: true, hasKey: true, keptArray: toKeptEntries(r.value) };
  }

  if (Object.prototype.hasOwnProperty.call(updates, "existingImages")) {
    const r = strictParseArray(updates.existingImages, "existingImages");
    if (!r.ok) {
      return { ok: false, message: r.message };
    }
    return { ok: true, hasKey: true, keptArray: toKeptEntries(r.value) };
  }

  return { ok: true, hasKey: false, keptArray: null };
}

//update product or variant (single save: product + variant + partial images)
const updateProduct = async (req, res) => {
  try {
    const slug = req.params.slug;

    const doc = await Product.findOne({ slug });
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    const updates = { ...req.body };
    delete updates.slug;
    delete updates.sku;
    delete updates.variants;
    /** @type {Array<{ productId: unknown, variantId: unknown, productSlug?: string, productName?: string, variantSku?: string }>} */
    const restockNotifyEvents = [];

    const parseIfString = (value, fallback) => {
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return fallback;
        }
      }
      return value;
    };

    const targetCodeRaw =
      updates.productCode != null && String(updates.productCode).trim() !== ""
        ? updates.productCode
        : null;
    const targetProductCode = targetCodeRaw
      ? normalizeProductCode(String(targetCodeRaw))
      : null;

    let variantIndex = -1;
    if (targetProductCode) {
      variantIndex = doc.variants.findIndex(
        (v) => normalizeProductCode(v.productCode) === targetProductCode
      );
      if (variantIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "No variant found with this productCode on this product"
        });
      }
    }

    const variant =
      variantIndex >= 0 ? doc.variants[variantIndex] : null;
    const isVariantScopedUpdate = Boolean(targetProductCode);
    const isPrimaryVariantUpdate = variantIndex === 0;

    // -------- HSN / GST / fragile (product) --------
    if (updates.hsnCode !== undefined) {
      if (updates.hsnCode && String(updates.hsnCode).trim()) {
        const trimmedHsn = String(updates.hsnCode).trim().toUpperCase();
        if (trimmedHsn.length > 20) {
          return res.status(400).json({
            success: false,
            message: "HSN code cannot exceed 20 characters"
          });
        }
        doc.hsnCode = trimmedHsn;
      } else {
        doc.hsnCode = null;
      }
    }

    if (updates.gstRate !== undefined) {
      if (updates.gstRate !== null && updates.gstRate !== "") {
        const parsedgstRate = Number(updates.gstRate);
        if (isNaN(parsedgstRate) || parsedgstRate < 0) {
          return res.status(400).json({
            success: false,
            message: "Tax rate must be a valid number greater than or equal to 0"
          });
        }
        doc.gstRate = parsedgstRate;
      } else {
        doc.gstRate = null;
      }
    }

    if (updates.isFragile !== undefined) {
      doc.isFragile = parseBoolean(updates.isFragile);
    }

    // -------- Simple scalar / refs --------
    if (updates.description !== undefined) {
      doc.description = updates.description;
    }
    if (updates.title !== undefined) {
      doc.title = updates.title;
    }
    if (updates.brand !== undefined) {
      doc.brand = updates.brand;
    }
    if (updates.status !== undefined) {
      const normalizedStatus = normalizeLifecycleValue(updates.status) || 'draft';
      doc.status = normalizedStatus;
      doc.channelStatus = mergeProductChannelStatus(doc, {
        ecomm: normalizedStatus,
        wholesale: normalizedStatus
      });
      propagateProductChannelStatusToVariants(doc, {
        ecomm: normalizedStatus,
        wholesale: normalizedStatus
      });
      doc.markModified('channelStatus');
    }
    if (updates.channelStatus !== undefined) {
      const parsed = parseIfString(updates.channelStatus, {});
      doc.channelStatus = mergeProductChannelStatus(doc, parsed);
      propagateProductChannelStatusToVariants(doc, parsed);
      doc.markModified('channelStatus');
    }
    if (updates.isFeatured !== undefined) {
      doc.isFeatured =
        updates.isFeatured === true ||
        updates.isFeatured === "true" ||
        updates.isFeatured === 1;
    }
    if (updates.category !== undefined) {
      doc.category = updates.category;
    }

    if (updates.name !== undefined && updates.name !== doc.name) {
      doc.name = updates.name;
      doc.slug = await generateSlug(updates.name, doc._id);
      if (updates.title === undefined) {
        doc.title = updates.name;
      }
    }

    if (updates.soldInfo !== undefined) {
      const parsed = parseIfString(updates.soldInfo, {});
      doc.soldInfo = {
        ...doc.soldInfo.toObject(),
        ...parsed,
        enabled: parsed.enabled === true || parsed.enabled === "true",
        count: Number(parsed.count ?? 0)
      };
    }

    if (updates.fomo !== undefined) {
      const parsed = parseIfString(updates.fomo, {});
      doc.fomo = {
        ...doc.fomo.toObject(),
        ...parsed,
        enabled: parsed.enabled === true || parsed.enabled === "true",
        viewingNow: Number(parsed.viewingNow ?? 0),
        productLeft: Number(parsed.productLeft ?? 0),
        type: ["viewing_now", "product_left", "custom"].includes(parsed.type)
          ? parsed.type
          : doc.fomo.type
      };
    }

    if (updates.shipping !== undefined && isVariantScopedUpdate && variant && !isPrimaryVariantUpdate) {
      const parsedShipping = parseIfString(updates.shipping, {});
      const variantShipping = parseVariantShippingForStorage(parsedShipping);
      if (variantShipping) {
        variant.shipping = variantShipping;
      } else {
        variant.shipping = undefined;
      }
      doc.markModified("variants");
    } else if (updates.shipping !== undefined && !isVariantScopedUpdate) {
      const parsed = parseIfString(updates.shipping, {});
      doc.shipping = {
        ...(doc.shipping?.toObject ? doc.shipping.toObject() : {}),
        ...parsed,
        weight: Number(parsed.weight ?? 0),
        dimensions: {
          length: Number(parsed.dimensions?.length ?? 0),
          width: Number(parsed.dimensions?.width ?? 0),
          height: Number(parsed.dimensions?.height ?? 0)
        }
      };
    }

    // Enforce required shipping fields for product-level updates.
    // Variant-only updates use the same endpoint (targeted by productCode), so do not
    // block them unless shipping payload is explicitly being changed in that request.
    const shouldValidateShippingForRequest =
      !isVariantScopedUpdate || updates.shipping !== undefined;
    if (shouldValidateShippingForRequest) {
      if (isVariantScopedUpdate && updates.shipping !== undefined) {
        const variantShippingCheck = validateVariantsResolvableShipping(doc.shipping, doc.variants);
        if (!variantShippingCheck.valid) {
          return res.status(400).json({
            success: false,
            code: "VARIANT_SHIPPING_REQUIRED",
            message: variantShippingCheck.message
          });
        }
      } else {
        const updatedShippingValidation = validateRequiredShippingFields(doc.shipping);
        if (!updatedShippingValidation.valid) {
          return res.status(400).json({
            success: false,
            code: "SHIPPING_FIELDS_REQUIRED",
            message: updatedShippingValidation.message
          });
        }
        doc.shipping = updatedShippingValidation.shipping;
        const allVariantsCheck = validateVariantsResolvableShipping(doc.shipping, doc.variants);
        if (!allVariantsCheck.valid) {
          return res.status(400).json({
            success: false,
            code: "VARIANT_SHIPPING_REQUIRED",
            message: allVariantsCheck.message
          });
        }
      }
    }

    // Product-level attributes (skip when this request targets a variant and sends variant attrs in `attributes`)
    if (updates.attributes !== undefined && !targetProductCode) {
      const parsed = parseIfString(updates.attributes, []);
      doc.attributes = Array.isArray(parsed)
        ? parsed.filter((a) => a && a.key && a.value).map((a) => ({ key: a.key, value: a.value }))
        : [];
    }

    // -------- Variant-scoped fields (when productCode sent) --------
    const cloudIdsToDeleteAfterSave = [];

    if (variant) {
      if (updates.newProductCode !== undefined && String(updates.newProductCode).trim() !== "") {
        const newCode = normalizeProductCode(updates.newProductCode);
        const currentCode = normalizeProductCode(variant.productCode);
        if (newCode !== currentCode) {
          try {
            parseProductCodeParts(newCode, "newProductCode");
          } catch (e) {
            return res.status(400).json({ success: false, message: e.message });
          }
          const takenElsewhere = await Product.exists({
            _id: { $ne: doc._id },
            "variants.productCode": productCodeToDbQuery(newCode)
          });
          if (takenElsewhere) {
            return res.status(400).json({
              success: false,
              message: `productCode ${newCode} is already used by another product`
            });
          }
          const dupLocal = doc.variants.some(
            (v, i) => i !== variantIndex && normalizeProductCode(v.productCode) === newCode
          );
          if (dupLocal) {
            return res.status(400).json({
              success: false,
              message: `productCode ${newCode} already exists on this product`
            });
          }
          variant.productCode = newCode;
        }
      }

      if (updates.wholesale !== undefined) {
        variant.wholesale = parseBoolean(updates.wholesale);
      }

      if (updates.minimumOrderQuantity !== undefined) {
        const moq = Number(updates.minimumOrderQuantity);
        if (isNaN(moq) || moq < 1) {
          return res.status(400).json({
            success: false,
            message: "minimumOrderQuantity must be a number >= 1"
          });
        }
        variant.minimumOrderQuantity = moq;
      }

      const activeFlag =
        updates.variantIsActive !== undefined ? updates.variantIsActive : updates.isActive;
      if (activeFlag !== undefined) {
        variant.isActive = parseBoolean(activeFlag);
        variant.channelVisibility = mergeVariantChannelVisibility(variant, {
          ecomm: variant.isActive ? 'active' : 'draft'
        });
        doc.markModified('variants');
      }

      if (updates.channelVisibility !== undefined) {
        const parsed = parseIfString(updates.channelVisibility, {});
        if (
          parsed?.wholesale === "active" &&
          !hasWholesalePricingConfig(variant)
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Cannot set wholesale visibility active for this variant. Set wholesale=true and wholesaleBase (>0) first."
          });
        }
        variant.channelVisibility = mergeVariantChannelVisibility(variant, parsed);
        doc.markModified("variants");
      }

      if (updates.attributes !== undefined) {
        const parsed = parseIfString(updates.attributes, []);
        variant.attributes = Array.isArray(parsed)
          ? parsed.filter((a) => a && a.key && a.value).map((a) => ({ key: a.key, value: a.value }))
          : [];
      }

      if (updates.variantAttributes !== undefined) {
        const parsed = parseIfString(updates.variantAttributes, []);
        variant.attributes = Array.isArray(parsed)
          ? parsed.filter((a) => a && a.key && a.value).map((a) => ({ key: a.key, value: a.value }))
          : [];
      }

      if (updates.price !== undefined) {
        const parsedPrice = parseIfString(updates.price, {});
        const base =
          parsedPrice.base !== undefined
            ? Number(parsedPrice.base)
            : variant.price.base;
        const sale =
          parsedPrice.sale !== undefined
            ? parsedPrice.sale != null
              ? Number(parsedPrice.sale)
              : null
            : variant.price.sale;

        if (isNaN(base) || base <= 0) {
          return res.status(400).json({
            success: false,
            message: "Variant base price must be a number greater than 0"
          });
        }
        if (sale != null && (isNaN(sale) || sale >= base)) {
          return res.status(400).json({
            success: false,
            message: "Sale price must be less than base price"
          });
        }

        variant.price.base = base;
        variant.price.sale = sale;

        if (parsedPrice.wholesaleBase !== undefined) {
          variant.price.wholesaleBase =
            parsedPrice.wholesaleBase != null ? Number(parsedPrice.wholesaleBase) : null;
        }
        if (parsedPrice.wholesaleSale !== undefined) {
          variant.price.wholesaleSale =
            parsedPrice.wholesaleSale != null ? Number(parsedPrice.wholesaleSale) : null;
        }
      }

      if (updates.inventory !== undefined) {
        const parsedInventory = parseIfString(updates.inventory, {});
        if (parsedInventory.quantity !== undefined) {
          const prevQty = Number(variant.inventory?.quantity || 0);
          const nextQty = Number(parsedInventory.quantity);
          const trackInventory = parsedInventory.trackInventory !== undefined
            ? parsedInventory.trackInventory
            : variant.inventory?.trackInventory;
          try {
            const { isRestockTransition } = require('../services/oosRestockNotify.service');
            if (isRestockTransition(prevQty, nextQty, trackInventory !== false)) {
              restockNotifyEvents.push({
                productId: doc._id,
                variantId: variant._id,
                productSlug: doc.slug,
                productName: doc.name,
                variantSku: variant.sku || null,
              });
            }
          } catch (_) {
            /* notify helper optional at boot */
          }
          variant.inventory.quantity = nextQty;
        }
        if (parsedInventory.lowStockThreshold !== undefined) {
          variant.inventory.lowStockThreshold = Number(parsedInventory.lowStockThreshold);
        }
        if (parsedInventory.trackInventory !== undefined) {
          variant.inventory.trackInventory = parsedInventory.trackInventory;
        }
      }

      if (!isPrimaryVariantUpdate && updates.variantTitle !== undefined) {
        const nextTitle = parseVariantTextForStorage(updates.variantTitle);
        if (nextTitle) variant.title = nextTitle;
        else variant.title = undefined;
        doc.markModified("variants");
      }

      if (!isPrimaryVariantUpdate && updates.variantDescription !== undefined) {
        const nextDescription = parseVariantTextForStorage(updates.variantDescription);
        if (nextDescription) variant.description = nextDescription;
        else variant.description = undefined;
        doc.markModified("variants");
      }

      if (isPrimaryVariantUpdate) {
        applyVariantCatalogFieldsToTarget(variant, {}, { isPrimary: true });
        doc.markModified("variants");
      }

      if (variant.wholesale) {
        const wb = variant.price?.wholesaleBase;
        if (wb == null || isNaN(Number(wb)) || Number(wb) <= 0) {
          return res.status(400).json({
            success: false,
            message: "wholesaleBase is required and must be > 0 when wholesale is true"
          });
        }
        const ws = variant.price?.wholesaleSale;
        if (ws != null && Number(ws) >= Number(wb)) {
          return res.status(400).json({
            success: false,
            message: "Wholesale sale price must be less than wholesale base price"
          });
        }
      }

      const keptRes = parseVariantKeptArrayFromBody(updates);
      if (!keptRes.ok) {
        return res.status(400).json({
          success: false,
          message: keptRes.message
        });
      }
      const hasKeptKey = keptRes.hasKey;
      const keptArray = keptRes.keptArray;

      const files = (Array.isArray(req.files) ? req.files : []).filter(
        (f) =>
          f?.buffer &&
          (!f.fieldname ||
            f.fieldname === "variantImages" ||
            /^variantImages_/i.test(String(f.fieldname)))
      );
      try {
        const { nextImages, removedPublicIds } = await resolveVariantImagesForUpdate({
          existingImages: variant.images,
          keptImages: hasKeptKey ? keptArray : null,
          newFiles: files,
          uploadPublicIdPrefix: `${doc.slug}-v-${normalizeProductCode(variant.productCode)}`,
          productName: doc.name
        });
        if (nextImages !== null) {
          cloudIdsToDeleteAfterSave.push(...removedPublicIds);
          variant.images = nextImages;
        }
      } catch (imgErr) {
        return res.status(400).json({
          success: false,
          message: imgErr.message || "Invalid variant image payload"
        });
      }

      doc.markModified("variants");
    }

    // -------- SEO (single pass; uses latest in-memory doc) --------
    const seoCategoryId = updates.category !== undefined ? updates.category : doc.category;
    const categoryDoc = await Category.findById(seoCategoryId).lean();

    const shouldRefreshSeo =
      updates.name !== undefined ||
      updates.description !== undefined ||
      updates.hsnCode !== undefined ||
      updates.gstRate !== undefined ||
      updates.category !== undefined ||
      variantIndex >= 0;

    if (shouldRefreshSeo) {
      const productDataForSEO = {
        name: doc.name,
        description: doc.description,
        category: categoryDoc ? { name: categoryDoc.name } : null,
        variants: doc.variants,
        hsnCode: doc.hsnCode,
        gstRate: doc.gstRate
      };
      doc.seo = generateSEOData(productDataForSEO);
    }

    if (
      doc.channelStatus?.wholesale === "active" &&
      !hasWholesalePricingEligibleVariant(doc)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Wholesale storefront is active but no eligible wholesale variant is available. Add/update at least one variant with wholesale=true and wholesaleBase > 0."
      });
    }

    recomputeProductAggregates(doc);
    reconcileProductCatalogState(doc);

    await doc.save({ validateBeforeSave: true });

    for (const pid of cloudIdsToDeleteAfterSave) {
      await deleteFromCloudinary(pid);
    }

    await invalidateProductCaches(doc.slug);
    const warnings = collectWholesaleInventoryWarnings(doc.variants);

    if (restockNotifyEvents.length) {
      try {
        const { scheduleRestockNotifications } = require('../services/oosRestockNotify.service');
        scheduleRestockNotifications(restockNotifyEvents);
      } catch (notifyErr) {
        console.warn('[updateProduct] restock notify schedule failed', notifyErr?.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Product updated successfully",
      product: doc,
      warnings
    });
  } catch (error) {
    console.error("Update product error:", error);

    return res.status(500).json({
      success: false,
      message: "Error updating product",
      error: error.message
    });
  }
};


const deleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOneAndUpdate(
      { slug, status: { $ne: "archived" } },
      {
        $set: {
          status: "archived",
          // Storefront list filters primarily on per-channel lifecycle; without
          // this, channelStatus can stay "active" and Redis-cached lists still
          // match the product even though legacy status is archived.
          "channelStatus.ecomm": "archived",
          "channelStatus.wholesale": "archived",
          archivedAt: new Date()
        }
      },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found or already archived"
      });
    }
  
    await invalidateProductCaches(slug);

    return res.status(200).json({
      success: true,
      message: "Product archived successfully",
      product
    });

  } catch (error) {
    console.error("Archive product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error archiving product",
      error: error.message
    });
  }
};

// Bulk delete (archive multiple)
// Bulk archive products
const bulkDelete = async (req, res) => {
  try {
    let { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array is required"
      });
    }

    // Sanitize slugs (remove invalid values)
    slugs = slugs
      .filter(slug => typeof slug === "string" && slug.trim() !== "")
      .map(slug => slug.trim());

    if (slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid slugs provided"
      });
    }

    // Optional: Protect from huge requests
    if (slugs.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Maximum 500 products allowed per request"
      });
    }

    const result = await Product.updateMany(
      {
        slug: { $in: slugs },
        status: { $ne: "archived" }
      },
      {
        $set: {
          status: "archived",
          "channelStatus.ecomm": "archived",
          "channelStatus.wholesale": "archived",
          archivedAt: new Date()
        }
      }
    );

      await invalidateAllProductCaches();

    return res.status(200).json({
      success: true,
      message: "Bulk archive completed",
      requested: slugs.length,
      archived: result.modifiedCount,
      skipped: slugs.length - result.modifiedCount
    });

  } catch (error) {
    console.error("Bulk archive error:", error);
    return res.status(500).json({
      success: false,
      message: "Error archiving products",
      error: error.message
    });
  }
};

// Restore archived product
// Restore archived product
const restoreProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOneAndUpdate(
      { slug, status: "archived" },
      {
        $set: { status: "active" }, // or your default restore status
        $unset: { archivedAt: "" }
      },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Archived product not found"
      });
    }

       // ✅ INVALIDATE ALL PRODUCT CACHES
    await invalidateProductCaches(slug);

    return res.status(200).json({
      success: true,
      message: "Product restored successfully",
      product
    });

  } catch (error) {
    console.error("Restore product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error restoring product",
      error: error.message
    });
  }
};


// Bulk restore archived products
// Bulk restore archived products
const bulkRestore = async (req, res) => {
  try {
    let { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array is required"
      });
    }

    // Sanitize slugs
    slugs = slugs
      .filter(slug => typeof slug === "string" && slug.trim() !== "")
      .map(slug => slug.trim());

    if (slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid slugs provided"
      });
    }

    // Optional protection
    if (slugs.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Maximum 500 products allowed per request"
      });
    }

    const result = await Product.updateMany(
      {
        slug: { $in: slugs },
        status: "archived"
      },
      {
        $set: { status: "active" }, // or your default restore status
        $unset: { archivedAt: "" }
      }
    );


    // ✅ ADD THIS - Invalidate caches after bulk restore
    await invalidateAllProductCaches(); 
    
    return res.status(200).json({
      success: true,
      message: "Bulk restore completed",
      requested: slugs.length,
      restored: result.modifiedCount,
      skipped: slugs.length - result.modifiedCount
    });

  } catch (error) {
    console.error("Bulk restore error:", error);
    return res.status(500).json({
      success: false,
      message: "Error restoring products",
      error: error.message
    });
  }
};

const ALLOWED_PRODUCT_STATUSES = ['draft', 'active', 'archived'];
const STOREFRONT_KEYS = ['ecomm', 'wholesale'];

function normalizeLifecycleValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_PRODUCT_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeOptionalLifecycleMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const storefront of STOREFRONT_KEYS) {
    const parsed = normalizeLifecycleValue(input[storefront]);
    if (parsed) out[storefront] = parsed;
  }
  return out;
}

function normalizeLifecycleFromRowStatus(statusValue, fallback = 'active') {
  const normalized = String(statusValue || '').trim().toLowerCase();
  if (ALLOWED_PRODUCT_STATUSES.includes(normalized)) return normalized;
  return fallback;
}

function buildChannelVisibilityFromCsvRow(row, wholesaleEligible) {
  const ecommLifecycle = normalizeLifecycleFromRowStatus(row?.status, 'active');
  return {
    ecomm: ecommLifecycle,
    wholesale: wholesaleEligible ? 'active' : 'draft'
  };
}

function parseWholesaleConfigForImportRow(row) {
  const wholesaleRequested = parseBoolean(row?.wholesale);
  let wholesaleBase = null;
  let wholesaleSale = null;
  let minimumOrderQuantity = 1;
  const warnings = [];

  if (!wholesaleRequested) {
    return {
      wholesale: false,
      wholesaleBase,
      wholesaleSale,
      minimumOrderQuantity,
      wholesaleEligible: false,
      warnings
    };
  }

  const rawWholesaleBase = String(row?.wholesaleBase || '').trim();
  const parsedWholesaleBase = rawWholesaleBase
    ? Number(rawWholesaleBase.replace(/[^0-9.]/g, ''))
    : NaN;

  if (!Number.isFinite(parsedWholesaleBase) || parsedWholesaleBase <= 0) {
    wholesaleBase = 0;
    warnings.push(
      'wholesale=true but wholesaleBase is missing/invalid; wholesale visibility forced to draft for this variant.'
    );
  } else {
    wholesaleBase = parsedWholesaleBase;
  }

  const rawWholesaleSale = String(row?.wholesaleSale || '').trim();
  if (rawWholesaleSale) {
    const parsedWholesaleSale = Number(rawWholesaleSale.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsedWholesaleSale) || parsedWholesaleSale <= 0) {
      warnings.push(`Invalid wholesaleSale ignored: ${row.wholesaleSale}`);
    } else if (wholesaleBase > 0 && parsedWholesaleSale >= wholesaleBase) {
      warnings.push(
        `wholesaleSale (${parsedWholesaleSale}) must be less than wholesaleBase (${wholesaleBase}); wholesaleSale ignored.`
      );
    } else {
      wholesaleSale = parsedWholesaleSale;
    }
  }

  const parsedMoq = Number(row?.minimumOrderQuantity);
  if (Number.isFinite(parsedMoq) && parsedMoq >= 1) {
    minimumOrderQuantity = parsedMoq;
  } else if (String(row?.minimumOrderQuantity || '').trim()) {
    warnings.push('minimumOrderQuantity invalid; defaulting to 1');
  }

  const wholesaleEligible = wholesaleRequested && wholesaleBase > 0;
  return {
    wholesale: wholesaleRequested,
    wholesaleBase,
    wholesaleSale,
    minimumOrderQuantity,
    wholesaleEligible,
    warnings
  };
}

/**
 * Bulk set lifecycle status for many products (admin list multi-select).
 * - active: visible on storefront (same as restore flow)
 * - draft: hidden, not deleted
 * - archived: soft-delete (sets archivedAt like bulk archive)
 */
const bulkUpdateProductStatus = async (req, res) => {
  try {
    const { status, channelStatus, slugs: rawSlugs } = req.body || {};
    const normalizedLegacyStatus = normalizeLifecycleValue(status);
    const normalizedChannelStatus = normalizeOptionalLifecycleMap(channelStatus);
    const hasLegacyStatus = Boolean(normalizedLegacyStatus);
    const hasChannelStatus = Object.keys(normalizedChannelStatus).length > 0;

    if (!hasLegacyStatus && !hasChannelStatus) {
      return res.status(400).json({
        success: false,
        message: `Provide either "status" or "channelStatus" with values in: ${ALLOWED_PRODUCT_STATUSES.join(', ')}`
      });
    }

    if (!Array.isArray(rawSlugs) || rawSlugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'slugs must be a non-empty array of product slugs'
      });
    }

    const slugs = rawSlugs
      .filter((s) => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim());

    if (slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid slugs provided'
      });
    }

    if (slugs.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 500 products per request'
      });
    }

    const existing = await Product.find({ slug: { $in: slugs } });
    const foundSet = new Set(existing.map((p) => p.slug));
    const notFoundSlugs = slugs.filter((s) => !foundSet.has(s));

    const skipped = [];
    const updatedSlugs = [];
    const now = new Date();

    for (const doc of existing) {
      const currentChannelStatus = {
        ...(doc.channelStatus && doc.channelStatus.toObject
          ? doc.channelStatus.toObject()
          : doc.channelStatus || {})
      };
      const nextChannelStatus = {
        ...currentChannelStatus,
        ...normalizedChannelStatus
      };

      // Backward compatibility: legacy `status` can still drive both channels in bulk.
      if (hasLegacyStatus) {
        nextChannelStatus.ecomm = normalizedLegacyStatus;
        nextChannelStatus.wholesale = normalizedLegacyStatus;
      }

      if (
        nextChannelStatus.wholesale === 'active' &&
        !hasWholesalePricingEligibleVariant(doc)
      ) {
        skipped.push({
          slug: doc.slug,
          name: doc.name,
          reasonCode: 'WHOLESALE_ELIGIBILITY_MISSING',
          reason:
            'Wholesale activation skipped: no variant has wholesale=true and wholesaleBase > 0.'
        });
        continue;
      }

      const propagatePartial = {};
      if (hasLegacyStatus) {
        propagatePartial.ecomm = normalizedLegacyStatus;
        propagatePartial.wholesale = normalizedLegacyStatus;
      } else {
        if (normalizedChannelStatus.ecomm != null) propagatePartial.ecomm = normalizedChannelStatus.ecomm;
        if (normalizedChannelStatus.wholesale != null) {
          propagatePartial.wholesale = normalizedChannelStatus.wholesale;
        }
      }

      doc.channelStatus = nextChannelStatus;
      propagateProductChannelStatusToVariants(doc, propagatePartial);
      reconcileProductCatalogState(doc);

      if (
        nextChannelStatus.ecomm === 'archived' &&
        nextChannelStatus.wholesale === 'archived'
      ) {
        doc.archivedAt = now;
      } else if (hasLegacyStatus && normalizedLegacyStatus !== 'archived') {
        doc.archivedAt = null;
      }

      await doc.save({ validateBeforeSave: true });
      updatedSlugs.push(doc.slug);
    }

    const modifiedCount = updatedSlugs.length;

    await invalidateAllProductCaches();

    return res.status(200).json({
      success: true,
      message:
        modifiedCount > 0
          ? `Bulk channel status update completed. Updated: ${modifiedCount}, skipped: ${skipped.length}.`
          : `No products were updated. Skipped: ${skipped.length}.`,
      status: hasLegacyStatus ? normalizedLegacyStatus : null,
      channelStatus: hasChannelStatus || hasLegacyStatus
        ? {
            ecomm: hasLegacyStatus ? normalizedLegacyStatus : normalizedChannelStatus.ecomm || null,
            wholesale: hasLegacyStatus ? normalizedLegacyStatus : normalizedChannelStatus.wholesale || null
          }
        : null,
      requested: slugs.length,
      matched: existing.length,
      modified: modifiedCount,
      updatedCount: modifiedCount,
      skippedCount: skipped.length,
      skippedProducts: skipped,
      updatedProducts: existing
        .filter((p) => updatedSlugs.includes(p.slug))
        .map((p) => ({ slug: p.slug, name: p.name })),
      unchanged: Math.max(existing.length - modifiedCount - skipped.length, 0),
      notFoundSlugs,
      notFoundCount: notFoundSlugs.length
    });
  } catch (error) {
    console.error('bulkUpdateProductStatus:', error);
    return res.status(500).json({
      success: false,
      message: 'Error updating product statuses',
      error: error.message
    });
  }
};

const updateVariantChannelVisibility = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    const productCode = normalizeProductCode(req.params.productCode);
    const requested = normalizeOptionalLifecycleMap(req.body?.channelVisibility);

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: 'Product slug is required'
      });
    }
    if (!productCode) {
      return res.status(400).json({
        success: false,
        message: 'Variant productCode is required'
      });
    }
    if (Object.keys(requested).length === 0) {
      return res.status(400).json({
        success: false,
        message: `channelVisibility must include at least one of: ${STOREFRONT_KEYS.join(', ')}`
      });
    }

    const doc = await Product.findOne({ slug });
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const variantIndex = doc.variants.findIndex(
      (v) => normalizeProductCode(v.productCode) === productCode
    );
    if (variantIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Variant not found for provided productCode'
      });
    }

    const variant = doc.variants[variantIndex];
    if (
      requested.wholesale === 'active' &&
      !hasWholesalePricingConfig(variant)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Cannot set wholesale visibility active for this variant. Set wholesale=true and wholesaleBase (>0) first.'
      });
    }

    variant.channelVisibility = mergeVariantChannelVisibility(variant, requested);
    doc.markModified('variants');
    reconcileProductCatalogState(doc);

    // After visibility change + reconcile: product wholesale active only if
    // at least one variant remains pricing-eligible and wholesale-visible.
    if (
      doc.channelStatus?.wholesale === 'active' &&
      !hasActiveWholesaleVariantForCatalog(doc)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Wholesale storefront remains active only when at least one variant is wholesale-eligible (wholesale=true, wholesaleBase>0) and wholesale-visible.'
      });
    }

    await doc.save({ validateBeforeSave: true });
    await invalidateProductCaches(doc.slug);

    return res.status(200).json({
      success: true,
      message: 'Variant channel visibility updated successfully',
      product: {
        slug: doc.slug,
        name: doc.name
      },
      variant: {
        productCode: variant.productCode,
        channelVisibility: variant.channelVisibility
      }
    });
  } catch (error) {
    console.error('updateVariantChannelVisibility:', error);
    return res.status(500).json({
      success: false,
      message: 'Error updating variant channel visibility',
      error: error.message
    });
  }
};

// Get low stock products
// Get low stock products
const getLowStockProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = {
      status: "active",
      $expr: {
        $anyElementTrue: {
          $map: {
            input: "$variants",
            as: "variant",
            in: {
              $and: [
                { $eq: ["$$variant.inventory.trackInventory", true] },
                {
                  $lte: [
                    "$$variant.inventory.quantity",
                    "$$variant.inventory.lowStockThreshold"
                  ]
                }
              ]
            }
          }
        }
      }
    };

    const [products, total] = await Promise.all([
      Product.find(query)
        .sort({ "variants.inventory.quantity": 1 })
        .skip(skip)
        .limit(limitNumber),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Low stock products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching low stock products",
      error: error.message
    });
  }
};

//get all the products
// Get all active products (paginated)
const getAllActiveProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "active" };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Get all products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching products",
      error: error.message
    });
  }
};


//get single product by slug
// Get single product by slug
const getProductBySlug = async (req, res) => {
  try {
    const slug = req.params.slug?.trim();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Invalid product slug"
      });
    }

    const product = await Product.findOne({
      slug,
      status: "active"
    })
      .populate("category", "name")
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }
             // =============================
        // ✅ FALLBACK: If no SEO data, generate on the fly
        // =============================
        if (!product.seo || !product.seo.meta_title) {
            const seoData = generateSEOData({
                name: product.name,
                description: product.description,
                category: product.category,
                variants: product.variants
            });
            product.seo = seoData;
            
            // Optionally update in database for next time
            await Product.updateOne(
                { _id: product._id },
                { $set: { seo: seoData } }
            );
        }
    return res.status(200).json({
      success: true,
      product
    });

  } catch (error) {
    console.error("Get product by slug error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching product",
      error: error.message
    });
  }
};

//get products with only archived status
// Get archived products (paginated)
const getArchivedProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "archived" };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Get archived products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching archived products",
      error: error.message
    });
  }
};


//get products with only draft status
// Get draft products (paginated)
const getDraftProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "draft" };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Get draft products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching draft products",
      error: error.message
    });
  }
};


// Hard delete (permanently delete archived product)
const hardDeleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Invalid product slug"
      });
    }

    const product = await Product.findOne({ slug }).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    if (product.status !== "archived") {
      return res.status(400).json({
        success: false,
        message: "Only archived products can be permanently deleted"
      });
    }

    const publicIds = [];

    if (Array.isArray(product.images)) {
      product.images.forEach(img => {
        if (img.publicId) publicIds.push(img.publicId);
      });
    }

    if (Array.isArray(product.variants)) {
      product.variants.forEach(variant => {
        if (Array.isArray(variant.images)) {
          variant.images.forEach(img => {
            if (img.publicId) publicIds.push(img.publicId);
          });
        }
      });
    }

    const uniquePublicIds = [...new Set(publicIds)];

    await Promise.all(
      uniquePublicIds.map(async (id) => {
        try {
          await deleteFromCloudinary(id);
        } catch (err) {
          console.error("Cloudinary delete failed:", id);
        }
      })
    );

    await Product.deleteOne({ _id: product._id });

    await invalidateProductCaches(slug);

    return res.status(200).json({
      success: true,
      message: "Product permanently deleted"
    });

  } catch (error) {
    console.error("Hard delete product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error permanently deleting product",
      error: error.message
    });
  }
};
// Bulk hard delete (permanently delete multiple archived products)
// Bulk hard delete (permanently delete multiple archived products)
const bulkHardDelete = async (req, res) => {
  try {
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array is required"
      });
    }

    // ==========================================
    // 1️⃣ Fetch only archived products (lean)
    // ==========================================
    const products = await Product.find({
      slug: { $in: slugs },
      status: "archived"
    }).lean();

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No archived products found to delete"
      });
    }

    const productIds = products.map(p => p._id);

    // ==========================================
    // 2️⃣ Collect ALL publicIds first
    // ==========================================
    const publicIds = [];

    for (const product of products) {
      if (Array.isArray(product.images)) {
        for (const img of product.images) {
          if (img.publicId) {
            publicIds.push(img.publicId);
          }
        }
      }

      if (Array.isArray(product.variants)) {
        for (const variant of product.variants) {
          if (Array.isArray(variant.images)) {
            for (const img of variant.images) {
              if (img.publicId) {
                publicIds.push(img.publicId);
              }
            }
          }
        }
      }
    }

    // ==========================================
    // 3️⃣ Delete images in parallel (SAFE)
    // ==========================================
    if (publicIds.length > 0) {
      await Promise.allSettled(
        publicIds.map(id => deleteFromCloudinary(id))
      );
    }

    // ==========================================
    // 4️⃣ Delete from DB
    // ==========================================
    const deleteResult = await Product.deleteMany({
      _id: { $in: productIds }
    });

    await invalidateAllProductCaches();

    return res.status(200).json({
      success: true,
      message: "Products permanently deleted",
      requested: slugs.length,
      deletedCount: deleteResult.deletedCount,
      skipped: slugs.length - deleteResult.deletedCount
    });

  } catch (error) {
    console.error("Bulk hard delete error:", error);
    return res.status(500).json({
      success: false,
      message: "Error permanently deleting products",
      error: error.message
    });
  }
};

const getAllProductsAdmin = async (req, res) => {
  try {
    let { page = 1, limit = 20, search = "" } = req.query;

    page = Number(page);
    limit = Math.min(100, Math.max(1, Number(limit)));

    const skip = (page - 1) * limit;

    const trimmedSearch = String(search || "").trim().slice(0, 100);
    const searchFilter = trimmedSearch
      ? {
          $or: [
            { name: { $regex: escapeRegex(trimmedSearch), $options: "i" } },
            { title: { $regex: escapeRegex(trimmedSearch), $options: "i" } },
            { brand: { $regex: escapeRegex(trimmedSearch), $options: "i" } },
            { "variants.productCode": { $regex: escapeRegex(trimmedSearch), $options: "i" } },
          ],
        }
      : {};

    const [products, totalProducts] = await Promise.all([
      Product.find(searchFilter)
        .populate("category", "name slug status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),

      Product.countDocuments(searchFilter),
    ]);

    // get ids
    const productIds = products.map((p) => p._id);

    // fetch tags
    const productTags = await ProductTag.find({
      product: { $in: productIds },
    }).lean();

    // make tag map
    const tagMap = {};
    productTags.forEach((item) => {
      tagMap[item.product.toString()] = item.tags || [];
    });

    // merge tags + variants availability
    const finalProducts = products.map((product) => {
      const variants = Array.isArray(product.variants) ? product.variants : [];

      return {
        ...product,
        tags: tagMap[product._id.toString()] || [],
        variants: variants.map((variant) => ({
          ...variant,
          availability: getVariantAvailabilityByStorefront(variant),
        })),
      };
    });

    return res.status(200).json({
      success: true,
      totalProducts,
      totalPages: Math.ceil(totalProducts / limit),
      currentPage: page,
      products: finalProducts, // <- THIS
    });
  } catch (error) {
    console.error("Get all products error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching products",
      error: error.message,
    });
  }
};



//Add variant to existing product
// Add variant to existing product
const addVariant = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    // =========================
    // Parse body safely - SAME as updateProduct
    // =========================
    let variant = { ...req.body };

    // Helper function to parse JSON strings (same as updateProduct)
    const parseIfString = (value, fallback) => {
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return fallback;
        }
      }
      return value;
    };

    // Parse all potential JSON fields (same as updateProduct)
    if (variant.price) {
      variant.price = parseIfString(variant.price, {});
    }

    if (variant.attributes) {
      variant.attributes = parseIfString(variant.attributes, []);
    }

    if (variant.inventory) {
      variant.inventory = parseIfString(variant.inventory, {});
    }

    // =========================
    // 🔒 productCode VALIDATION
    // =========================
    if (!variant.productCode) {
      return res.status(400).json({
        success: false,
        message: "productCode is required"
      });
    }

    let productCodeNormalized;
    let incomingCodeParts;
    try {
      productCodeNormalized = normalizeProductCode(variant.productCode);
      incomingCodeParts = parseProductCodeParts(productCodeNormalized, "variant.productCode", { requireSuffix: true });
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: e.message || "Invalid productCode"
      });
    }

    // Enforce same base and next sequence for this product's variant series.
    const existingCodes = Array.isArray(product.variants)
      ? product.variants
          .map((v) => normalizeProductCode(v?.productCode))
          .filter(Boolean)
      : [];

    const parsedExisting = existingCodes.map((code) => {
      try {
        return parseProductCodeParts(code, "existing productCode");
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (parsedExisting.length > 0) {
      const base = parsedExisting[0].base;
      if (incomingCodeParts.base !== base) {
        const maxSeq = Math.max(...parsedExisting.map((p) => deriveSequenceNumberFromParsedCode(p)));
        const nextCode = `${base}-${formatSequenceSuffix(maxSeq + 1)}`;
        return res.status(400).json({
          success: false,
          message: `productCode base mismatch for this product. Expected base ${base}-N. Use next code ${nextCode}.`
        });
      }

      const usedSequences = new Set(parsedExisting.map((p) => deriveSequenceNumberFromParsedCode(p)));
      const maxSeq = Math.max(...usedSequences);
      const expectedSeq = maxSeq + 1;
      const expectedCode = `${base}-${formatSequenceSuffix(expectedSeq)}`;

      if (incomingCodeParts.sequence !== expectedSeq || usedSequences.has(incomingCodeParts.sequence)) {
        return res.status(400).json({
          success: false,
          message: `Invalid next productCode for this product. Use ${expectedCode}.`
        });
      }
    }

    // 🔒 Global duplicate check
    const productCodeExists = await Product.exists({
      "variants.productCode": productCodeToDbQuery(productCodeNormalized)
    });

    if (productCodeExists) {
      return res.status(400).json({
        success: false,
        message: "Variant with this productCode already exists"
      });
    }

    // =========================
    // 🔒 PRICE VALIDATION - Now works because price is parsed
    // =========================
    if (!variant.price?.base) {
      return res.status(400).json({
        success: false,
        message: "Base price is required"
      });
    }

    const basePrice = Number(variant.price.base);
    if (isNaN(basePrice) || basePrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Base price must be a valid number greater than 0"
      });
    }

    const salePrice = variant.price.sale != null
      ? Number(variant.price.sale)
      : null;

    if (salePrice !== null && (isNaN(salePrice) || salePrice >= basePrice)) {
      return res.status(400).json({
        success: false,
        message: "Sale price must be a valid number less than base price"
      });
    }

    // =========================
    // 🔥 AUTO GENERATE SKU
    // =========================
    const skuVal = await generateSku();

    // =========================
    // 📸 IMAGE UPLOAD
    // =========================
    let uploadedImages = [];

    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        if (!file.buffer) continue;

        const optimizedBuffer = await optimizeProductImageBuffer(file.buffer);
        const uploadResult = await uploadToCloudinary(
          optimizedBuffer,
          "products",
          `${slug}-v-${productCodeNormalized}-img-${i}-${Date.now()}`
        );

        uploadedImages.push({
          url: uploadResult.url,
          publicId: uploadResult.publicId,
          altText: product.name,
          order: i
        });
      }
    }

const newVariant = {
  sku: skuVal,
  productCode: productCodeNormalized,

  wholesale: variant.wholesale === "true" || variant.wholesale === true,

  attributes: Array.isArray(variant.attributes)
    ? variant.attributes
        .filter(a => a.key && a.value)
        .map(a => ({
          key: a.key,
          value: a.value
        }))
    : [],

  price: {
    base: basePrice,
    sale: salePrice,
    wholesaleBase: variant.price.wholesaleBase
      ? Number(variant.price.wholesaleBase)
      : null,
    wholesaleSale: null
  },

  inventory: {
    quantity: Number(variant.inventory?.quantity || 0),
    lowStockThreshold: Number(variant.inventory?.lowStockThreshold || 5),
    trackInventory: variant.inventory?.trackInventory !== false
  },

  images: uploadedImages,

  isActive: variant.isActive !== false
};

    if (variant.shipping) {
      variant.shipping = parseIfString(variant.shipping, variant.shipping);
    }
    applyVariantCatalogFieldsToTarget(newVariant, {
      title: variant.variantTitle ?? variant.title,
      description: variant.variantDescription ?? variant.description,
      shipping: variant.shipping
    });

    const resolvable = validateVariantsResolvableShipping(product.shipping, [
      ...product.variants,
      newVariant
    ]);
    if (!resolvable.valid) {
      return res.status(400).json({
        success: false,
        code: "VARIANT_SHIPPING_REQUIRED",
        message: resolvable.message
      });
    }

    product.variants.push(newVariant);

    // =========================
    // 🔁 RECALCULATE TOTALS
    // =========================
    const effectivePrices = product.variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    product.priceRange = {
      min: Math.min(...effectivePrices),
      max: Math.max(...effectivePrices)
    };

    product.totalStock = product.variants.reduce(
      (sum, v) => sum + (v.inventory.quantity || 0),
      0
    );

    await product.save();

       // ✅ INVALIDATE ALL PRODUCT CACHES
    await invalidateProductCaches(product.slug);
    const warnings = collectWholesaleInventoryWarnings([newVariant]);

    return res.status(200).json({
      success: true,
      message: "Variant added successfully",
      product,
      warnings
    });

  } catch (error) {
    console.error("Add variant error:", error);

    return res.status(500).json({
      success: false,
      message: "Error adding variant",
      error: error.message
    });
  }
};

//delete variant from existing product
//Add variant to existing product
// Add variant to existing product
// Delete variant from existing product
const deleteVariant = async (req, res) => {
  try {
    const { slug } = req.params;
    const rawCode = req.body.productCode;

    if (rawCode === undefined || rawCode === null || String(rawCode).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "productCode is required"
      });
    }

    let productCodeNormalized;
    try {
      productCodeNormalized = normalizeProductCode(String(rawCode));
      parseProductCodeParts(productCodeNormalized, "productCode");
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: e.message || "Invalid productCode"
      });
    }

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    // 🔒 Check variant exists
    const variantExists = product.variants.some(
      (v) => normalizeProductCode(v.productCode) === productCodeNormalized
    );

    if (!variantExists) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }

    // 🔒 Prevent deleting last variant (recommended)
    if (product.variants.length === 1) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete last variant of product"
      });
    }

    // 🔥 REMOVE VARIANT
    product.variants = product.variants.filter(
      (v) => normalizeProductCode(v.productCode) !== productCodeNormalized
    );

    // 🔁 RECALCULATE PRICE RANGE
    const effectivePrices = product.variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    product.priceRange = {
      min: Math.min(...effectivePrices),
      max: Math.max(...effectivePrices)
    };
        
    // 🔁 RECALCULATE STOCK
    product.totalStock = product.variants.reduce(
      (sum, v) => sum + (v.inventory.quantity || 0),
      0
    );
         
    await product.save();

     // ✅ INVALIDATE ALL PRODUCT CACHES
    await invalidateProductCaches(product.slug);

    return res.status(200).json({
      success: true,
      message: "Variant deleted successfully",
      product
    });

  } catch (error) {
    console.error("Delete variant error:", error);
    return res.status(500).json({
      success: false,
      message: "Error deleting variant",
      error: error.message
    });
  }
};

//get variant by productCode
// Get product + specific variant by productCode
const getVariantByproductCode = async (req, res) => {
  try {
    const { productCode } = req.params;

    if (!productCode) {
      return res.status(400).json({
        success: false,
        message: "productCode is required"
      });
    }

    let normalizedCode;
    try {
      normalizedCode = normalizeProductCode(productCode);
      parseProductCodeParts(normalizedCode, "productCode");
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: e.message || "Invalid productCode"
      });
    }

    // 🔍 Optimized query (returns only matched variant)
    const product = await Product.findOne(
      { "variants.productCode": productCodeToDbQuery(normalizedCode) },
      {
        title: 1,
        name: 1,
        slug: 1,
        brand: 1,
        category: 1,
        fomo: 1,
        soldInfo: 1,
        hsnCode: 1,
        gstRate: 1,
        isFragile: 1,
        "variants.$": 1
      }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "No product found for this productCode"
      });
    }

    return res.status(200).json({
      success: true,
      product: {
        _id: product._id,
        title: product.title,
        name: product.name,
        slug: product.slug,
        brand: product.brand,
        category: product.category,
        fomo: product.fomo,
        soldInfo: product.soldInfo,
        hsnCode: product.hsnCode,
        gstRate: product.gstRate,
        isFragile: product.isFragile
      },
      variant: product.variants[0], // matched variant
      matchedProductCode: normalizedCode
    });

  } catch (error) {
    console.error("Get variant by productCode error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching variant",
      error: error.message
    });
  }
};

// Get product details with user-specific pricing
// const getProductDetails = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const product = await Product.findById(id).populate('category');
//     if (!product) return res.status(404).json({ message: 'Product not found' });

//     let price;
//     if (req.userType === 'wholesaler') {
//       price = {
//         base: product.price.wholesaleBase,
//         sale: product.price.wholesaleSale || product.price.wholesaleBase,
//         minimumOrderQuantity: product.minimumOrderQuantity
//       };
//     } else {
//       price = {
//         base: product.price.base,
//         sale: product.price.sale || product.price.base
//       };
//     }

//     res.status(200).json({
//       product,
//       price
//     });
//   } catch (error) {
//     res.status(500).json({ message: 'Error fetching product details', error });
//   }
// };



//will have to test it 
// const updateVariant = async (req, res) => {
//   try {
//     const { slug, variantId } = req.params;

//     const product = await Product.findOne({ slug });

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found"
//       });
//     }

//     const variant = product.variants.id(variantId);

//     if (!variant) {
//       return res.status(404).json({
//         success: false,
//         message: "Variant not found"
//       });
//     }

//     // =========================
//     // 🔧 HELPERS
//     // =========================
//     const parseBoolean = (val) => {
//       if (typeof val === "boolean") return val;
//       if (typeof val === "string") return val.toLowerCase() === "true";
//       return false;
//     };

//     const parseNumber = (val) => {
//       const num = Number(val);
//       return isNaN(num) ? null : num;
//     };

//     // =========================
//     // 📦 UPDATE BASIC FIELDS
//     // =========================
//     if (req.body.productCode) {
//       const productCodeNumber = Number(req.body.productCode);

//       const exists = await Product.exists({
//         "variants.productCode": productCodeNumber,
//         "variants._id": { $ne: variantId }
//       });

//       if (exists) {
//         return res.status(400).json({
//           success: false,
//           message: "productCode already exists"
//         });
//       }

//       variant.productCode = productCodeNumber;
//     }

//     // =========================
//     // 💰 PRICE UPDATE
//     // =========================
//     const base = parseNumber(req.body["price[base]"]);
//     const sale = parseNumber(req.body["price[sale]"]);
//     const wholesaleBase = parseNumber(req.body["price[wholesaleBase]"]);
//     const wholesaleSale = parseNumber(req.body["price[wholesaleSale]"]);

//     if (base !== null) {
//       if (base <= 0) {
//         return res.status(400).json({
//           success: false,
//           message: "Base price must be greater than 0"
//         });
//       }
//       variant.price.base = base;
//     }

//     if (sale !== null) {
//       if (sale >= variant.price.base) {
//         return res.status(400).json({
//           success: false,
//           message: "Sale price must be less than base price"
//         });
//       }
//       variant.price.sale = sale;
//     }

//     if (wholesaleBase !== null) {
//       variant.price.wholesaleBase = wholesaleBase;
//     }

//     if (wholesaleSale !== null) {
//       variant.price.wholesaleSale = wholesaleSale;
//     }

//     // =========================
//     // 📦 INVENTORY UPDATE
//     // =========================
//     if (req.body.quantity !== undefined) {
//       variant.inventory.quantity = parseNumber(req.body.quantity) || 0;
//     }

//     if (req.body.lowStockThreshold !== undefined) {
//       variant.inventory.lowStockThreshold =
//         parseNumber(req.body.lowStockThreshold) || 5;
//     }

//     if (req.body.trackInventory !== undefined) {
//       variant.inventory.trackInventory = parseBoolean(
//         req.body.trackInventory
//       );
//     }

//     // =========================
//     // 🏷️ WHOLESALE FLAG
//     // =========================
//     if (req.body.wholesale !== undefined) {
//       variant.wholesale = parseBoolean(req.body.wholesale);
//     }

//     // =========================
//     // 📦 MOQ
//     // =========================
//     if (req.body.minimumOrderQuantity !== undefined) {
//       variant.minimumOrderQuantity =
//         parseNumber(req.body.minimumOrderQuantity) || 1;
//     }

//     // =========================
//     // 🎯 ACTIVE FLAG
//     // =========================
//     if (req.body.isActive !== undefined) {
//       variant.isActive = parseBoolean(req.body.isActive);
//     }

//     // =========================
//     // 🧩 ATTRIBUTES
//     // =========================
//     if (req.body.attributes) {
//       try {
//         const parsed = JSON.parse(req.body.attributes);

//         variant.attributes = parsed.map((a) => ({
//           key: a.key,
//           value: a.value
//         }));
//       } catch (e) {
//         return res.status(400).json({
//           success: false,
//           message: "Invalid attributes format"
//         });
//       }
//     }

//     // =========================
//     // 📸 IMAGE HANDLING
//     // =========================
//     if (req.files && req.files.length > 0) {
//       // delete old images (optional)
//       for (let img of variant.images) {
//         if (img.publicId) {
//           await deleteFromCloudinary(img.publicId);
//         }
//       }

//       let uploadedImages = [];

//       for (let i = 0; i < req.files.length; i++) {
//         const file = req.files[i];

//         if (!file.buffer) continue;

//         const optimizedBuffer = await optimizeProductImageBuffer(file.buffer);
//         const upload = await uploadToCloudinary(
//           optimizedBuffer,
//           "products",
//           `${slug}-variant-${variantId}-img-${i}-${Date.now()}`
//         );

//         uploadedImages.push({
//           url: upload.url,
//           publicId: upload.publicId,
//           altText: product.name,
//           order: i
//         });
//       }

//       variant.images = uploadedImages;
//     }

//     // =========================
//     // 🔁 RECALCULATE PRODUCT
//     // =========================
//     const effectivePrices = product.variants.map(v =>
//       v.price.sale != null ? v.price.sale : v.price.base
//     );

//     product.priceRange = {
//       min: Math.min(...effectivePrices),
//       max: Math.max(...effectivePrices)
//     };

//     product.totalStock = product.variants.reduce(
//       (sum, v) => sum + (v.inventory.quantity || 0),
//       0
//     );

//     await product.save();

//     return res.status(200).json({
//       success: true,
//       message: "Variant updated successfully",
//       variant
//     });

//   } catch (error) {
//     console.error("Update variant error:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Error updating variant",
//       error: error.message
//     });
//   }
// };
// =============================================
// EXPORT ALL PRODUCTS TO EXCEL (.xlsx)
// =============================================
const exportProductsCSV = async (req, res) => {
  try {
    const XLSX = require('xlsx');

    // Fetch ALL products - no pagination, include all statuses
    const products = await Product.find({})
      .populate('category', 'name slug')
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    if (!products || products.length === 0) {
      return res.status(200).json({ success: true, message: 'No products found to export.' });
    }

    // Column headers matching bulk upload template + images field
    const HEADERS = [
      'name', 'title', 'description', 'category', 'brand', 'status', 'isfeatured',
      'basePrice', 'salePrice', 'quantity', 'productCode', 'variantAttributes',
      'weight', 'length', 'width', 'height',
      'soldEnabled', 'soldCount', 'fomoEnabled', 'fomoType', 'viewingNow', 'productLeft', 'customMessage',
      'productAttributes', 'images', 'hsnCode', 'gstRate', 'isFragile',
      'wholesale', 'wholesaleBase', 'wholesaleSale', 'minimumOrderQuantity', 'countryOfOrigin'
    ];

    // Build data rows as array-of-arrays (faster than json2xlsx for large sets)
    const dataRows = [];

    for (const product of products) {
      const variants = Array.isArray(product.variants) && product.variants.length > 0
        ? product.variants
        : [null];

      for (const variant of variants) {
        const categoryName = product.category ? (product.category.name || '') : '';

        // Variant attributes: e.g. Color:Red|Size:M
        let variantAttributes = '';
        if (variant && Array.isArray(variant.attributes) && variant.attributes.length > 0) {
          variantAttributes = variant.attributes
            .map(a => `${a.key || ''}:${a.value || ''}`)
            .join('|');
        }

        // Product-level custom attributes
        let productAttributes = '';
        if (Array.isArray(product.attributes) && product.attributes.length > 0) {
          productAttributes = product.attributes
            .map(a => `${a.key || ''}:${a.value || ''}`)
            .join('|');
        }

        // Images: all image URLs sorted by order, comma-separated
        let imageUrls = '';
        if (variant && Array.isArray(variant.images) && variant.images.length > 0) {
          imageUrls = variant.images
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map(img => img.url || '')
            .filter(Boolean)
            .join(', ');
        }

        // Shipping: variant-level falls back to product-level
        const shippingObj = (variant && variant.shipping) ? variant.shipping : (product.shipping || {});
        const dimObj = shippingObj.dimensions || {};
        const weight      = (shippingObj.weight != null) ? shippingObj.weight : '';
        const dimLength   = (dimObj.length != null) ? dimObj.length : '';
        const dimWidth    = (dimObj.width  != null) ? dimObj.width  : '';
        const dimHeight   = (dimObj.height != null) ? dimObj.height : '';

        // Pricing & inventory from variant
        const basePrice           = variant && variant.price ? variant.price.base : '';
        const salePrice           = variant && variant.price && variant.price.sale != null ? variant.price.sale : '';
        const quantity            = variant && variant.inventory ? variant.inventory.quantity : '';
        const productCode         = variant ? (variant.productCode || '') : '';
        const wholesale           = variant ? (variant.wholesale ? 'TRUE' : 'FALSE') : 'FALSE';
        const wholesaleBase       = variant && variant.price && variant.price.wholesaleBase != null ? variant.price.wholesaleBase : '';
        const wholesaleSale       = variant && variant.price && variant.price.wholesaleSale != null ? variant.price.wholesaleSale : '';
        const minimumOrderQty     = variant && variant.minimumOrderQuantity != null ? variant.minimumOrderQuantity : '';

        dataRows.push([
          product.name        || '',
          product.title       || '',
          product.description || '',
          categoryName,
          product.brand       || '',
          product.status      || '',
          product.isFeatured  ? 'TRUE' : 'FALSE',
          basePrice,
          salePrice,
          quantity,
          productCode,
          variantAttributes,
          weight,
          dimLength,
          dimWidth,
          dimHeight,
          product.soldInfo ? (product.soldInfo.enabled ? 'TRUE' : 'FALSE') : '',
          product.soldInfo ? product.soldInfo.count : '',
          product.fomo ? (product.fomo.enabled ? 'TRUE' : 'FALSE') : '',
          product.fomo ? (product.fomo.type || '') : '',
          product.fomo ? product.fomo.viewingNow : '',
          product.fomo ? product.fomo.productLeft : '',
          product.fomo ? (product.fomo.customMessage || '') : '',
          productAttributes,
          imageUrls,
          product.hsnCode  || '',
          product.gstRate  != null ? product.gstRate : '',
          product.isFragile ? 'TRUE' : 'FALSE',
          wholesale,
          wholesaleBase,
          wholesaleSale,
          minimumOrderQty,
          '' // countryOfOrigin — not in current schema
        ]);
      }
    }

    // ── Build workbook ──────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();

    // Combine header + data into one 2-D array for sheet_from_array_of_arrays
    const sheetData = [HEADERS, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);

    // ── Style: bold header row ──────────────────────────────────────────────
    HEADERS.forEach((_, colIdx) => {
      const cellAddr = XLSX.utils.encode_cell({ r: 0, c: colIdx });
      if (!ws[cellAddr]) ws[cellAddr] = {};
      ws[cellAddr].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '1D4ED8' } }, // blue header background
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false }
      };
    });

    // ── Auto column widths (based on max char length in first 200 rows) ─────
    const colWidths = HEADERS.map((h, ci) => {
      let max = h.length;
      for (let ri = 1; ri < Math.min(sheetData.length, 200); ri++) {
        const val = sheetData[ri][ci];
        if (val != null) max = Math.max(max, String(val).length);
      }
      return { wch: Math.min(max + 2, 80) }; // cap at 80 chars
    });
    ws['!cols'] = colWidths;

    // ── Freeze first row ────────────────────────────────────────────────────
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };

    XLSX.utils.book_append_sheet(wb, ws, 'Products');

    // ── Write to buffer and send ────────────────────────────────────────────
    const xlsxBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    const today    = new Date().toISOString().slice(0, 10);
    const filename = `products_export_${today}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', xlsxBuffer.length);
    res.send(xlsxBuffer);

  } catch (error) {
    console.error('Export products Excel error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error exporting products',
      error: error.message
    });
  }
};

// =============================================
// DOWNLOAD BULK UPLOAD TEMPLATE (with data validation)
// =============================================
const downloadBulkUploadTemplate = async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const XLSX = require('xlsx');
    const path = require('path');
    const fs = require('fs');

    const templatePath = 'c:/BigFeathers/offerWaaleBaba/OWB-bulkUploadFormat-ForNewProducts-FinalUpdated.xlsx';

    // ── Fetch dynamic categories ─────────────────────────────────────────────
    const categories = await Category.find({ status: 'active' })
      .sort({ name: 1 })
      .lean();
    const categoryNames = categories.map(c => c.name);

    const workbook = new ExcelJS.Workbook();
    
    // Set active worksheet tab to BulkUpload_NewProducts (index 1) when workbook is opened
    workbook.views = [
      {
        firstSheet: 0,
        activeTab: 1, // 0-indexed: index 1 refers to BulkUpload_NewProducts worksheet
        visibility: 'visible'
      }
    ];
    
    // Create worksheets
    const wsInstructions = workbook.addWorksheet('Instructions');
    const wsProducts = workbook.addWorksheet('BulkUpload_NewProducts');
    const wsImageGuide = workbook.addWorksheet('Image_ZIP_Guide');
    const wsLookups = workbook.addWorksheet('Lookups');

    let productsRows = [];

    if (fs.existsSync(templatePath)) {
      // ── Use SheetJS (xlsx) to read the template file ───────────────────────
      const workbookTemplate = XLSX.readFile(templatePath);
      
      // 1. Read Instructions
      const instructionsRows = XLSX.utils.sheet_to_json(workbookTemplate.Sheets['Instructions'], { header: 1 });
      instructionsRows.forEach(row => {
        const fieldName = String(row[1] || '').trim();
        if (['weight', 'length', 'width', 'height'].includes(fieldName)) {
          row[2] = '✅ Yes'; // Update validation column description to show "Required"
        }
        wsInstructions.addRow(row);
      });

      // Style Instructions sheet
      wsInstructions.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF1E293B' } };
      const instHeader = wsInstructions.getRow(5);
      instHeader.height = 24;
      instHeader.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF475569' }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      });
      wsInstructions.columns = [
        { width: 10 }, // Column
        { width: 22 }, // Field Name
        { width: 12 }, // Required?
        { width: 12 }, // Data Type
        { width: 45 }, // Allowed Values / Format
        { width: 30 }, // Example
        { width: 70 }  // Notes
      ];

      // 2. Read Products & examples
      productsRows = XLSX.utils.sheet_to_json(workbookTemplate.Sheets['BulkUpload_NewProducts'], { header: 1 });
      productsRows.forEach(row => {
        wsProducts.addRow(row);
      });

      // Style Products header
      const prodHeader = wsProducts.getRow(1);
      prodHeader.height = 26;
      prodHeader.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF1D4ED8' }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });
      wsProducts.columns = productsRows[0].map(h => ({
        header: h,
        width: Math.max(String(h || '').length + 4, 16)
      }));
      wsProducts.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];

      // 3. Read Image Guide
      const imageGuideRows = XLSX.utils.sheet_to_json(workbookTemplate.Sheets['Image_ZIP_Guide'], { header: 1 });
      imageGuideRows.forEach(row => {
        wsImageGuide.addRow(row);
      });

      // Style Image Guide
      wsImageGuide.getCell('B1').font = { size: 14, bold: true, color: { argb: 'FF1E293B' } };
      wsImageGuide.columns = [
        { width: 6 },
        { width: 80 }
      ];
    } else {
      // Fallback if template is not found
      productsRows = [[
        'name', 'title', 'description', 'category', 'brand', 'status', 'isfeatured',
        'basePrice', 'salePrice', 'quantity', 'productCode', 'variantAttributes',
        'weight', 'length', 'width', 'height',
        'soldEnabled', 'soldCount', 'fomoEnabled', 'fomoType', 'viewingNow', 'productLeft', 'customMessage',
        'productAttributes', 'images (LEAVE BLANK)', 'hsnCode', 'gstRate', 'isFragile',
        'wholesale', 'wholesaleBase', 'wholesaleSale', 'minimumOrderQuantity', 'countryOfOrigin'
      ]];
      wsProducts.addRow(productsRows[0]);
      
      const prodHeader = wsProducts.getRow(1);
      prodHeader.height = 26;
      prodHeader.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF1D4ED8' }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });
      wsProducts.columns = productsRows[0].map(h => ({ header: h, width: Math.max(h.length + 4, 16) }));
      wsProducts.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];
    }

    // ── Create Lookups sheet ─────────────────────────────────────────────────
    const STATUS_OPTIONS    = ['active', 'draft', 'archived'];
    const BOOL_OPTIONS      = ['true', 'false'];
    const FOMO_TYPE_OPTIONS = ['viewing_now', 'product_left', 'custom'];
    const GST_OPTIONS       = ['0', '5', '12', '18', '28'];

    // Write lists to Lookups sheet columns
    wsLookups.getColumn(1).values = ['category', ...categoryNames];
    wsLookups.getColumn(2).values = ['status', ...STATUS_OPTIONS];
    wsLookups.getColumn(3).values = ['boolean', ...BOOL_OPTIONS];
    wsLookups.getColumn(4).values = ['fomoType', ...FOMO_TYPE_OPTIONS];
    wsLookups.getColumn(5).values = ['gstRate', ...GST_OPTIONS];

    // Hide lookups sheet completely
    wsLookups.state = 'veryHidden';

    // ── Build map from headers to column index ──────────────────────────────
    const colMap = {};
    const headerRow = wsProducts.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      const val = String(cell.value || '').trim();
      const name = val.replace(/\s*\(.*\)/, '').trim(); // 'images (LEAVE BLANK)' -> 'images'
      colMap[name] = colNumber;
    });

    // Define validation ranges referencing Lookups
    const VALIDATIONS = {
      'category': `Lookups!$A$2:$A$${categoryNames.length + 1}`,
      'status': `Lookups!$B$2:$B$${STATUS_OPTIONS.length + 1}`,
      'isfeatured': `Lookups!$C$2:$C$${BOOL_OPTIONS.length + 1}`,
      'soldEnabled': `Lookups!$C$2:$C$${BOOL_OPTIONS.length + 1}`,
      'fomoEnabled': `Lookups!$C$2:$C$${BOOL_OPTIONS.length + 1}`,
      'fomoType': `Lookups!$D$2:$D$${FOMO_TYPE_OPTIONS.length + 1}`,
      'isFragile': `Lookups!$C$2:$C$${BOOL_OPTIONS.length + 1}`,
      'wholesale': `Lookups!$C$2:$C$${BOOL_OPTIONS.length + 1}`,
      'gstRate': `Lookups!$E$2:$E$${GST_OPTIONS.length + 1}`
    };

    // Apply validations to wsProducts (rows 2 to 5000)
    Object.keys(VALIDATIONS).forEach((colName) => {
      const colNumber = colMap[colName];
      if (!colNumber) return;

      const colLetter = wsProducts.getColumn(colNumber).letter;
      const validationFormula = VALIDATIONS[colName];

      wsProducts.dataValidations.add(`${colLetter}2:${colLetter}5000`, {
        type: 'list',
        allowBlank: true,
        formulae: [validationFormula],
        showErrorMessage: true,
        errorStyle: 'warning',
        errorTitle: 'Invalid Selection',
        error: `Please select a valid ${colName} from the list.`
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bulk_upload_template.xlsx"');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);

  } catch (error) {
    console.error('Download bulk upload template error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error generating template',
      error: error.message
    });
  }
};


module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  bulkDelete,
  bulkUpdateProductStatus,
  hardDeleteProduct,
  bulkHardDelete,
  restoreProduct,
  getLowStockProducts,
  getArchivedProducts,
  getDraftProducts,
  getAllActiveProducts,
  getProductBySlug,
  bulkRestore,
  importProductsFromCSV,
  previewImportProductsFromCSV,
  getAllProductsAdmin,
  addVariant,
  updateVariantChannelVisibility,
  deleteVariant,
  getVariantByproductCode,
  bulkUploadNewProductsWithImages,
  downloadErrorReport,
  previewBulkUpload,
  exportProductsCSV,
  downloadBulkUploadTemplate
};
