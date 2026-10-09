'use strict';

var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
var fetcher  = registry.getFetcher('store');

var MODULE_KEY = 'store';

var STORE_TYPES = { PHYSICAL: 'physical', ONLINE: 'online' };
var ID_SOURCES  = ['key', 'id', 'name'];
var MAX_LEN     = 256; // store.xsd simpleType.Generic.String.256

// Custom fields read as the store address when no linked channel has one: the commercetools
// Address field names plus synonyms other projects use. Lower-cased name → address field.
var ADDRESS_FIELD_NAMES = {
    streetname: 'streetName', street: 'streetName', address: 'streetName', address1: 'streetName', addressline1: 'streetName',
    streetnumber: 'streetNumber', housenumber: 'streetNumber',
    additionalstreetinfo: 'additionalStreetInfo', address2: 'additionalStreetInfo', addressline2: 'additionalStreetInfo',
    postalcode: 'postalCode', zip: 'postalCode', zipcode: 'postalCode', postcode: 'postalCode',
    city: 'city', town: 'city',
    state: 'state', statecode: 'state', province: 'state',
    country: 'country', countrycode: 'country',
    phone: 'phone', telephone: 'phone', phonenumber: 'phone',
    email: 'email',
    latitude: 'latitude', lat: 'latitude',
    longitude: 'longitude', lng: 'longitude', lon: 'longitude'
};
var HOURS_FIELD_RE  = /hour|opening|opentime|closetime/i;
var PICKUP_FIELD_RE = /pickup|pick_up|collect/i;
var DAY_NAMES       = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

/**
 * Store ID source used when the user has not picked one: the commercetools key is readable and
 * stable; the other platforms keep their location ID, as before.
 * @returns {string} key | id
 */
function defaultIdSource() {
    var platform = '';
    try { platform = registry.getPlatformId(); } catch (e) { platform = ''; }
    return platform === 'commercetools' ? 'key' : 'id';
}

/**
 * SFCC store-id from the chosen source (key, id or name), falling back to key or id.
 * @param {Object} store - source store
 * @param {string} [idSource] - key | id | name
 * @returns {string}
 */
function resolveStoreId(store, idSource) {
    if (!store) return '';
    var source = ID_SOURCES.indexOf(idSource) !== -1 ? idSource : defaultIdSource();
    var raw = '';
    if (source === 'key') raw = store.key || store.id;
    else if (source === 'name') raw = getLocalized(store.name) || store.key || store.id;
    else raw = store.id || store.key;
    return sanitizeStoreId(raw || '');
}

function hasText(val) {
    return val !== null && val !== undefined && String(val).trim() !== '';
}

/**
 * Address and coordinates kept in a store's own custom fields (commercetools has no address on
 * a Store; projects put it on a linked channel or in custom fields). Fields the user renamed in
 * Check Attributes are left to that mapping.
 * @param {Object} fields - store custom fields
 * @param {Object.<string, string>} attrIdMap - visit-scoped renames
 * @returns {{ address: Object, latitude: string, longitude: string, consumed: Object.<string, boolean> }}
 */
function addressFromCustomFields(fields, attrIdMap) {
    var out  = { address: {}, latitude: '', longitude: '', consumed: {} };
    var map  = attrIdMap || {};
    var keys = Object.keys(fields || {});
    var i;
    for (i = 0; i < keys.length; i++) {
        var name   = keys[i];
        var target = ADDRESS_FIELD_NAMES[name.toLowerCase()];
        var val    = fields[name];
        if (!target || !hasText(val) || typeof val === 'object') continue;
        if (map[name] && String(map[name]).trim() && String(map[name]).trim() !== name) continue;
        if (target === 'latitude' || target === 'longitude') {
            if (!out[target]) out[target] = String(val).trim();
        } else if (!out.address[target]) {
            out.address[target] = String(val).trim();
        }
        out.consumed[name] = true;
    }
    return out;
}

function hasAddressFields(addr) {
    return !!(addr && (hasText(addr.streetName) || hasText(addr.streetNumber) || hasText(addr.city) || hasText(addr.postalCode)));
}

/**
 * Where a store is: the linked channel's address and coordinates (the commercetools standard,
 * and what the Shopify/BigCommerce/SAP fetchers provide), else address fields in the store's
 * own custom fields.
 * @param {Object} store
 * @param {Object} channelById
 * @param {Object.<string, string>} attrIdMap
 * @returns {{ address: Object|null, latitude: string, longitude: string, source: string, consumed: Object }}
 */
function resolveLocation(store, channelById, attrIdMap) {
    var channel = fetcher.findLinkedChannel(store, channelById);
    var geo     = channel ? parseGeoLocation(channel.geoLocation) : { latitude: '', longitude: '' };
    if (!geo.latitude) {
        var refs = [].concat(store.supplyChannels || [], store.distributionChannels || []);
        var r;
        for (r = 0; r < refs.length && !geo.latitude; r++) {
            var ch = refs[r] && refs[r].id && channelById ? channelById[refs[r].id] : null;
            if (ch && ch.geoLocation) geo = parseGeoLocation(ch.geoLocation);
        }
    }

    // Address-named custom fields never become custom attributes (Check Attributes lists them as
    // read into the address); when a linked channel has an address, that one wins.
    var fromCustom    = addressFromCustomFields(store.custom && store.custom.fields, attrIdMap);
    var hasCustomAddr = hasAddressFields(fromCustom.address);
    if (channel && channel.address) {
        return { address: channel.address, latitude: geo.latitude || fromCustom.latitude,
            longitude: geo.longitude || fromCustom.longitude, source: 'channel ' + (channel.key || channel.id),
            consumed: fromCustom.consumed, ignoredCustomAddress: hasCustomAddr };
    }
    return {
        address:   hasCustomAddr || Object.keys(fromCustom.address).length ? fromCustom.address : null,
        latitude:  geo.latitude || fromCustom.latitude,
        longitude: geo.longitude || fromCustom.longitude,
        source:    hasCustomAddr ? 'custom fields' : '',
        consumed:  fromCustom.consumed,
        ignoredCustomAddress: false
    };
}

/**
 * Suggested store type, with the reasons shown to the user. Stores from Shopify, BigCommerce and
 * SAP are merchant locations and stay physical; a commercetools Store is a sales channel unless
 * it has an address, coordinates, opening hours or pick-up details.
 * @param {Object} store
 * @param {Object} channelById
 * @param {Object.<string, string>} [attrIdMap]
 * @returns {{ type: string, reasons: Array<string> }}
 */
function classifyStore(store, channelById, attrIdMap) {
    var platform = '';
    try { platform = registry.getPlatformId(); } catch (e) { platform = ''; }
    if (platform && platform !== 'commercetools') {
        return { type: STORE_TYPES.PHYSICAL, reasons: ['Store locations from this platform are physical'] };
    }

    var loc     = resolveLocation(store || {}, channelById, attrIdMap || readAttrIdMap());
    var reasons = [];
    if (loc.source) reasons.push('Address from ' + loc.source);
    if (loc.latitude && loc.longitude) reasons.push('Has coordinates');
    var fieldNames = Object.keys((store && store.custom && store.custom.fields) || {});
    var i;
    for (i = 0; i < fieldNames.length; i++) {
        if (HOURS_FIELD_RE.test(fieldNames[i])) { reasons.push('Has opening hours'); break; }
    }
    for (i = 0; i < fieldNames.length; i++) {
        if (PICKUP_FIELD_RE.test(fieldNames[i])) { reasons.push('Has pick-up details'); break; }
    }
    if (reasons.length) return { type: STORE_TYPES.PHYSICAL, reasons: reasons };
    return { type: STORE_TYPES.ONLINE, reasons: ['No address, coordinates, opening hours or pick-up details: looks like a sales channel'] };
}

/**
 * SFCC inventory list for the store's supply channel, named like the inventory migration's
 * default list ID ({base}_{channel key}). Only set when the list exists in SFCC.
 * @param {Object} store
 * @param {Object} channelById
 * @returns {{ listId: string, expectedId: string, found: boolean|null, supplyCount: number }}
 */
function resolveInventoryList(store, channelById) {
    var refs = (store && store.supplyChannels) || [];
    var out  = { listId: '', expectedId: '', found: null, supplyCount: refs.length };
    if (!refs.length || !refs[0]) return out;
    var ch   = refs[0].id && channelById ? channelById[refs[0].id] : null;
    var key  = (ch && (ch.key || ch.id)) || refs[0].key || refs[0].id || '';
    if (!key) return out;
    var base = 'inventory';
    try {
        // Loaded here so the transformer itself stays free of site configuration.
        var cfg = require('*/cartridge/scripts/migration/configAccessor');
        if (cfg.sfcc && cfg.sfcc.inventoryListId) base = cfg.sfcc.inventoryListId;
    } catch (e) {
        base = 'inventory';
    }
    out.expectedId = String(base).replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + String(key).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    try {
        var ProductInventoryMgr = require('dw/catalog/ProductInventoryMgr');
        out.found = !!ProductInventoryMgr.getInventoryList(out.expectedId);
    } catch (e) {
        out.found = null;
    }
    if (out.found) out.listId = out.expectedId;
    return out;
}

/**
 * Weekly opening hours kept in a store custom field (for example storeWeeklyHours:
 * [{ "dayOfTheWeek": 1, "openTime": "09:00:00.000+00:00", "closeTime": "18:00:00.000+00:00" }])
 * as store-hours markup, one line per day from Monday. Day 0 or 7 is Sunday; times are shown as
 * entered (HH:mm), without converting time zones. The raw field stays a custom attribute.
 * @param {Object} fields - store custom fields
 * @returns {string} '' when no field holds weekly hours
 */
function weeklyHoursFromCustomFields(fields) {
    var names = Object.keys(fields || {});
    var i;
    var d;
    for (i = 0; i < names.length; i++) {
        if (!HOURS_FIELD_RE.test(names[i])) continue;
        var days = fields[names[i]];
        try {
            if (typeof days === 'string') days = JSON.parse(days);
        } catch (e) {
            continue;
        }
        if (!Array.isArray(days)) continue;
        var lines = [];
        for (d = 0; d < days.length; d++) {
            var day   = days[d] || {};
            var num   = parseInt(day.dayOfTheWeek, 10);
            var open  = String(day.openTime || '').substring(0, 5);
            var close = String(day.closeTime || '').substring(0, 5);
            if (!(num >= 0 && num <= 7) || !/^\d\d:\d\d$/.test(open) || !/^\d\d:\d\d$/.test(close)) continue;
            lines.push({ order: (num + 6) % 7, text: '<p>' + DAY_NAMES[num % 7] + ': ' + open + ' - ' + close + '</p>' });
        }
        if (lines.length) {
            lines.sort(function (a, b) { return a.order - b.order; });
            return lines.map(function (l) { return l.text; }).join('');
        }
    }
    return '';
}

function issue(level, code, message) {
    return { level: level, code: code, message: message };
}

function buildCustomAttributes(store, consumed) {
    var attrs = {};

    // Only CT Type / source custom fields — no hardcoded migration trace attrs. Fields read into
    // the native address stay out of the custom attributes.
    if (store && store.custom && store.custom.fields) {
        var fields = store.custom.fields;
        var keys   = Object.keys(fields);
        var i;
        for (i = 0; i < keys.length; i++) {
            var sourceKey = keys[i];
            if (consumed && consumed[sourceKey]) continue;
            var formatted = formatCustomFieldValue(fields[sourceKey]);
            if (formatted === '') continue;
            // Keep the source id; XML generation applies session maps at write time.
            attrs[sourceKey] = formatted;
        }
    }

    return attrs;
}

function clip(record, field, issues) {
    if (record[field] && String(record[field]).length > MAX_LEN) {
        record[field] = String(record[field]).substring(0, MAX_LEN);
        issues.push(issue('warning', 'truncated', field + ' is longer than ' + MAX_LEN + ' characters and was shortened'));
    }
}

/**
 * Transform one source store into an SFCC store record (store.xsd), with the problems found.
 * @param {Object} store
 * @param {Object} channelById
 * @param {string} [storeIdOverride]
 * @param {Object.<string, string>} [attrIdMap]
 * @param {{ idSource?: string }} [options]
 * @returns {Object|null} record; record.issues lists warnings (record is still written)
 */
function transformStore(store, channelById, storeIdOverride, attrIdMap, options) {
    if (!store) return null;

    var opts    = options || {};
    var storeId = storeIdOverride || resolveStoreId(store, opts.idSource);
    if (!storeId) return null;

    var map    = attrIdMap || readAttrIdMap();
    var name   = getLocalized(store.name) || storeId;
    var loc    = resolveLocation(store, channelById, map);
    var addr   = loc.address;
    var issues = [];

    // Per nativeFieldMap.json: countries -> countryCode; the address country fills an empty list.
    var country = String(firstCountry(store) || (addr && addr.country) || '').trim().toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) {
        issues.push(issue('warning', 'invalid-country', 'Country "' + country + '" is not a 2-letter ISO code and was left out'));
        country = '';
    }

    var lat = loc.latitude;
    var lng = loc.longitude;
    if ((lat || lng) && !(isFinite(lat) && isFinite(lng) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && lat !== '' && lng !== '')) {
        issues.push(issue('warning', 'invalid-coordinates', 'Coordinates ' + lat + ', ' + lng + ' are not valid and were left out'));
        lat = '';
        lng = '';
    }

    var inventory = resolveInventoryList(store, channelById);
    var record = {
        storeId:              storeId,
        name:                 name,
        address1:             addr ? buildAddressLine(addr) : '',
        address2:             addr && (addr.streetName || addr.streetNumber) ? (addr.additionalStreetInfo || '') : '',
        city:                 addr ? (addr.city || '') : '',
        postalCode:           addr ? (addr.postalCode || '') : '',
        stateCode:            addr ? stateCode(addr) : '',
        countryCode:          country,
        email:                addr ? (addr.email || '') : '',
        phone:                addr ? (addr.phone || addr.mobile || '') : '',
        fax:                  '',
        latitude:             lat,
        longitude:            lng,
        inventoryListId:      inventory.listId,
        storeHours:           weeklyHoursFromCustomFields(store.custom && store.custom.fields),
        posEnabled:           false,
        customAttributes:     buildCustomAttributes(store, loc.consumed),
        issues:               issues
    };
    // A store without an address can't be shown in the store locator.
    record.storeLocatorEnabled = !!(record.address1 || record.city);

    var fields = ['name', 'address1', 'address2', 'city', 'postalCode', 'stateCode', 'email', 'phone'];
    var f;
    for (f = 0; f < fields.length; f++) clip(record, fields[f], issues);

    if (!record.storeLocatorEnabled) {
        issues.push(issue('warning', 'no-address', 'No address: exported, but hidden from the store locator'));
    }
    if (loc.ignoredCustomAddress) {
        issues.push(issue('warning', 'custom-address-ignored', 'Address in custom fields not used: the linked '
            + loc.source + ' has an address'));
    }
    if (!record.latitude || !record.longitude) {
        issues.push(issue('warning', 'no-coordinates', 'No latitude/longitude: the store locator\'s distance search won\'t find it'));
    }
    if (!record.countryCode) {
        issues.push(issue('warning', 'no-country', 'No country'));
    }
    if (inventory.expectedId && inventory.found === false) {
        issues.push(issue('warning', 'inventory-list-missing', 'Inventory list ' + inventory.expectedId
            + ' not found in SFCC: import that inventory first, then export the stores again'));
    }
    if (inventory.supplyCount > 1) {
        issues.push(issue('warning', 'several-supply-channels', 'Has ' + inventory.supplyCount
            + ' supply channels; only the first is linked as the inventory list'));
    }
    return record;
}

/**
 * Build store records from source stores.
 * @param {Array} stores
 * @param {Object} channelById
 * @param {Object.<string, string>} [attrIdMap]
 * @param {{ idSource?: string }} [options]
 * @returns {Array}
 */
function buildStoreRecords(stores, channelById, attrIdMap, options) {
    var out = [];
    var map = attrIdMap || readAttrIdMap();
    var i;

    for (i = 0; i < stores.length; i++) {
        var record = transformStore(stores[i], channelById, null, map, options);
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
 * @param {string} [idSource]
 * @returns {Object}
 */
function toSummary(store, idSource) {
    var storeId = resolveStoreId(store, idSource);
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

/**
 * Checklist rows for the store page: suggested type, SFCC store ID and the checks per store.
 * Two stores with the same SFCC store ID are both flagged.
 * @param {Array} stores
 * @param {Object} channelById
 * @param {{ idSource?: string }} [options]
 * @returns {Array<Object>}
 */
function previewStores(stores, channelById, options) {
    var opts = options || {};
    var map  = readAttrIdMap();
    var rows = [];
    var byId = {};
    var i;
    for (i = 0; i < (stores || []).length; i++) {
        var row    = toSummary(stores[i], opts.idSource);
        var kind   = classifyStore(stores[i], channelById, map);
        var record = transformStore(stores[i], channelById, null, map, opts);
        row.suggestedType = kind.type;
        row.typeReasons   = kind.reasons;
        row.issues        = record ? record.issues : [issue('error', 'no-id', 'No store ID could be built')];
        row.address       = record ? [record.address1, record.city, record.countryCode].filter(hasText).join(', ') : '';
        rows.push(row);
        if (row.sfccStoreId) (byId[row.sfccStoreId] = byId[row.sfccStoreId] || []).push(row);
    }
    var ids = Object.keys(byId);
    for (i = 0; i < ids.length; i++) {
        if (byId[ids[i]].length < 2) continue;
        var d;
        for (d = 0; d < byId[ids[i]].length; d++) {
            byId[ids[i]][d].issues.unshift(issue('error', 'duplicate-id', 'Store ID ' + ids[i]
                + ' is used by ' + byId[ids[i]].length + ' stores; only the first is exported'));
        }
    }
    return rows;
}

module.exports = {
    transformStore:         transformStore,
    buildStoreRecords:      buildStoreRecords,
    classifyStore:          classifyStore,
    previewStores:          previewStores,
    resolveStoreId:         resolveStoreId,
    defaultIdSource:        defaultIdSource,
    sanitizeStoreId:        sanitizeStoreId,
    toMigrationRef:         toMigrationRef,
    toSummary:              toSummary,
    readAttrIdMap:          readAttrIdMap,
    clearAttrIdMap:         clearAttrIdMap,
    saveAttrIdMapFromAttrs: saveAttrIdMapFromAttrs,
    resolveAttrId:          resolveAttrId,
    formatCustomFieldValue: formatCustomFieldValue,
    STORE_TYPES:            STORE_TYPES,
    ID_SOURCES:             ID_SOURCES,
    MODULE_KEY:             MODULE_KEY
};
