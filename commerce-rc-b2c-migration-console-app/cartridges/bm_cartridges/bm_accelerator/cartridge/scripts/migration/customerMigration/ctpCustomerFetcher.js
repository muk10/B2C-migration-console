'use strict';

var http     = require('*/cartridge/scripts/migration/core/http');
var cfg      = require('*/cartridge/scripts/migration/configAccessor');
var Encoding = require('dw/crypto/Encoding');
var Bytes    = require('dw/util/Bytes');

function toBase64(str) {
    return Encoding.toBase64(new Bytes(str, 'UTF-8'));
}

function getToken() {
    var c    = cfg.ctp;
    var body = 'grant_type=client_credentials';
    if (c.scopes) body += '&scope=' + encodeURIComponent(c.scopes);

    var res = http.post(
        c.authUrl + '/oauth/token',
        {
            Authorization:  'Basic ' + toBase64(c.clientId + ':' + c.clientSecret),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    );
    if (res.status !== 200 || !res.data.access_token) {
        throw new Error('CT auth failed (' + res.status + ')');
    }
    return res.data.access_token;
}

function ctErrorDetail(res) {
    if (res && res.data && res.data.message) return ': ' + res.data.message;
    if (res && res.text) return ': ' + String(res.text).substring(0, 240);
    return '';
}

/**
 * CT Query API rejects offset > 10000. Page with sort=id asc and id > lastId instead.
 * @param {string} lastId
 * @returns {string}
 */
function escapePredicateValue(lastId) {
    return String(lastId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function storeKeyWhere(storeKey) {
    return storeWhere(storeKey, '');
}

/**
 * CT Customer.stores is a Set of Store references. Query Predicates on a
 * Reference only expose `id` / `typeId`; KeyReference exposes `key`.
 * Match either so assignments stored as `{ id }` still count.
 * @param {string} [storeKey]
 * @param {string} [storeId]
 * @returns {string}
 */
function storeWhere(storeKey, storeId) {
    var parts = [];
    if (storeId) parts.push('stores(id = "' + escapePredicateValue(storeId) + '")');
    if (storeKey) parts.push('stores(key = "' + escapePredicateValue(storeKey) + '")');
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return '(' + parts.join(' or ') + ')';
}

var ASSIGNED_WHERE   = 'stores is not empty';
var UNASSIGNED_WHERE = 'stores is empty';

/**
 * Combine an optional store/unassigned predicate with keyset id > lastId.
 * @param {string} [extraWhere]
 * @param {string} [lastId]
 * @returns {string}
 */
function combineWhere(extraWhere, lastId) {
    var clauses = [];
    if (extraWhere) clauses.push('(' + extraWhere + ')');
    if (lastId) clauses.push('id > "' + escapePredicateValue(lastId) + '"');
    return clauses.join(' and ');
}

/**
 * @param {number} limit
 * @param {string} [lastId] - exclusive lower bound (previous page's last UUID)
 * @param {boolean} [withTotal]
 * @param {string} [extraWhere] - store / unassigned predicate (no leading where=)
 * @returns {string} query string including leading ?
 */
function buildKeysetQuery(limit, lastId, withTotal, extraWhere) {
    var lim = parseInt(limit, 10) || 500;
    if (lim < 1) lim = 1;
    if (lim > 500) lim = 500;
    var qs = '?limit=' + lim + '&sort=id+asc';
    if (withTotal) qs += '&withTotal=true';
    var where = combineWhere(extraWhere, lastId);
    if (where) {
        qs += '&where=' + encodeURIComponent(where);
    }
    return qs;
}

/**
 * @param {Array} results
 * @returns {string}
 */
function lastIdFromResults(results) {
    if (!results || !results.length) return '';
    var last = results[results.length - 1];
    return last && last.id ? String(last.id) : '';
}

/**
 * Return total number of customers in the CT project.
 * @param {string} [extraWhere] - optional CT predicate (store / unassigned)
 * @returns {number} total customer count
 */
function getCount(extraWhere) {
    var c     = cfg.ctp;
    var token = getToken();
    var qs    = '?limit=1&withTotal=true';
    if (extraWhere) {
        qs += '&where=' + encodeURIComponent(extraWhere);
    }
    var res   = http.get(
        c.apiUrl + '/' + c.projectKey + '/customers' + qs,
        { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT customer count failed (' + res.status + ')' + ctErrorDetail(res));
    }
    return res.data.total || 0;
}

function resolveExtraWhere(opts) {
    if (!opts) return '';
    if (opts.unassigned) return UNASSIGNED_WHERE;
    var byStore = storeWhere(opts.storeKey, opts.storeId);
    if (byStore) return byStore;
    if (opts.where) return String(opts.where);
    return '';
}

/**
 * Fetch one page of customers using keyset pagination (never uses offset).
 * @param {Object} [opts]
 * @param {number} [opts.limit] - page size (max 500)
 * @param {string} [opts.lastId] - exclusive cursor from the previous page
 * @param {boolean} [opts.withTotal] - default true on the first page only
 * @param {string} [opts.storeKey] - restrict to customers assigned to this CT store
 * @param {boolean} [opts.unassigned] - customers with no store assignment
 * @param {string} [opts.where] - raw extra predicate (ignored if storeKey/unassigned set)
 * @returns {{ results: Array, total: number, nextCursor: string, hasMore: boolean }}
 */
function fetchPage(opts) {
    opts = opts || {};
    var lastId    = opts.lastId ? String(opts.lastId) : '';
    var withTotal = opts.withTotal != null ? !!opts.withTotal : !lastId;
    var c         = cfg.ctp;
    var tok       = getToken();
    var qs        = buildKeysetQuery(opts.limit, lastId, withTotal, resolveExtraWhere(opts));

    var res = http.get(
        c.apiUrl + '/' + c.projectKey + '/customers' + qs,
        { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT customers fetch failed (' + res.status + ')' + ctErrorDetail(res));
    }
    var results = res.data.results || [];
    var limit   = parseInt(opts.limit, 10) || 500;
    var nextCursor = lastIdFromResults(results);
    return {
        results:    results,
        total:      res.data.total || 0,
        nextCursor: nextCursor,
        hasMore:    results.length >= limit
    };
}

/**
 * @param {Object|number} optsOrLimit - fetchPage opts, or page size
 * @param {string} [lastId]
 * @returns {{ results: Array, total: number, nextCursor: string, hasMore: boolean }}
 */
function fetchBatch(optsOrLimit, lastId) {
    if (optsOrLimit && typeof optsOrLimit === 'object') {
        return fetchPage(optsOrLimit);
    }
    return fetchPage({ limit: optsOrLimit, lastId: lastId });
}

/**
 * Convert a 32-char hex string (UUID without dashes) to standard UUID format.
 * If the string already contains dashes or is not 32 hex chars, it is returned as-is.
 * e.g. "8bd58511e17e4429acbebae8ac8d35f5" → "8bd58511-e17e-4429-acbe-bae8ac8d35f5"
 */
function normalizeUuid(id) {
    var clean = (id || '').trim().replace(/-/g, '');
    if (clean.length === 32 && /^[0-9a-fA-F]{32}$/.test(clean)) {
        return clean.slice(0, 8) + '-' +
               clean.slice(8, 12) + '-' +
               clean.slice(12, 16) + '-' +
               clean.slice(16, 20) + '-' +
               clean.slice(20);
    }
    return (id || '').trim();
}

/**
 * Fetch a single customer from CT by their ID.
 * Accepts both dashed UUIDs and plain 32-char hex strings (SFCC customer numbers).
 * @param {string} ctpId - CT customer UUID (with or without dashes)
 * @returns {Object|null} CT customer object, or null if not found (404)
 */
function fetchById(ctpId) {
    var c          = cfg.ctp;
    var tok        = getToken();
    var normalised = normalizeUuid(ctpId);
    var res = http.get(
        c.apiUrl + '/' + c.projectKey + '/customers/' + encodeURIComponent(normalised),
        { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
    );
    if (res.status === 404) return null;
    if (res.status !== 200) {
        throw new Error('CT customer fetch failed (' + res.status + ') for id: ' + normalised + ctErrorDetail(res));
    }
    return res.data;
}

module.exports = {
    getCount:             getCount,
    fetchPage:            fetchPage,
    fetchBatch:           fetchBatch,
    fetchById:            fetchById,
    buildKeysetQuery:     buildKeysetQuery,
    combineWhere:         combineWhere,
    storeKeyWhere:        storeKeyWhere,
    storeWhere:           storeWhere,
    ASSIGNED_WHERE:       ASSIGNED_WHERE,
    UNASSIGNED_WHERE:     UNASSIGNED_WHERE,
    lastIdFromResults:    lastIdFromResults,
    escapePredicateValue: escapePredicateValue,
    normalizeUuid:        normalizeUuid
};
