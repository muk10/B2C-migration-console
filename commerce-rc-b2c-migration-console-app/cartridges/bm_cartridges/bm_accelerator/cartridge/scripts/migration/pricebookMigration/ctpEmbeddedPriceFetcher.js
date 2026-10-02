'use strict';

var productFetcher = require('*/cartridge/scripts/migration/productMigration/ctpProductFetcher');
var extractor      = require('*/cartridge/scripts/migration/pricebookMigration/embeddedPriceExtractor');

var DISC_PAGE = 250;

// Dominant country per currency, persisted by discovery for the build step to reuse
// when a variant has only country-scoped prices (issue 4).
var DOMINANT_COUNTRY_KEY = 'pbEmbDomCountry';

/**
 * Fetch a page of CT products for price extraction. Uses the lean fetch (no
 * category expansion, which overflows the Service Framework's 10 MB cap) with
 * product-type names attached: bundle/set detection needs them, otherwise a bundle
 * is priced under a non-existent {bundleId}-{n} instead of its plain product-id.
 * fetchBatch already shrinks the page itself when a response is too large.
 * @param {number} offset
 * @param {number} limit
 * @returns {{ results: Array, total: number }}
 */
function fetchProductsLean(offset, limit) {
    return productFetcher.fetchBatchLean(offset, limit || DISC_PAGE);
}

var SESS = {
    agg:     'pbDisc_emb_agg',
    country: 'pbDisc_emb_country',
    offset:  'pbDisc_emb_offset',
    total:   'pbDisc_emb_total'
};

function exportKeySafe(key) {
    return String(key || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readSessionMap(key) {
    try {
        return JSON.parse(String(session.custom[key] || '{}'));
    } catch (e) {
        return {};
    }
}

function writeSessionMap(key, obj) {
    session.custom[key] = JSON.stringify(obj || {});
}

function readDominantCountryMap() {
    try {
        return JSON.parse(String(session.custom[DOMINANT_COUNTRY_KEY] || '{}'));
    } catch (e) {
        return {};
    }
}

/**
 * One full price book per currency. Channel/warehouse books are intentionally not
 * produced (issue 8): channel prices never become SFCC list prices.
 * @param {Object} aggByCurrency - { currency: pricedVariantCount }
 * @returns {Array}
 */
function buildTargetsFromMaps(aggByCurrency) {
    var targets    = [];
    var currencies = Object.keys(aggByCurrency).sort();
    var ci;
    for (ci = 0; ci < currencies.length; ci++) {
        var currency = currencies[ci];
        targets.push({
            exportKey:  'emb_agg_' + exportKeySafe(currency),
            label:      currency + ' — Full price book',
            subLabel:   'Every priced variant in ' + currency
                + ' (base price; customer-group, channel and expired prices excluded)',
            currency:   currency,
            channelId:  'all',
            channelKey: '',
            aggregate:  true,
            priceCount: aggByCurrency[currency],
            source:     'embedded'
        });
    }
    return targets;
}

function clearEmbeddedDiscovery() {
    session.custom[SESS.offset] = '0';
    session.custom[SESS.total]  = '';
    writeSessionMap(SESS.agg, {});
    writeSessionMap(SESS.country, {});
}

/**
 * Process one page of products for embedded-price discovery.
 * @param {number} offset
 * @param {boolean} reset
 * @returns {Object}
 */
function discoverEmbeddedStep(offset, reset) {
    if (reset || offset === 0) {
        clearEmbeddedDiscovery();
    }

    var agg       = readSessionMap(SESS.agg);
    var countryBy = readSessionMap(SESS.country);
    var curOffset = parseInt(session.custom[SESS.offset] || '0', 10);
    if (offset > 0) {
        curOffset = offset;
    }

    var batch = fetchProductsLean(curOffset, DISC_PAGE);
    if (!session.custom[SESS.total]) {
        session.custom[SESS.total] = String(batch.total || 0);
    }

    var i;
    for (i = 0; i < batch.results.length; i++) {
        extractor.scanProductForDiscovery(batch.results[i], agg, countryBy);
    }
    writeSessionMap(SESS.agg, agg);
    writeSessionMap(SESS.country, countryBy);

    var total      = parseInt(session.custom[SESS.total], 10) || 0;
    var nextOffset = curOffset + batch.results.length;
    session.custom[SESS.offset] = String(nextOffset);

    var done = batch.results.length === 0 || nextOffset >= total;
    if (!done) {
        return {
            done:         false,
            nextOffset:   nextOffset,
            scanned:      nextOffset,
            total:        total,
            productTotal: total,
            embedded:     []
        };
    }

    // Persist the dominant country per currency so the build step selects the same
    // country for country-only variants (issue 4).
    session.custom[DOMINANT_COUNTRY_KEY] = JSON.stringify(extractor.dominantCountryByCurrency(countryBy));

    var targets = buildTargetsFromMaps(agg);
    clearEmbeddedDiscovery();
    return {
        done:         true,
        nextOffset:   nextOffset,
        scanned:      total,
        total:        total,
        productTotal: total,
        embedded:     targets
    };
}

/**
 * Scan all products and discover embedded pricebook targets (one per currency).
 * @returns {Array}
 */
function discoverEmbeddedPricebookTargets() {
    var result = discoverEmbeddedStep(0, true);
    while (!result.done) {
        result = discoverEmbeddedStep(result.nextOffset, false);
    }
    return result.embedded || [];
}

/**
 * Count list-price records for a currency by scanning all products.
 * @param {string} currency
 * @param {string} [channelId]
 * @param {boolean} [aggregate]
 * @returns {number}
 */
function getPriceCount(currency, channelId, aggregate) {
    var total  = 0;
    var offset = 0;
    var grand  = null;
    var batch;
    var opts   = { dominantCountry: readDominantCountryMap()[currency] || null, nowMs: Date.now() };

    // Loop on offset vs. total, not page===limit: fetchProductsLean may return a
    // smaller page than requested when it halves to stay under the 10 MB cap.
    do {
        batch = fetchProductsLean(offset, DISC_PAGE);
        if (grand === null) grand = batch.total || 0;
        var i;
        for (i = 0; i < batch.results.length; i++) {
            total += extractor.extractRecordsFromProduct(
                batch.results[i], currency, channelId, aggregate, opts
            ).length;
        }
        offset += batch.results.length;
    } while (batch.results.length > 0 && offset < grand);

    return total;
}

/**
 * Fetch one batch of products and extract list-price records for a currency.
 * @param {number} offset - product offset
 * @param {number} limit
 * @param {string} currency
 * @param {string} [channelId]
 * @param {boolean} [aggregate]
 * @returns {{ records: Array, total: number, nextOffset: number, done: boolean }}
 */
function fetchPriceRecordsBatch(offset, limit, currency, channelId, aggregate) {
    var batch   = fetchProductsLean(offset, limit || DISC_PAGE);
    var total   = batch.total;
    var records = [];
    var opts    = { dominantCountry: readDominantCountryMap()[currency] || null, nowMs: Date.now() };
    var i;

    for (i = 0; i < batch.results.length; i++) {
        var productRecords = extractor.extractRecordsFromProduct(
            batch.results[i], currency, channelId, aggregate, opts
        );
        if (productRecords.length) {
            records = records.concat(productRecords);
        }
    }

    var nextOffset = offset + batch.results.length;
    return {
        records:    records,
        total:      total,
        nextOffset: nextOffset,
        done:       nextOffset >= total || batch.results.length === 0
    };
}

module.exports = {
    discoverEmbeddedPricebookTargets: discoverEmbeddedPricebookTargets,
    discoverEmbeddedStep:           discoverEmbeddedStep,
    getPriceCount:                  getPriceCount,
    getProductCount:                productFetcher.getCount,
    fetchPriceRecordsBatch:         fetchPriceRecordsBatch
};
