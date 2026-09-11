'use strict';

var runtimeAttrMap = require('*/cartridge/scripts/migration/core/runtimeAttrMap');

var NS_STORE = 'http://www.demandware.com/xml/impex/store/2007-04-30';

var STORE_SYSTEM_KEYS = {
    name: 'name',
    address1: 'address1',
    address2: 'address2',
    city: 'city',
    postalCode: 'postalCode',
    stateCode: 'stateCode',
    countryCode: 'countryCode',
    email: 'email',
    phone: 'phone',
    fax: 'fax',
    latitude: 'latitude',
    longitude: 'longitude',
    image: 'image',
    inventoryListID: 'inventoryListId',
    storeHours: 'storeHours',
    storeEvents: 'storeEvents',
    storeLocatorEnabled: 'storeLocatorEnabled',
    posEnabled: 'posEnabled'
};

function xmlEsc(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

function optionalElement(tag, value, maxLen) {
    if (value === null || value === undefined || value === '') return '';
    var s = String(value);
    if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
    return '        <' + tag + '>' + xmlEsc(s) + '</' + tag + '>\n';
}

function localizedText(tag, value) {
    if (value === null || value === undefined || value === '') return '';
    return '        <' + tag + ' xml:lang="x-default">' + xmlEsc(value) + '</' + tag + '>\n';
}

function buildCustomAttributes(custom) {
    if (!custom || !custom.length) return '';
    var rows = '';
    var i;
    for (i = 0; i < custom.length; i++) {
        var ca = custom[i];
        if (!ca || !ca.id || ca.value === '' || ca.value == null) continue;
        rows += '            <custom-attribute attribute-id="' + xmlEsc(ca.id) + '">'
            + xmlEsc(runtimeAttrMap.formatCustomAttrValue(ca.value)) + '</custom-attribute>\n';
    }
    if (!rows) return '';
    return '        <custom-attributes>\n' + rows + '        </custom-attributes>\n';
}

function buildStoreXml(store, attrMap) {
    var mapped = runtimeAttrMap.apply(store.customAttributes || {}, 'store', attrMap);
    runtimeAttrMap.mergeIfEmpty(store, mapped.system, STORE_SYSTEM_KEYS);

    var rows = '    <store store-id="' + xmlEsc(store.storeId) + '">\n'
        + '        <name>' + xmlEsc(store.name) + '</name>\n'
        + optionalElement('address1', store.address1)
        + optionalElement('address2', store.address2)
        + optionalElement('city', store.city)
        + optionalElement('postal-code', store.postalCode)
        + optionalElement('state-code', store.stateCode)
        + optionalElement('country-code', store.countryCode, 2)
        + optionalElement('email', store.email)
        + optionalElement('phone', store.phone)
        + optionalElement('fax', store.fax)
        + localizedText('store-events', store.storeEvents)
        + localizedText('store-hours', store.storeHours)
        + optionalElement('image', store.image)
        + optionalElement('latitude', store.latitude)
        + optionalElement('longitude', store.longitude)
        + optionalElement('inventory-list-id', store.inventoryListId)
        + '        <store-locator-enabled-flag>' + (store.storeLocatorEnabled ? 'true' : 'false') + '</store-locator-enabled-flag>\n'
        + '        <demandware-pos-enabled-flag>' + (store.demandwarePosEnabled ? 'true' : 'false') + '</demandware-pos-enabled-flag>\n'
        + '        <pos-enabled-flag>' + (store.posEnabled ? 'true' : 'false') + '</pos-enabled-flag>\n'
        + buildCustomAttributes(mapped.custom)
        + '    </store>\n';
    return rows;
}

/**
 * Build SFCC stores IMPEX XML matching sample-store.xml structure.
 * @param {Array} stores
 * @returns {{ xml: string, built: number, failed: number, errors: Array }}
 */
function buildXml(stores) {
    var built  = 0;
    var failed = 0;
    var errors = [];
    var body   = '';
    var i;

    var list = stores || [];
    for (i = 0; i < list.length; i++) {
        try {
            body += buildStoreXml(list[i]);
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 5) errors.push('store: ' + (e.message || String(e)));
        }
    }

    var xml = buildHeader() + body + buildFooter();

    return { xml: xml, built: built, failed: failed, errors: errors };
}

function buildHeader() {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<stores xmlns="' + NS_STORE + '">\n';
}

function buildFooter() {
    return '</stores>\n';
}

module.exports = {
    buildXml:       buildXml,
    buildHeader:    buildHeader,
    buildFooter:    buildFooter,
    buildStoreXml:  buildStoreXml,
    NS_STORE:       NS_STORE
};
