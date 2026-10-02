'use strict';

var productTransformer = require('*/cartridge/scripts/migration/productMigration/productTransformer');

function toDecimal(value) {
    if (!value || typeof value.centAmount !== 'number') return '';
    var digits  = typeof value.fractionDigits === 'number' ? value.fractionDigits : 2;
    var divisor = Math.pow(10, digits);
    return (value.centAmount / divisor).toFixed(digits);
}

/**
 * A CT price is a valid SFCC list price only if it is currently effective.
 * validFrom in the future or validUntil in the past (issue 6: expired prices)
 * disqualifies it.
 * @param {Object} p - CT price entry
 * @param {number} nowMs
 * @returns {boolean}
 */
function isPriceValidNow(p, nowMs) {
    if (p.validFrom) {
        var from = Date.parse(p.validFrom);
        if (!isNaN(from) && from > nowMs) return false;
    }
    if (p.validUntil) {
        var until = Date.parse(p.validUntil);
        if (!isNaN(until) && until <= nowMs) return false;
    }
    return true;
}

/**
 * Whether a CT price may become the normal SFCC list price.
 * Excludes customer-group prices (issue 5) and channel/warehouse prices (issue 8),
 * neither of which SFCC list price books represent, plus expired prices (issue 6).
 * Country is allowed here and resolved later by selectListPrice.
 * @param {Object} p
 * @param {string} currency
 * @param {number} nowMs
 * @returns {boolean}
 */
function isListEligible(p, currency, nowMs) {
    if (!p || !p.value || p.value.currencyCode !== currency) return false;
    if (p.customerGroup) return false;
    if (p.channel) return false;
    if (!isPriceValidNow(p, nowMs)) return false;
    return true;
}

/**
 * Pick the price whose amount is the most common among the candidates; ties break
 * to the lowest amount. Deterministic fallback for country-only variants when no
 * dominant country price is present (issue 4).
 * @param {Array} eligible
 * @returns {Object|null}
 */
function pickModalPrice(eligible) {
    var counts = {};
    var i;
    for (i = 0; i < eligible.length; i++) {
        var a = toDecimal(eligible[i].value);
        if (!a) continue;
        counts[a] = (counts[a] || 0) + 1;
    }
    var keys = Object.keys(counts);
    if (!keys.length) return null;
    var bestAmt   = null;
    var bestCount = -1;
    for (i = 0; i < keys.length; i++) {
        var amt = keys[i];
        var c   = counts[amt];
        if (c > bestCount || (c === bestCount && parseFloat(amt) < parseFloat(bestAmt))) {
            bestCount = c;
            bestAmt   = amt;
        }
    }
    for (i = 0; i < eligible.length; i++) {
        if (toDecimal(eligible[i].value) === bestAmt) return eligible[i];
    }
    return null;
}

/**
 * Choose the single SFCC list price for one variant in one currency.
 * Preference: base (no-country) price -> the catalog's dominant country -> the most
 * common amount across the remaining country prices (issue 4).
 * @param {Array} prices - CT variant prices
 * @param {string} currency
 * @param {number} nowMs
 * @param {string} [dominantCountry]
 * @returns {Object|null} chosen CT price entry
 */
function selectListPrice(prices, currency, nowMs, dominantCountry) {
    if (!prices || !prices.length) return null;
    var eligible = [];
    var i;
    for (i = 0; i < prices.length; i++) {
        if (isListEligible(prices[i], currency, nowMs)) eligible.push(prices[i]);
    }
    if (!eligible.length) return null;

    for (i = 0; i < eligible.length; i++) {
        if (!eligible[i].country) return eligible[i];
    }
    if (dominantCountry) {
        for (i = 0; i < eligible.length; i++) {
            if (eligible[i].country === dominantCountry) return eligible[i];
        }
    }
    return pickModalPrice(eligible);
}

/**
 * Build the SFCC price record for one variant.
 * productId is the SFCC catalog product-id ({masterId}-{n} or {masterId}), never the SKU.
 * @param {string} productId
 * @param {string} sku
 * @param {Object} priceEntry - chosen CT price
 * @returns {Object|null}
 */
function toRecord(productId, sku, priceEntry) {
    if (!productId || !priceEntry || !priceEntry.value) return null;
    var amount = toDecimal(priceEntry.value);
    if (!amount) return null;

    // Trim the SKU the same way the product export does, so SKU-based lookups match.
    var cleanSku = sku ? String(sku).trim() : '';

    var record = {
        productId:  productId,
        sku:        cleanSku || productId,
        amount:     amount,
        currency:   priceEntry.value.currencyCode,
        hasChannel: false
    };

    // CT quantity tiers -> SFCC price-table quantity-based <amount> rows.
    if (priceEntry.tiers && priceEntry.tiers.length) {
        var tiers = [];
        var ti;
        for (ti = 0; ti < priceEntry.tiers.length; ti++) {
            var tier       = priceEntry.tiers[ti];
            var tierAmount = tier.value ? toDecimal(tier.value) : '';
            if (tierAmount && tier.minimumQuantity) {
                tiers.push({ quantity: tier.minimumQuantity, amount: tierAmount });
            }
        }
        if (tiers.length) record.tiers = tiers;
    }

    return record;
}

/**
 * The variants a price can attach to, in the SFCC catalog's terms:
 *   - variation master -> its variant products ({masterId}-{n})
 *   - set / bundle      -> the master product ({masterId}) only
 * @param {Object} identity - productTransformer.getVariantProductIds result
 * @returns {Array<{ productId: string, sku: string, source: Object }>}
 */
function sellableUnits(identity) {
    if (identity.isVariationMaster) return identity.variants;
    var mv = identity.variants[0];
    if (!mv) return [];
    return [{ productId: identity.masterId, sku: mv.sku, source: mv.source }];
}

/**
 * Extract SFCC list-price records from one CT product for a currency.
 * One record per sellable unit; product-ids match the product migration exactly.
 * channelId/aggregate are accepted for signature compatibility but list prices are
 * always aggregated to one price per unit with channel prices excluded.
 * @param {Object} ctpProduct
 * @param {string} currency
 * @param {string} [channelId] - ignored (channel prices are never list prices)
 * @param {boolean} [aggregate] - ignored (always one price per unit)
 * @param {{ dominantCountry?: string, nowMs?: number }} [options]
 * @returns {Array}
 */
function extractRecordsFromProduct(ctpProduct, currency, channelId, aggregate, options) {
    var opts            = options || {};
    var nowMs           = (typeof opts.nowMs === 'number') ? opts.nowMs : Date.now();
    var dominantCountry = opts.dominantCountry || null;
    var identity        = productTransformer.getVariantProductIds(ctpProduct);
    var units           = sellableUnits(identity);
    var records         = [];
    var i;

    for (i = 0; i < units.length; i++) {
        var prices = (units[i].source && units[i].source.prices) || [];
        var chosen = selectListPrice(prices, currency, nowMs, dominantCountry);
        if (!chosen) continue;
        var rec = toRecord(units[i].productId, units[i].sku, chosen);
        if (rec) records.push(rec);
    }
    return records;
}

/**
 * Discovery counters for one product: per-currency priced-unit counts and, for
 * country-only currencies, per-country row counts used to pick the dominant
 * country (issue 4). Only list-eligible prices are counted.
 * @param {Object} ctpProduct
 * @param {Object} aggByCurrency - { currency: count }
 * @param {Object} countryByCur  - { currency: { country: count } }
 * @param {number} [nowMs]
 */
function scanProductForDiscovery(ctpProduct, aggByCurrency, countryByCur, nowMs) {
    var now      = (typeof nowMs === 'number') ? nowMs : Date.now();
    var identity = productTransformer.getVariantProductIds(ctpProduct);
    var units    = sellableUnits(identity);
    var i;
    var j;

    for (i = 0; i < units.length; i++) {
        var prices  = (units[i].source && units[i].source.prices) || [];
        var seenCur = {};
        for (j = 0; j < prices.length; j++) {
            var p = prices[j];
            if (!isListEligible(p, p && p.value ? p.value.currencyCode : '', now)) continue;
            var cur = p.value.currencyCode;
            if (!seenCur[cur]) {
                seenCur[cur] = true;
                if (!aggByCurrency[cur]) aggByCurrency[cur] = 0;
                aggByCurrency[cur]++;
            }
            if (p.country) {
                if (!countryByCur[cur]) countryByCur[cur] = {};
                countryByCur[cur][p.country] = (countryByCur[cur][p.country] || 0) + 1;
            }
        }
    }
}

/**
 * The most common country per currency, used as the fallback list price for
 * country-only variants (issue 4).
 * @param {Object} countryByCur - { currency: { country: count } }
 * @returns {Object.<string,string>} { currency: country }
 */
function dominantCountryByCurrency(countryByCur) {
    var out  = {};
    var curs = Object.keys(countryByCur || {});
    var i;
    var j;
    for (i = 0; i < curs.length; i++) {
        var cur       = curs[i];
        var byC       = countryByCur[cur];
        var countries = Object.keys(byC).sort();
        var best      = '';
        var bestCount = -1;
        for (j = 0; j < countries.length; j++) {
            if (byC[countries[j]] > bestCount) {
                bestCount = byC[countries[j]];
                best      = countries[j];
            }
        }
        if (best) out[cur] = best;
    }
    return out;
}

module.exports = {
    extractRecordsFromProduct: extractRecordsFromProduct,
    scanProductForDiscovery:   scanProductForDiscovery,
    dominantCountryByCurrency: dominantCountryByCurrency,
    selectListPrice:           selectListPrice,
    isListEligible:            isListEligible,
    isPriceValidNow:           isPriceValidNow,
    toDecimal:                 toDecimal
};
