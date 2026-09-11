'use strict';

var transformer = require('*/cartridge/scripts/migration/shippingMethodMigration/shippingMethodTransformer');
var runtimeAttrMap = require('*/cartridge/scripts/migration/core/runtimeAttrMap');

var NS_SHIPPING = 'http://www.demandware.com/xml/impex/shipping/2007-03-31';

function xmlEsc(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

/**
 * @param {string} tagName
 * @param {Array<{lang: string, value: string}>} entries
 * @param {string} indent
 * @returns {string}
 */
function buildLocalizedElementsXml(tagName, entries, indent) {
    var xml = '';
    if (!entries || !entries.length) return xml;

    var xdefaultValue = null;
    for (var i = 0; i < entries.length; i++) {
        if (entries[i] && entries[i].lang === 'x-default') {
            xdefaultValue = entries[i].value;
            break;
        }
    }

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry || !entry.value) continue;

        var shouldSkip = entry.lang !== 'x-default' && xdefaultValue !== null && entry.value === xdefaultValue;
        if (shouldSkip) {
            continue;
        }

        xml += indent + '<' + tagName + ' xml:lang="' + xmlEsc(entry.lang) + '">'
            + xmlEsc(entry.value) + '</' + tagName + '>\n';
    }
    return xml;
}

function buildCustomAttributesXml(method, attrMap) {
    var scalarFields = {};
    var keys = Object.keys(method);
    var i;
    var j;
    for (i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.length > 2 && k.charAt(0) === 'c' && k.charAt(1) === '_') {
            scalarFields[k] = method[k];
        }
    }
    var mapped = runtimeAttrMap.apply(scalarFields, 'shippingMethod', attrMap);
    runtimeAttrMap.mergeIfEmpty(method, mapped.system, {
        taxClassID: 'tax_class_id',
        displayName: 'display_name',
        description: 'description'
    });

    var xml  = '';
    var has  = false;
    var localized = method.localized_custom || [];
    for (i = 0; i < localized.length; i++) {
        var item = localized[i];
        if (!item || !item.id) continue;
        var classified = runtimeAttrMap.classifyId(item.id, 'shippingMethod', attrMap);
        if (classified.systemId) continue;
        var targetId = classified.customId || item.id;

        var xdefaultValue = null;
        for (j = 0; j < item.entries.length; j++) {
            if (item.entries[j] && item.entries[j].lang === 'x-default') {
                xdefaultValue = item.entries[j].value;
                break;
            }
        }
        for (j = 0; j < item.entries.length; j++) {
            var entry = item.entries[j];
            if (!entry || !entry.value) continue;

            var shouldSkip = entry.lang !== 'x-default' && xdefaultValue !== null && entry.value === xdefaultValue;
            if (shouldSkip) {
                continue;
            }

            if (!has) { has = true; }
            xml += '            <custom-attribute attribute-id="' + xmlEsc(targetId)
                + '" xml:lang="' + xmlEsc(entry.lang) + '">'
                + xmlEsc(entry.value) + '</custom-attribute>\n';
        }
    }

    for (i = 0; i < (mapped.custom || []).length; i++) {
        var ca = mapped.custom[i];
        if (!ca || !ca.id || ca.value === '' || ca.value == null) continue;
        if (!has) { has = true; }
        xml += '            <custom-attribute attribute-id="' + xmlEsc(ca.id)
            + '" xml:lang="x-default">'
            + xmlEsc(runtimeAttrMap.formatCustomAttrValue(ca.value)) + '</custom-attribute>\n';
    }

    if (!has) return '';
    return '        <custom-attributes>\n' + xml + '        </custom-attributes>\n';
}

/**
 * SFCC ties one currency to one shipping-method record, so a CT method with rates in
 * multiple currencies becomes multiple SFCC methods here — one per currency. The method-id
 * is only suffixed with the currency when there's more than one variant, so single-currency
 * methods keep their existing plain id.
 * @param {Object} ctpMethod
 * @returns {string}
 */
function buildShippingMethodXml(ctpMethod) {
    var method   = transformer.transformShippingMethod(ctpMethod);
    var variants = (method.priceVariants && method.priceVariants.length)
        ? method.priceVariants
        : [{ price: method.price, currency: method.currency }];
    var xml = '';

    for (var v = 0; v < variants.length; v++) {
        var variant  = variants[v];
        var methodId = variants.length > 1
            ? (method.method_id + '-' + variant.currency)
            : method.method_id;

        xml += '    <shipping-method method-id="' + xmlEsc(methodId) + '"'
            + ' default="' + (method.is_default ? 'true' : 'false') + '">\n';
        xml += buildLocalizedElementsXml('display-name', method.display_names, '        ');
        xml += buildLocalizedElementsXml('description', method.descriptions, '        ');
        xml += '        <online-flag>' + (method.online_flag ? 'true' : 'false') + '</online-flag>\n';
        xml += '        <tax-class-id>' + xmlEsc(method.tax_class_id || 'standard') + '</tax-class-id>\n';
        xml += '        <price-table>\n';
        xml += '            <amount order-value="0">' + xmlEsc(formatPrice(variant.price)) + '</amount>\n';
        xml += '        </price-table>\n';
        xml += buildCustomAttributesXml(method);
        if (variant.currency) {
            xml += '        <currency>' + xmlEsc(variant.currency) + '</currency>\n';
        }
        xml += '    </shipping-method>\n';
    }

    return xml;
}

/**
 * Build SFCC shipping import XML for a batch of CT shipping methods.
 * @param {Array} ctpMethods
 * @returns {{ xml: string, built: number, failed: number, errors: Array }}
 */
function buildXml(ctpMethods) {
    var built  = 0;
    var failed = 0;
    var errors = [];
    var body   = '';

    for (var i = 0; i < ctpMethods.length; i++) {
        try {
            body += buildShippingMethodXml(ctpMethods[i]);
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) {
                errors.push((ctpMethods[i].key || ctpMethods[i].id) + ': ' + (e.message || String(e)));
            }
        }
    }

    var xml = buildHeader() + body + buildFooter();

    return { xml: xml, built: built, failed: failed, errors: errors };
}

function buildHeader() {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<shipping xmlns="' + NS_SHIPPING + '">\n';
}

function buildFooter() {
    return '</shipping>\n';
}

function formatPrice(val) {
    var n = parseFloat(val);
    if (isNaN(n) || n === 0) return '0';
    return n.toFixed(2);
}

module.exports = {
    buildXml:               buildXml,
    buildHeader:            buildHeader,
    buildFooter:            buildFooter,
    buildShippingMethodXml: buildShippingMethodXml,
    NS_SHIPPING:            NS_SHIPPING
};

