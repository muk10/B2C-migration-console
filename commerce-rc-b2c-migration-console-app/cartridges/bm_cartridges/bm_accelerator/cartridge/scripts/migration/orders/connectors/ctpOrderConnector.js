'use strict';

var Encoding = require('dw/crypto/Encoding');
var Bytes    = require('dw/util/Bytes');
var http     = require('*/cartridge/scripts/migration/core/http');
var cfg      = require('*/cartridge/scripts/migration/configAccessor');

// One page of recent orders at limit=100 measured ~1.7M chars, above the 1,000,000-char
// script string quota (api.jsStringLength); 20 orders measured at most ~0.4M chars.
var DEFAULT_LIMIT   = 20;
// commercetools rejects offset > 10,000 and stops counting at 10,000 once a where predicate is set.
var CT_RESULT_CAP   = 10000;
var MAX_RETRIES     = 3;
var RETRY_DELAY_MS  = 500;
// Payment method, workflow state key and channel keys for the XML; a page of 20 expanded
// orders measured at most ~0.33M chars.
var ORDER_EXPANDS   = ['paymentInfo.payments[*]', 'state', 'lineItems[*].supplyChannel',
    'lineItems[*].distributionChannel'].map(function (e) {
    return '&expand=' + encodeURIComponent(e);
}).join('');

function toBase64(str) {
    return Encoding.toBase64(new Bytes(str, 'UTF-8'));
}

function sleep(ms) {
    var start = Date.now();
    while (Date.now() - start < ms) { /* busy wait — SFCC has no setTimeout */ }
}

/**
 * Execute an HTTP call with retries on transient failures.
 * @param {Function} fn - function returning { status, data }
 * @returns {Object}
 */
function withRetry(fn) {
    var lastError = null;
    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
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

/**
 * Authenticate with commercetools using client credentials.
 * @param {Object} [creds] - optional credential override
 * @returns {string} access token
 */
function authenticate(creds) {
    var c    = creds || cfg.ctp;
    var body = 'grant_type=client_credentials';

    var res = withRetry(function () {
        return http.post(
            c.authUrl + '/oauth/token',
            {
                Authorization:  'Basic ' + toBase64(c.clientId + ':' + c.clientSecret),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        );
    });

    if (res.status !== 200 || !res.data.access_token) {
        throw new Error('CT auth failed (' + res.status + ')');
    }
    return res.data.access_token;
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

/**
 * Build ISO date string for N years ago from now.
 * @param {number} years - 0 means all orders
 * @returns {string} ISO date, or '' for all orders
 */
function dateYearsAgo(years) {
    if (years === 0) return ''; // all orders: no lower bound on createdAt
    var d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString();
}

/**
 * Build commercetools order query predicate.
 * @param {Object} options
 * @param {string} options.sinceDate - ISO date lower bound ('' for all orders)
 * @param {string} [options.beforeDate] - ISO date upper bound (exclusive), used for counting
 * @param {Object} [options.after] - cursor { createdAt, id }: only orders after this one
 * @param {string} [options.orderState] - commercetools orderState value
 * @param {string} [options.paymentState] - commercetools paymentState value
 * @returns {string} predicate, or '' when there is no filter
 */
function buildOrdersWhere(options) {
    var parts = [];
    if (options.sinceDate) {
        parts.push('createdAt >= "' + options.sinceDate + '"');
    }
    if (options.beforeDate) {
        parts.push('createdAt < "' + options.beforeDate + '"');
    }
    if (options.after && options.after.createdAt && options.after.id) {
        // orders sorted by createdAt, id: continue strictly after the last order read
        parts.push('(createdAt > "' + options.after.createdAt + '" or (createdAt = "'
            + options.after.createdAt + '" and id > "' + options.after.id + '"))');
    }
    if (options.orderState) {
        parts.push('orderState = "' + options.orderState + '"');
    }
    if (options.paymentState) {
        parts.push('paymentState = "' + options.paymentState + '"');
    }
    return parts.join(' and ');
}

/**
 * Fetch a single page of orders.
 * @param {string} token
 * @param {Object} options
 * @param {string} options.sinceDate - ISO date lower bound
 * @param {string} [options.orderState] - commercetools orderState value
 * @param {string} [options.paymentState] - commercetools paymentState value
 * @param {Object} [options.after] - cursor { createdAt, id }; replaces offset (no 10,000 limit)
 * @param {boolean} [options.withTotal] - false skips the total (faster for cursor pages)
 * @param {number} options.offset
 * @param {number} options.limit
 * @returns {Object} { results, total }
 */
function fetchOrdersPage(token, options) {
    var c     = cfg.ctp;
    var offset = options.after ? 0 : (options.offset || 0);
    var limit  = options.limit || DEFAULT_LIMIT;
    var where  = buildOrdersWhere(options);
    // id breaks ties between orders created in the same millisecond, so the cursor never skips one
    var sort   = encodeURIComponent('createdAt asc') + '&sort=' + encodeURIComponent('id asc');
    var qs     = '?limit=' + limit + '&offset=' + offset
        + (where ? '&where=' + encodeURIComponent(where) : '') + '&sort=' + sort
        + (options.withTotal === false ? '&withTotal=false' : '') + ORDER_EXPANDS;

    var res = withRetry(function () {
        return http.get(
            c.apiUrl + '/' + c.projectKey + '/orders' + qs,
            { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
        );
    });

    if (res.status !== 200) {
        throw new Error('Failed to fetch orders (' + res.status + ')');
    }

    return {
        results: res.data.results || [],
        total:   res.data.total || 0
    };
}

/**
 * Add each registered order's customerNumber (order.customerNumber), read in one request per
 * page. The customer migration imports customers under customerNumber when it is set, so
 * orders must reference the same number; orders whose customer has none keep the ID.
 * Needs the view_customers scope on the commercetools API client.
 * @param {string} token
 * @param {Object[]} orders - raw commercetools orders of one page (changed in place)
 */
function addCustomerNumbers(token, orders) {
    var c    = cfg.ctp;
    var ids  = [];
    var seen = {};
    var i;
    for (i = 0; i < orders.length; i++) {
        var id = orders[i].customerId;
        if (id && !seen[id]) {
            seen[id] = true;
            ids.push('"' + String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
        }
    }
    if (!ids.length) return;

    var qs = '?limit=' + ids.length + '&withTotal=false&where=' + encodeURIComponent('id in (' + ids.join(', ') + ')');
    var res = withRetry(function () {
        return http.get(
            c.apiUrl + '/' + c.projectKey + '/customers' + qs,
            { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
        );
    });
    if (res.status === 403) {
        throw new Error('Cannot read customer numbers (403): the commercetools API client needs the view_customers scope');
    }
    if (res.status !== 200) {
        throw new Error('Failed to fetch customers (' + res.status + ')');
    }

    var numbers = {};
    var list = res.data.results || [];
    for (i = 0; i < list.length; i++) {
        if (list[i].customerNumber) numbers[list[i].id] = String(list[i].customerNumber);
    }
    for (i = 0; i < orders.length; i++) {
        var no = numbers[orders[i].customerId];
        if (no) orders[i].customerNumber = no;
    }
}

/**
 * Fetch orders by date range with pagination.
 * @param {Object} options
 * @param {number|string} options.years - 1, 2, 3, or 0 / 'all'
 * @param {number} [options.maxCount] - optional cap on orders fetched
 * @param {string} [options.orderState] - commercetools orderState filter
 * @param {string} [options.paymentState] - commercetools paymentState filter
 * @param {Object} [options.creds] - optional credential override
 * @returns {Object[]} raw commercetools order objects
 */
function fetchOrdersByDateRange(options) {
    var years     = parseYears(options.years);
    var maxCount  = options.maxCount ? parseInt(String(options.maxCount), 10) : null;
    var token     = authenticate(options.creds);
    var sinceDate = dateYearsAgo(years);
    var all       = [];
    var offset    = 0;
    var total     = null;
    var pageOpts  = {
        sinceDate:    sinceDate,
        orderState:   options.orderState || '',
        paymentState: options.paymentState || ''
    };

    do {
        var page = fetchOrdersPage(token, {
            sinceDate:    pageOpts.sinceDate,
            orderState:   pageOpts.orderState,
            paymentState: pageOpts.paymentState,
            offset:       offset,
            limit:        DEFAULT_LIMIT
        });
        var results = page.results;
        if (total === null) total = page.total;

        for (var i = 0; i < results.length; i++) {
            all.push(results[i]);
            if (maxCount && all.length >= maxCount) {
                return all;
            }
        }
        offset += results.length;
    } while (offset < total && results.length > 0);

    return all;
}

/**
 * Count orders in [sinceDate, beforeDate). commercetools reports at most 10,000 once a
 * filter is set, so a capped window is split in two until every window is below the cap.
 * @param {string} token
 * @param {Object} filters - { orderState, paymentState }
 * @param {string} sinceDate - ISO lower bound ('' for none)
 * @param {string} beforeDate - ISO upper bound, exclusive ('' for none)
 * @param {number} depth - recursion depth
 * @returns {number}
 */
function countWindow(token, filters, sinceDate, beforeDate, depth) {
    var total = fetchOrdersPage(token, {
        sinceDate:    sinceDate,
        beforeDate:   beforeDate,
        orderState:   filters.orderState,
        paymentState: filters.paymentState,
        offset:       0,
        limit:        1
    }).total || 0;
    var filtered = sinceDate || beforeDate || filters.orderState || filters.paymentState;
    // without a where predicate the total is exact, however large
    if (!filtered || total < CT_RESULT_CAP || depth >= 30) return total;

    var from = sinceDate ? new Date(sinceDate).getTime() : oldestOrderTime(token, filters);
    var to   = beforeDate ? new Date(beforeDate).getTime() : Date.now() + 86400000;
    if (from === null || to - from < 2) return total;
    var mid = new Date(Math.floor((from + to) / 2)).toISOString();
    return countWindow(token, filters, new Date(from).toISOString(), mid, depth + 1)
        + countWindow(token, filters, mid, new Date(to).toISOString(), depth + 1);
}

/**
 * @param {string} token
 * @param {Object} filters - { orderState, paymentState }
 * @returns {number|null} creation time (ms) of the oldest matching order
 */
function oldestOrderTime(token, filters) {
    var page = fetchOrdersPage(token, {
        orderState:   filters.orderState,
        paymentState: filters.paymentState,
        offset:       0,
        limit:        1,
        withTotal:    false
    });
    var first = page.results && page.results[0];
    return first && first.createdAt ? new Date(first.createdAt).getTime() : null;
}

/**
 * Count orders matching filters without fetching full results.
 * @param {Object} options
 * @param {number|string} options.years - 1, 2, 3, or 0 / 'all'
 * @param {number} [options.maxCount] - optional export cap
 * @param {string} [options.orderState] - commercetools orderState filter
 * @param {string} [options.paymentState] - commercetools paymentState filter
 * @param {Object} [options.creds] - optional credential override
 * @returns {Object} { total, exportCount }
 */
function countOrders(options) {
    var years     = parseYears(options.years);
    var maxCount  = options.maxCount ? parseInt(String(options.maxCount), 10) : null;
    var token     = authenticate(options.creds);
    var sinceDate = dateYearsAgo(years);
    var total     = countWindow(token, {
        orderState:   options.orderState || '',
        paymentState: options.paymentState || ''
    }, sinceDate, '', 0);
    var exportCount = total;

    if (maxCount && maxCount > 0 && maxCount < total) {
        exportCount = maxCount;
    }

    return {
        total:       total,
        exportCount: exportCount
    };
}

module.exports = {
    authenticate:            authenticate,
    fetchOrdersByDateRange:  fetchOrdersByDateRange,
    fetchOrdersPage:         fetchOrdersPage,
    addCustomerNumbers:      addCustomerNumbers,
    countOrders:             countOrders,
    buildOrdersWhere:        buildOrdersWhere,
    dateYearsAgo:            dateYearsAgo,
    parseYears:              parseYears,
    DEFAULT_LIMIT:           DEFAULT_LIMIT,
    CT_RESULT_CAP:           CT_RESULT_CAP,
    SUPPORTS_CURSOR:         true,
    MAX_RETRIES:             MAX_RETRIES
};
