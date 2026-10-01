'use strict';

var bigcommerceApi = require('*/cartridge/scripts/migration/core/bigcommerceApi');

var DEFAULT_LIMIT  = 100;
var MAX_RETRIES    = 3;
var RETRY_DELAY_MS = 500;
var _orderCountCache = {};

function sleep(ms) {
    var start = Date.now();
    while (Date.now() - start < ms) { /* busy wait */ }
}

function withRetry(fn) {
    var lastError = null;
    var attempt;
    for (attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            var res = fn();
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error('HTTP ' + res.status);
                sleep(RETRY_DELAY_MS * (attempt + 1));
                continue;
            }
            return res;
        } catch (e) {
            lastError = e;
            sleep(RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastError || new Error('Request failed after retries');
}

function authenticate(creds) {
    bigcommerceApi.getCreds(creds);
    return (creds && creds.accessToken) || bigcommerceApi.getCreds().accessToken;
}

/**
 * Parse the order date range: 1, 2 or 3 years, or 'all' (0) for every order.
 * @param {*} value - date range from the request or options; empty means 1 year
 * @returns {number} years, 0 meaning all orders
 */
function parseYears(value) {
    if (value === undefined || value === null || value === '') return 1;
    if (String(value).toLowerCase() === 'all') return 0;
    var years = parseInt(String(value), 10);
    if ([0, 1, 2, 3].indexOf(years) < 0) {
        throw new Error('Date range must be 1, 2 or 3 years, or all');
    }
    return years;
}

function dateYearsAgo(years) {
    if (years === 0) return ''; // all orders: no lower bound on createdAt
    var d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString();
}

/**
 * Map UI filters to BigCommerce V2 order query params.
 * @param {Object} options
 * @returns {string}
 */
function buildOrdersQuery(options) {
    var parts = [];
    if (options.sinceDate) {
        parts.push('min_date_created=' + encodeURIComponent(options.sinceDate));
    }
    if (options.orderState) {
        parts.push('status_id=' + encodeURIComponent(String(options.orderState)));
    }
    if (options.paymentState) {
        parts.push('payment_status=' + encodeURIComponent(String(options.paymentState)));
    }
    return parts.join('&');
}

/**
 * Hydrate order products / shipping addresses for mapping.
 * @param {Object} order
 * @returns {Object}
 */
function hydrateOrder(order) {
    if (!order || !order.id) return order;
    try {
        var productsRes = withRetry(function () {
            return bigcommerceApi.send(
                'GET',
                bigcommerceApi.getBaseUrl(null, 'v2') + '/orders/' + order.id + '/products',
                bigcommerceApi.authHeaders()
            );
        });
        if (productsRes.status === 200) {
            order.products = bigcommerceApi.extractList(productsRes.data);
        }
    } catch (e) {
        order.products = order.products || [];
    }

    try {
        var shipRes = withRetry(function () {
            return bigcommerceApi.send(
                'GET',
                bigcommerceApi.getBaseUrl(null, 'v2') + '/orders/' + order.id + '/shipping_addresses',
                bigcommerceApi.authHeaders()
            );
        });
        if (shipRes.status === 200) {
            order.shipping_addresses = bigcommerceApi.extractList(shipRes.data);
        }
    } catch (e2) {
        order.shipping_addresses = order.shipping_addresses || [];
    }

    return order;
}

function countCacheKey(options) {
    return [
        parseYears(options.years),
        options.orderState || '',
        options.paymentState || '',
        options.sinceDate || ''
    ].join('|');
}

/**
 * @param {Object} options
 * @returns {{ total: number, exportCount: number }}
 */
function countOrders(options) {
    var cacheKey = countCacheKey(options);
    if (_orderCountCache[cacheKey]) {
        return _orderCountCache[cacheKey];
    }

    var years     = parseYears(options.years);
    var maxCount  = options.maxCount ? parseInt(String(options.maxCount), 10) : null;
    var sinceDate = dateYearsAgo(years);
    var total     = 0;
    var page      = 1;
    var pageSize  = 250;
    var qsBase    = buildOrdersQuery({
        sinceDate:    sinceDate,
        orderState:   options.orderState,
        paymentState: options.paymentState
    });

    while (page <= 200) {
        var qs = (qsBase ? qsBase + '&' : '') + 'limit=' + pageSize + '&page=' + page;
        var res = withRetry(function () {
            return bigcommerceApi.send(
                'GET',
                bigcommerceApi.getBaseUrl(null, 'v2') + '/orders?' + qs,
                bigcommerceApi.authHeaders()
            );
        });
        if (res.status !== 200 && res.status !== 204) {
            throw new Error('BigCommerce order count failed (' + res.status + ')');
        }
        var batch = bigcommerceApi.extractList(res.data);
        total += batch.length;
        if (!batch.length || batch.length < pageSize) break;
        page++;
    }

    var exportCount = total;
    if (maxCount && maxCount > 0 && maxCount < total) {
        exportCount = maxCount;
    }

    var result = { total: total, exportCount: exportCount };
    _orderCountCache[cacheKey] = result;
    return result;
}

/**
 * @param {string} token
 * @param {Object} options
 * @returns {{ results: Array, total: number }}
 */
function fetchOrdersPageByOffset(token, options) {
    var years     = parseYears(options.years);
    var sinceDate = options.sinceDate !== undefined ? options.sinceDate : dateYearsAgo(years);
    var offset    = options.offset || 0;
    var limit     = options.limit || DEFAULT_LIMIT;
    var pageSize  = 50;
    var page      = Math.floor(offset / pageSize) + 1;
    var skipInPage = offset % pageSize;
    var qsBase    = buildOrdersQuery({
        sinceDate:    sinceDate,
        orderState:   options.orderState,
        paymentState: options.paymentState
    });
    var qs = (qsBase ? qsBase + '&' : '') + 'limit=' + pageSize + '&page=' + page;

    var res = withRetry(function () {
        return bigcommerceApi.send(
            'GET',
            bigcommerceApi.getBaseUrl(null, 'v2') + '/orders?' + qs,
            bigcommerceApi.authHeaders()
        );
    });
    if (res.status !== 200 && res.status !== 204) {
        throw new Error('Failed to fetch BigCommerce orders (' + res.status + ')');
    }

    var batch   = bigcommerceApi.extractList(res.data);
    var results = [];
    var i;
    for (i = skipInPage; i < batch.length && results.length < limit; i++) {
        results.push(hydrateOrder(batch[i]));
    }

    var counts = countOrders({
        years:        years,
        orderState:   options.orderState,
        paymentState: options.paymentState
    });

    return {
        results: results,
        total:   counts.total
    };
}

module.exports = {
    authenticate:    authenticate,
    fetchOrdersPage: fetchOrdersPageByOffset,
    countOrders:     countOrders,
    buildOrdersWhere: buildOrdersQuery,
    dateYearsAgo:    dateYearsAgo,
    parseYears:      parseYears,
    DEFAULT_LIMIT:   DEFAULT_LIMIT,
    MAX_RETRIES:     MAX_RETRIES
};
