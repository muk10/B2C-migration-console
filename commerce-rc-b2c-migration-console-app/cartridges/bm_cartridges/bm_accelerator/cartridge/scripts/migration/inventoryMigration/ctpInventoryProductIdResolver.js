'use strict';

/**
 * Build a SKU -> SFCC product-id resolver for CT inventory. CT inventory entries
 * carry only a SKU, so this scans every CT product once (read-only) and maps each
 * variant's SKU to the exact product-id the product migration emits ({masterId}-{n},
 * or {masterId} for sets/bundles). Uses the same getVariantProductIds() rule as the
 * price book migration so inventory and prices land on identical product-ids.
 */

var productFetcher     = require('*/cartridge/scripts/migration/productMigration/ctpProductFetcher');
var productTransformer = require('*/cartridge/scripts/migration/productMigration/productTransformer');

var PAGE_SIZE = 250;

/**
 * The SKU -> product-id pairs for one product, matching the price book's sellable
 * units: variation masters map each variant SKU to {masterId}-{n}; sets/bundles map
 * the master variant SKU to {masterId}.
 * @param {Object} identity - productTransformer.getVariantProductIds result
 * @returns {Array<{ sku: string, productId: string }>}
 */
function unitsForIdentity(identity) {
    if (identity.isVariationMaster) return identity.variants;
    var mv = identity.variants[0];
    if (!mv) return [];
    return [{ sku: mv.sku, productId: identity.masterId }];
}

/**
 * Scan all CT products and return a resolver.
 * dw.util.HashMap (not a plain object) holds the map: a catalog can have more than
 * api.jsObjectSize (2000) variants.
 * @returns {function(string): string} resolver; '' for a SKU with no migrated product
 */
function build() {
    var HashMap = require('dw/util/HashMap');
    var map     = new HashMap();
    var offset  = 0;
    var total   = null;
    var results = [];

    do {
        // Lean page with product-type names, so bundles/sets resolve to {masterId}.
        var batch = productFetcher.fetchBatchLean(offset, PAGE_SIZE);
        if (total === null) total = batch.total || 0;
        results = batch.results || [];
        var i;
        for (i = 0; i < results.length; i++) {
            var units = unitsForIdentity(productTransformer.getVariantProductIds(results[i]));
            var u;
            for (u = 0; u < units.length; u++) {
                var sku = units[u].sku ? String(units[u].sku).trim() : '';
                if (sku && units[u].productId && !map.containsKey(sku)) {
                    map.put(sku, units[u].productId);
                }
            }
        }
        offset += results.length;
    } while (results.length > 0 && offset < total);

    return function (sku) {
        var key = sku ? String(sku).trim() : '';
        if (!key) return '';
        var v = map.get(key);
        return v ? String(v) : '';
    };
}

module.exports = { build: build };
