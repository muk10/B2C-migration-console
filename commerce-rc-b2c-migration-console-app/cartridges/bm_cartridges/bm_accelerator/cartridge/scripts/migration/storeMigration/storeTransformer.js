'use strict';

var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
var fetcher  = registry.getFetcher('store');

var MODULE_KEY = 'store';

function getLocalized(obj) {
    return fetcher.getLocalized(obj);
}

function sanitizeStoreId(str) {
    if (!str) return '';
    return String(str)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

function buildAddressLine(addr) {
    if (!addr) return '';
    var parts = [];
    if (addr.streetNumber) parts.push(addr.streetNumber);
    if (addr.streetName) parts.push(addr.streetName);
    if (!parts.length && addr.additionalStreetInfo) {
        parts.push(addr.additionalStreetInfo);
    }
    return parts.join(' ').trim();
}

function stateCode(addr) {
    if (!addr || !addr.state) return '';
    var state = String(addr.state).trim();
    if (state.length <= 3) return state.toUpperCase();
    return state;
}

function parseGeoLocation(geo) {
    if (!geo || geo.type !== 'Point' || !geo.coordinates || geo.coordinates.length < 2) {
        return { latitude: '', longitude: '' };
    }
    return {
        longitude: String(geo.coordinates[0]),
        latitude:  String(geo.coordinates[1])
    };
}

function firstCountry(store) {
    var countries = store && store.countries ? store.countries : [];
    if (!countries.length) return '';
    var first = countries[0];
    // CT Store.countries is an array of StoreCountry objects ({ code: "US" }), not plain strings.
    return (first && typeof first === 'object') ? (first.code || '') : first;
}

function readAttrIdMap() {
    return attrIdMapSession.read(MODULE_KEY);
}

function clearAttrIdMap() {
    attrIdMapSession.clear(MODULE_KEY);
}

function saveAttrIdMapFromAttrs(attrs) {
    attrIdMapSession.saveFromAttrs(MODULE_KEY, attrs);
}

/**
 * Serialize a CT custom field value for store IMPEX XML.
 * @param {*} val
 * @returns {string}
 */
function formatCustomFieldValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'boolean' || typeof val === 'number') return String(val);
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
        var parts = [];
        var ai;
        for (ai = 0; ai < val.length; ai++) {
            var item = formatCustomFieldValue(val[ai]);
            if (item) parts.push(item);
        }
        return parts.join(',');
    }
    if (typeof val === 'object') {
        if (val.centAmount !== undefined && val.currencyCode) {
            var digits = typeof val.fractionDigits === 'number' ? val.fractionDigits : 2;
            return (val.centAmount / Math.pow(10, digits)).toFixed(digits) + ' ' + val.currencyCode;
        }
        if (val.id && (val.typeId || val.type_id)) {
            return String(val.id);
        }
        var localized = getLocalized(val);
        if (localized) return localized;
        try {
            return JSON.stringify(val);
        } catch (e) {
            return '';
        }
    }
    return String(val);
}

/**
 * Resolve SFCC attribute-id for a source field (applies user renames).
 * @param {string} sourceId
 * @param {Object.<string, string>} [attrIdMap]
 * @returns {string}
 */
function resolveAttrId(sourceId, attrIdMap) {
    return attrIdMapSession.resolve(sourceId, attrIdMap || readAttrIdMap());
}

function buildCustomAttributes(storeId, country, store, channel) {
    var attrs = {};

    // Only CT Type / source custom fields — no hardcoded migration trace attrs
    if (store && store.custom && store.custom.fields) {
        var fields = store.custom.fields;
        var keys   = Object.keys(fields);
        var i;
        for (i = 0; i < keys.length; i++) {
            var sourceKey = keys[i];
            var formatted = formatCustomFieldValue(fields[sourceKey]);
            if (formatted === '') continue;
            // Keep the source id; XML generation applies session maps at write time.
            attrs[sourceKey] = formatted;
        }
    }

    return attrs;
}

/**
 * Transform one CT store into an SFCC store record.
 * Address/geo enriched from linked supply/distribution channels when available.
 * @param {Object} store
 * @param {Object} channelById
 * @param {string} [storeIdOverride]
 * @param {Object.<string, string>} [attrIdMap]
 * @returns {Object|null}
 */
function transformStore(store, channelById, storeIdOverride, attrIdMap) {
    if (!store) return null;

    // Per nativeFieldMap.json: id -> ID (key kept only as a fallback if id is somehow absent)
    var sourceId = store.id || store.key || '';
    var storeId  = storeIdOverride || sanitizeStoreId(sourceId);
    if (!storeId) return null;

    var name         = getLocalized(store.name) || storeId;
    // Per nativeFieldMap.json: countries -> countryCode
    var country      = firstCountry(store);
    var channel      = fetcher.findLinkedChannel(store, channelById);
    var addr         = channel && channel.address ? channel.address : null;
    var geo          = channel ? parseGeoLocation(channel.geoLocation) : { latitude: '', longitude: '' };

    return {
        storeId:                   storeId,
        name:                      name,
        address1:                  addr ? buildAddressLine(addr) : '',
        city:                      addr ? (addr.city || '') : '',
        postalCode:                addr ? (addr.postalCode || '') : '',
        stateCode:                 addr ? stateCode(addr) : '',
        countryCode:               country,
        email:                     addr ? (addr.email || '') : '',
        phone:                     addr ? (addr.phone || addr.mobile || '') : '',
        fax:                       '',
        latitude:                  geo.latitude,
        longitude:                 geo.longitude,
        storeLocatorEnabled:       true,
        demandwarePosEnabled:      false,
        posEnabled:                false,
        customAttributes:          buildCustomAttributes(storeId, country, store, channel)
    };
}

/**
 * Build store records from CT stores.
 * @param {Array} stores
 * @param {Object} channelById
 * @param {Object.<string, string>} [attrIdMap]
 * @returns {Array}
 */
function buildStoreRecords(stores, channelById, attrIdMap) {
    var out = [];
    var map = attrIdMap || readAttrIdMap();
    var i;

    for (i = 0; i < stores.length; i++) {
        var record = transformStore(stores[i], channelById, null, map);
        if (record) out.push(record);
    }

    return out;
}

function toMigrationRef(store) {
    if (!store) return '';
    return store.key || store.id || '';
}

/**
 * Lightweight summary for the migration UI checklist.
 * @param {Object} store
 * @returns {Object}
 */
function toSummary(store) {
    var storeId = sanitizeStoreId(store.id || store.key);
    var countries = store.countries || [];
    return {
        ref:         toMigrationRef(store),
        key:         store.key || '',
        id:          store.id || '',
        name:        getLocalized(store.name) || storeId,
        countries:   countries.join(', '),
        sfccStoreId: storeId
    };
}

module.exports = {
    transformStore:         transformStore,
    buildStoreRecords:      buildStoreRecords,
    sanitizeStoreId:        sanitizeStoreId,
    toMigrationRef:         toMigrationRef,
    toSummary:              toSummary,
    readAttrIdMap:          readAttrIdMap,
    clearAttrIdMap:         clearAttrIdMap,
    saveAttrIdMapFromAttrs: saveAttrIdMapFromAttrs,
    resolveAttrId:          resolveAttrId,
    formatCustomFieldValue: formatCustomFieldValue,
    MODULE_KEY:             MODULE_KEY
};
