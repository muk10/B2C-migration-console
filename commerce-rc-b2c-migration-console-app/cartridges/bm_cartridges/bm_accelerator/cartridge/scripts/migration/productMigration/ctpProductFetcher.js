'use strict';

var http     = require('*/cartridge/scripts/migration/core/http');
var cfg      = require('*/cartridge/scripts/migration/configAccessor');
var Encoding = require('dw/crypto/Encoding');
var Bytes    = require('dw/util/Bytes');

var DEFAULT_BATCH_SIZE = 50;
var MAX_BATCH_SIZE     = 500;
var RESPONSE_TOO_LARGE = /HTTP response maximum size for memory processing|10485760 bytes exceeded/i;

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

/**
 * Return total number of products in the CT project.
 * @returns {number}
 */
function getCount() {
    var c     = cfg.ctp;
    var token = getToken();
    var res   = http.get(
        c.apiUrl + '/' + c.projectKey + '/products?limit=1',
        { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT product count failed (' + res.status + ')');
    }
    return res.data.total || 0;
}

// Default expansions for full product migration (category assignment needs these).
// The price book and inventory flows use fetchBatchLean instead — they only read
// variants and prices, and expanding categories[*] at limit=500 overflows the Service
// Framework's 10 MB in-memory response cap (surfaces as a synthesized "500").
var DEFAULT_EXPAND = ['productType', 'masterData.current.categories[*]'];

/**
 * Fetch one page of products from CT.
 *
 * If SFCC rejects a response at its 10 MB in-memory limit, retry the same offset
 * with a smaller page. The caller advances by results.length, so no products are
 * skipped when a page has to be reduced.
 *
 * @param {number} offset
 * @param {number} limit  - requested page size, max 500
 * @param {Object} [options]
 * @param {Array<string>} [options.expand] - expand params; pass [] for none. Omit for DEFAULT_EXPAND.
 * @param {boolean} [options.withTotal] - include total (default true)
 * @returns {{ results: Array, total: number, pageSize: number }}
 */
function fetchBatch(offset, limit, options) {
    var c         = cfg.ctp;
    var tok       = getToken();
    var opts      = options || {};
    var expand    = opts.expand ? opts.expand : DEFAULT_EXPAND;
    var withTotal = opts.withTotal !== false;
    var requested = parseInt(limit, 10) || DEFAULT_BATCH_SIZE;
    var pageSize  = Math.min(Math.max(requested, 1), MAX_BATCH_SIZE);
    var start     = Math.max(parseInt(offset, 10) || 0, 0);

    while (pageSize >= 1) {
        var qs = '?limit=' + pageSize + '&offset=' + start + '&sort=id+asc';
        if (withTotal) {
            qs += '&withTotal=true';
        }
        var ei;
        for (ei = 0; ei < expand.length; ei++) {
            qs += '&expand=' + expand[ei];
        }

        var res;
        var responseTooLarge = false;

        try {
            res = http.get(
                c.apiUrl + '/' + c.projectKey + '/products' + qs,
                { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
            );
        } catch (e) {
            if (!RESPONSE_TOO_LARGE.test(String(e && e.message ? e.message : e))) {
                throw e;
            }
            responseTooLarge = true;
        }

        if (!responseTooLarge && res.status === 200) {
            var data = res.data || {};
            return {
                results:  data.results || [],
                total:    data.total   || 0,
                pageSize: pageSize
            };
        }

        var responseMessage = responseTooLarge ? '' : String(res.text || '');
        responseTooLarge = responseTooLarge || RESPONSE_TOO_LARGE.test(responseMessage);
        if (responseTooLarge) {
            if (pageSize === 1) {
                throw new Error('CT product response exceeds SFCC\'s 10 MB HTTP limit even with a one-product page at offset ' + start);
            }
            pageSize = Math.max(1, Math.floor(pageSize / 2));
        } else {
            var detail = responseMessage ? ': ' + responseMessage.substring(0, 300) : '';
            throw new Error('CT products fetch failed (' + res.status + ')' + detail);
        }
    }

    throw new Error('CT products fetch failed: no valid page size was available');
}

/**
 * CT product-type ID → product-type name, for every product type in the project.
 * A project has a handful of product types, so a plain object is safe here.
 * @returns {Object.<string,string>}
 */
function fetchProductTypeNames() {
    var c      = cfg.ctp;
    var tok    = getToken();
    var names  = {};
    var limit  = 500;
    var offset = 0;
    var total  = null;

    do {
        var res = http.get(
            c.apiUrl + '/' + c.projectKey + '/product-types?limit=' + limit
                + '&offset=' + offset + '&withTotal=true',
            { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
        );
        if (res.status !== 200) {
            throw new Error('CT product types fetch failed (' + res.status + ')');
        }
        if (total === null) total = res.data.total || 0;
        var results = res.data.results || [];
        var i;
        for (i = 0; i < results.length; i++) {
            if (results[i] && results[i].id) names[results[i].id] = results[i].name || '';
        }
        offset += limit;
    } while (offset < total);

    return names;
}

/**
 * Give each unexpanded product a minimal productType.obj ({ name }) so
 * productTransformer.detectProductKind classifies bundles and sets exactly as the
 * product migration does with the full productType expansion.
 * @param {Array} products - raw CT products (mutated)
 * @param {Object.<string,string>} typeNames - fetchProductTypeNames result
 * @returns {Array} the same products
 */
function attachProductTypeNames(products, typeNames) {
    var i;
    for (i = 0; i < (products || []).length; i++) {
        var pt = products[i] && products[i].productType;
        if (pt && !pt.obj && pt.id && Object.prototype.hasOwnProperty.call(typeNames, pt.id)) {
            pt.obj = { id: pt.id, name: typeNames[pt.id] };
        }
    }
    return products;
}

var productTypeNamesCache = null;

/**
 * Fetch one page of products without expansions (keeps large pages under SFCC's
 * 10 MB response cap) but with product-type names attached, so bundle/set detection
 * still works. For flows that read variants and prices only (price book, inventory).
 * @param {number} offset
 * @param {number} limit
 * @returns {{ results: Array, total: number, pageSize: number }}
 */
function fetchBatchLean(offset, limit) {
    if (!productTypeNamesCache) productTypeNamesCache = fetchProductTypeNames();
    var batch = fetchBatch(offset, limit, { expand: [] });
    attachProductTypeNames(batch.results, productTypeNamesCache);
    return batch;
}

/**
 * Fetch a single product from CT by its ID (UUID).
 * @param {string} productId
 * @returns {Object} CT product object
 */
function fetchById(productId) {
    var c   = cfg.ctp;
    var tok = getToken();
    var res = http.get(
        c.apiUrl + '/' + c.projectKey + '/products/' + encodeURIComponent(productId)
            + '?expand=productType&expand=masterData.current.categories[*]',
        { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT product fetch failed for ID ' + productId + ' (' + res.status + ')');
    }
    return res.data;
}

/**
 * CT category UUID → SFCC category-id (key when present, else UUID).
 * Uses dw.util.HashMap — a plain JS object would exceed api.jsObjectSize (2000).
 * @returns {dw.util.HashMap}
 */
function fetchCategoryIdMap() {
    var HashMap = require('dw/util/HashMap');
    var c     = cfg.ctp;
    var tok   = getToken();
    var map   = new HashMap();
    var limit = 500;
    var offset = 0;
    var total = null;

    do {
        var res = http.get(
            c.apiUrl + '/' + c.projectKey + '/categories?limit=' + limit
                + '&offset=' + offset + '&withTotal=true',
            { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
        );
        if (res.status !== 200) break;
        if (total === null) total = res.data.total || 0;
        var results = res.data.results || [];
        var i;
        for (i = 0; i < results.length; i++) {
            var cat = results[i];
            if (cat && cat.id) map.put(cat.id, cat.key || cat.id);
        }
        offset += limit;
    } while (total !== null && offset < total);

    return map;
}

module.exports = {
    getCount: getCount,
    fetchBatch: fetchBatch,
    fetchBatchLean: fetchBatchLean,
    fetchProductTypeNames: fetchProductTypeNames,
    attachProductTypeNames: attachProductTypeNames,
    fetchById: fetchById,
    fetchCategoryIdMap: fetchCategoryIdMap
};
