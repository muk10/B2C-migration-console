'use strict';

var ProductMgr = require('dw/catalog/ProductMgr');

/**
 * Finds the SFCC product an order line item refers to in the imported catalog.
 *
 * The product migration names a master after the source product and its variants
 * {masterId}-{n}, so the source SKU is not an SFCC product ID. A line item carries the
 * source product ID (or key), the source variant ID and the SKU; the variant is found by
 * {masterId}-{variantId} and confirmed by its manufacturer SKU, falling back to a scan of
 * the master's variants when the position moved. Line items without a source product
 * reference (other platforms) are left as they are.
 */

/**
 * @param {Object} product - dw.catalog.Product
 * @returns {string}
 */
function skuOf(product) {
    return product && product.manufacturerSKU ? String(product.manufacturerSKU) : '';
}

/**
 * @param {Object} master - dw.catalog.Product (master)
 * @param {string} sku
 * @returns {string} variant product ID, or '' when no variant has this SKU
 */
function findVariantBySku(master, sku) {
    var it = master.getVariants().iterator();
    while (it.hasNext()) {
        var v = it.next();
        if (skuOf(v) === sku) return v.ID;
    }
    return '';
}

/**
 * @param {Object} li - canonical line item
 * @returns {string} SFCC product ID, or '' when the catalog has no such product
 */
function lookup(li) {
    var product = (li.sourceProductId && ProductMgr.getProduct(li.sourceProductId))
        || (li.sourceProductKey && ProductMgr.getProduct(li.sourceProductKey))
        || null;
    if (!product) return '';
    if (!product.master) return product.ID;

    var sku = li.sku ? String(li.sku) : '';
    var candidate = li.sourceVariantId != null
        ? ProductMgr.getProduct(product.ID + '-' + li.sourceVariantId) : null;
    if (candidate && (!sku || skuOf(candidate) === sku)) return candidate.ID;
    return sku ? findVariantBySku(product, sku) : '';
}

/**
 * One resolver per export request; repeated products are looked up once.
 * @returns {Object} { resolveOrder(order) → number of line items with no SFCC product }
 */
function createResolver() {
    var cache = {};

    return {
        resolveOrder: function (order) {
            var items = (order && order.lineItems) || [];
            var notFound = 0;
            for (var i = 0; i < items.length; i++) {
                var li = items[i];
                if (!li.sourceProductId && !li.sourceProductKey) continue;
                var key = [li.sourceProductId, li.sourceProductKey, li.sourceVariantId, li.sku].join('|');
                if (!Object.prototype.hasOwnProperty.call(cache, key)) cache[key] = lookup(li);
                if (cache[key]) li.productId = cache[key];
                else notFound++;
            }
            return notFound;
        }
    };
}

module.exports = {
    createResolver: createResolver
};
