'use strict';

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
 * Build SFCC inventory XML from CT inventory entries.
 *
 * @param {Array}  inventoryEntries - raw CT inventory entry objects from ctpInventoryFetcher
 * @param {string} listId           - target SFCC inventory list ID (e.g. "default-inventory")
 * @returns {{ xml: string, built: number }}
 */
function buildXml(inventoryEntries, listId) {
    var lid   = listId || 'default-inventory';
    var built = 0;
    var rows  = '';

    for (var i = 0; i < inventoryEntries.length; i++) {
        var entry = inventoryEntries[i];
        if (!entry.sku) continue;
        var qty      = typeof entry.quantityOnStock === 'number' ? entry.quantityOnStock : 0;
        var preorder = entry.restockableInDays != null && entry.restockableInDays > 0;

        rows += '            <record product-id="' + xmlEsc(entry.sku) + '">\n';
        rows += '                <allocation>' + qty + '</allocation>\n';
        rows += '                <perpetual>false</perpetual>\n';
        rows += '                <preorder-backorder-handling>'
            + (preorder ? 'preorder' : 'none') + '</preorder-backorder-handling>\n';
        rows += '            </record>\n';
        built++;
    }

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<inventory xmlns="http://www.demandware.com/xml/impex/inventory/2007-05-31">\n'
        + '    <inventory-list>\n'
        + '        <header list-id="' + xmlEsc(lid) + '">\n'
        + '            <default-instock>true</default-instock>\n'
        + '        </header>\n'
        + '        <records>\n'
        + rows
        + '        </records>\n'
        + '    </inventory-list>\n'
        + '</inventory>\n';

    return { xml: xml, built: built };
}

module.exports = { buildXml: buildXml };
