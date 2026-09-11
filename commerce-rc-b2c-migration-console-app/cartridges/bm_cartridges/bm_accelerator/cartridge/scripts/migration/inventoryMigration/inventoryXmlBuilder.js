'use strict';

var runtimeAttrMap = require('*/cartridge/scripts/migration/core/runtimeAttrMap');

var NS_INVENTORY = 'http://www.demandware.com/xml/impex/inventory/2007-05-31';

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
 * @param {Object} record
 * @returns {string}
 */
function buildRecordXml(record, attrMap) {
    var mapped = runtimeAttrMap.apply(record.customAttributes || {}, 'inventory', attrMap);
    runtimeAttrMap.mergeIfEmpty(record, mapped.system, { allocation: 'allocation' });

    var productId = record.productId || record.sku;
    var xml = '            <record product-id="' + xmlEsc(productId) + '">\n';
    xml += '                <allocation>' + record.allocation + '</allocation>\n';
    if (record.allocationTimestamp) {
        xml += '                <allocation-timestamp>' + xmlEsc(record.allocationTimestamp) + '</allocation-timestamp>\n';
    }
    xml += '                <perpetual>' + (record.perpetual ? 'true' : 'false') + '</perpetual>\n';
    xml += '                <preorder-backorder-handling>' + xmlEsc(record.preorderBackorder || 'none')
        + '</preorder-backorder-handling>\n';
    // ats / on-order / turnover are export-only (inventory.xsd); do not emit on import.
    if (mapped.custom && mapped.custom.length) {
        xml += '                <custom-attributes>\n';
        for (var i = 0; i < mapped.custom.length; i++) {
            var ca = mapped.custom[i];
            if (!ca || !ca.id || ca.value === '' || ca.value == null) continue;
            xml += '                    <custom-attribute attribute-id="' + xmlEsc(ca.id) + '">'
                + xmlEsc(runtimeAttrMap.formatCustomAttrValue(ca.value)) + '</custom-attribute>\n';
        }
        xml += '                </custom-attributes>\n';
    }
    xml += '            </record>\n';
    return xml;
}

/**
 * XML header through opening &lt;records&gt; tag.
 * @param {string} listId
 * @param {string} [description]
 * @returns {string}
 */
function buildHeader(listId, description) {
    var lid  = listId || 'inventory';
    var desc = description || 'Commercetools inventory migration';
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<inventory xmlns="' + NS_INVENTORY + '">\n'
        + '    <inventory-list>\n'
        + '        <header list-id="' + xmlEsc(lid) + '">\n'
        + '            <default-instock>false</default-instock>\n'
        + '            <description>' + xmlEsc(desc) + '</description>\n'
        + '            <use-bundle-inventory-only>false</use-bundle-inventory-only>\n'
        + '            <on-order>false</on-order>\n'
        + '        </header>\n'
        + '        <records>\n';
}

/**
 * Closing tags after &lt;/records&gt;.
 * @returns {string}
 */
function buildFooter() {
    return '        </records>\n'
        + '    </inventory-list>\n'
        + '</inventory>\n';
}

/**
 * Build SFCC inventory-list IMPEX XML from canonical records.
 * @param {Array} records - from inventoryTransformer.aggregateBySku
 * @param {string} listId - target SFCC inventory list ID
 * @param {string} [description]
 * @returns {{ xml: string, built: number, failed: number, errors: Array }}
 */
function buildXml(records, listId, description) {
    var lid    = listId || 'inventory';
    var desc   = description || 'Source inventory migration';
    var built  = 0;
    var failed = 0;
    var errors = [];
    var rows   = '';

    for (var i = 0; i < records.length; i++) {
        try {
            if (!records[i] || !(records[i].productId || records[i].sku)) {
                failed++;
                continue;
            }
            rows += buildRecordXml(records[i]);
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) {
                errors.push((records[i].sku || '?') + ': ' + (e.message || String(e)));
            }
        }
    }

    var xml = buildHeader(lid, desc)
        + rows
        + buildFooter();

    return { xml: xml, built: built, failed: failed, errors: errors };
}

module.exports = {
    buildXml:       buildXml,
    buildHeader:    buildHeader,
    buildFooter:    buildFooter,
    buildRecordXml: buildRecordXml,
    NS_INVENTORY:   NS_INVENTORY
};
