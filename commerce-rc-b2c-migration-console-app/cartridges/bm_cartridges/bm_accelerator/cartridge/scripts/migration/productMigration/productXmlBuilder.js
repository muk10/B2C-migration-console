'use strict';

var ctpTransformer   = require('*/cartridge/scripts/migration/productMigration/productTransformer');
var nativeMap        = require('*/cartridge/scripts/migration/config/nativeFieldMap');
var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');

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
 * Canonical string for one CT collection item.
 * Enum/reference values use their stable keys/IDs. Nested values are retained
 * as JSON instead of degrading to "[object Object]".
 *
 * @param {*} item CT collection item
 * @returns {string}
 */
function collectionItemValue(item) {
    if (item === null || item === undefined) return '';
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        return String(item);
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        if (item.key != null) return String(item.key);
        if (item.id != null) return String(item.id);
    }
    try {
        return JSON.stringify(item);
    } catch (e) {
        return '';
    }
}

/**
 * SFCC catalog.xsd represents multi-value custom attributes with repeated
 * <value> children inside one custom-attribute element.
 *
 * @param {string} indent indentation
 * @param {string} attrId SFCC attribute ID
 * @param {Array} values CT collection
 * @returns {string} custom-attribute XML
 */
function collectionCustomAttributeXml(indent, attrId, values) {
    var inner = '';
    var i;
    for (i = 0; i < (values || []).length; i++) {
        var value = collectionItemValue(values[i]);
        if (!value) continue;
        inner += indent + '    <value>' + xmlEsc(value) + '</value>\n';
    }
    if (!inner) return '';
    return indent + '<custom-attribute attribute-id="' + xmlEsc(attrId) + '">\n'
        + inner + indent + '</custom-attribute>\n';
}

/**
 * Resolve SFCC product attribute ID, applying visit-scoped renames.
 * @param {string} canonicalSfccId
 * @returns {string}
 */
function resolveProductAttrId(canonicalSfccId) {
    return attrIdMapSession.resolve(canonicalSfccId, attrIdMapSession.read('product'));
}

/**
 * True when a resolved attribute id is an SFCC Product system field
 * (must not be emitted as <custom-attribute>).
 * @param {string} attrId
 * @returns {boolean}
 */
function isProductSystemAttr(attrId) {
    if (!attrId) return false;
    return !!nativeMap.resolveSystemId('Product', attrId);
}

/**
 * Build CT custom-attribute XML for attrs owned by one product node.
 * Uses selectedVarAttrs allow-list; preserves source attr names (incl. hyphens).
 * @param {Array} attributes - CT variant/product attribute array
 * @param {Array|null} selectedVarAttrs
 * @param {Object} productAttrMap - session attr id map
 * @param {string} indent
 * @param {Array<string>} [variationAttributeNames] genuine CT variation axes
 * @returns {string} inner custom-attribute elements (no wrapper)
 */
function buildCtpCustomAttrInner(attributes, selectedVarAttrs, productAttrMap, indent, variationAttributeNames) {
    var hasVarSelection = selectedVarAttrs && selectedVarAttrs.length;
    var inner = '';
    var list = attributes || [];
    var ai;
    for (ai = 0; ai < list.length; ai++) {
        var a = list[ai];
        var val = a && a.value;
        if (val === null || val === undefined) continue;
        if (!hasVarSelection || selectedVarAttrs.indexOf(a.name) === -1) continue;
        var rule = nativeMap.getRule('commercetools', 'Product', a.name);
        if (rule && nativeMap.isMapAction(rule.action)) continue;
        var aId = (rule && rule.action === 'custom_attr') ? rule.sfccField
            : String(a.name || '');
        if (isProductSystemAttr(attrIdMapSession.resolve(a.name, productAttrMap))) continue;
        aId = resolveProductAttrId(aId);
        if (isProductSystemAttr(aId)) continue;
        inner += customAttributeXml(indent, aId, val, {
            forceVariationKey: variationAttributeNames
                && variationAttributeNames.indexOf(a.name) !== -1
        });
    }
    return inner;
}

var UUID_RE_XML = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-build options: localizableAttrIds (id → true/false/null from live BM Product defs),
 * categoryIdToSfcc. Missing/unknown: locale maps keep xml:lang; non-localizable keys omit it.
 */
var _xmlOpts = {};

function sfccCustomAttrExists(attrId) {
    var map = _xmlOpts && _xmlOpts.localizableAttrIds;
    if (map == null || attrId == null) return false;
    if (typeof map.containsKey === 'function') return map.containsKey(attrId);
    return Object.prototype.hasOwnProperty.call(map, attrId);
}

/**
 * CT product-level fields (Product.key, the product type key) are not Product Type attributes.
 * Write one as custom attr when the user created/mapped it in Check Attributes; never when the
 * session target is an SFCC system field.
 */
function ctpProductLevelCustomXml(sourceId, value, productAttrMap, selectedVarAttrs, indent) {
    if (!value) return '';
    var mapped = attrIdMapSession.resolve(sourceId, productAttrMap);
    var target = mapped || sourceId;
    if (isProductSystemAttr(target)) return '';
    var selected = selectedVarAttrs && selectedVarAttrs.indexOf(sourceId) !== -1;
    if (!sfccCustomAttrExists(target) && !selected) return '';
    return customAttributeXml(indent, target, value);
}

function ctpProductKeyCustomXml(t, productAttrMap, selectedVarAttrs, indent) {
    return t ? ctpProductLevelCustomXml('key', t.ctpKey, productAttrMap, selectedVarAttrs, indent) : '';
}

function mapGet(map, key) {
    if (!map || key == null) return '';
    if (typeof map.get === 'function') {
        var hv = map.get(key);
        return (hv == null) ? '' : String(hv);
    }
    return map[key] ? String(map[key]) : '';
}

function resolveCategorySfccId(ctRef) {
    if (!ctRef) return '';
    var s = String(ctRef);
    var mapped = mapGet(_xmlOpts && _xmlOpts.categoryIdToSfcc, s);
    return mapped || s;
}

/**
 * Convert a CT member product UUID to its SFCC product ID.
 * Prefers the batch lookup map, then the same id→ID schema map as the product itself.
 * Never emits the legacy CT+nodash id when the member is a UUID (id → ID catalogs).
 */
var _uuidToSfccId = {};

/**
 * CT product ID -> { sku: SFCC variant product ID } for the products of the current batch
 * and any bundle members the runner fetched (xmlOpts.bundleMemberProducts).
 * At most ~50 + members per batch, well under api.jsObjectSize.
 */
var _memberVariantIds = {};

/**
 * @param {Object} t - transformed product (ctpId, variants[{productId, sku}])
 */
function registerMemberVariants(t) {
    // Only variation masters export variant products; a bundle or set member keeps its own ID.
    if (!t || !t.ctpId || t.productKind !== 'base' || !t.hasVariants || !t.variants || !t.variants.length) return;
    var bySku = {};
    for (var i = 0; i < t.variants.length; i++) {
        var v = t.variants[i];
        var vSku = v && v.sku ? String(v.sku).trim() : '';
        if (vSku && v.productId && !bySku[vSku]) bySku[vSku] = v.productId;
    }
    _memberVariantIds[t.ctpId] = bySku;
}

/**
 * SFCC product ID for a bundle member: the exact variant its SKU names when that variant
 * is known, otherwise the member's master (SFCC allows base products in bundles).
 * @param {Object} member - { productId: CT id, sku? }
 * @returns {string}
 */
function bundleMemberSfccId(member) {
    var bySku = member && member.sku ? _memberVariantIds[member.productId] : null;
    if (bySku && bySku[member.sku]) return bySku[member.sku];
    return ctpMemberIdToSfcc(member.productId);
}
function ctpMemberIdToSfcc(ctpId) {
    if (!ctpId) return '';
    var s = String(ctpId);
    var fromBatch = mapGet(_uuidToSfccId, s);
    if (fromBatch) return fromBatch;
    if (!UUID_RE_XML.test(s)) return s;
    var mapped = ctpTransformer.resolveMasterProductId
        ? ctpTransformer.resolveMasterProductId({ id: s })
        : s;
    if (mapped && /^CT[0-9a-f]{32}$/i.test(mapped)) return s;
    return mapped || s;
}

/** Self-closing tag when value is empty, otherwise wraps value. */
function optTag(tag, val) {
    var v = val ? String(val).trim() : '';
    return v ? '        <' + tag + '>' + xmlEsc(v) + '</' + tag + '>\n'
             : '        <' + tag + '/>\n';
}

/**
 * Normalize string or locale map to { locale: text }.
 * Also accepts CT lenum `{ key, label: { locale: text } }`.
 * @param {string|Object} val
 * @returns {Object.<string, string>}
 */
function normalizeLocaleMap(val) {
    if (val == null || val === '') return {};
    if (typeof val === 'string' || typeof val === 'number') {
        return { 'x-default': String(val) };
    }
    if (typeof val !== 'object' || Array.isArray(val)) return {};
    if (val.typeId !== undefined) return {};
    if (val.label && typeof val.label === 'object' && !Array.isArray(val.label)) {
        return normalizeLocaleMap(val.label);
    }
    if (val.key !== undefined) return {};
    var out = {};
    var keys = Object.keys(val);
    var i;
    for (i = 0; i < keys.length; i++) {
        if (val[keys[i]] == null || val[keys[i]] === '') continue;
        if (typeof val[keys[i]] === 'object') continue;
        out[keys[i]] = String(val[keys[i]]);
    }
    return out;
}

function defaultLocaleText(map) {
    if (!map) return '';
    return map['x-default'] || map.en || map['en-US'] || map['en-GB'] || map['en-AU']
        || (Object.keys(map).length ? map[Object.keys(map)[0]] : '');
}

function isHexColor(s) {
    return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(String(s || ''));
}

function titleCaseWord(s) {
    if (!s || !/^[a-z]+$/.test(s)) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function localeMapHasLangs(map) {
    var keys = Object.keys(map || {});
    if (keys.length > 1) return true;
    if (keys.length === 1 && keys[0] !== 'x-default') return true;
    return false;
}

function localeOrString(locales, fallback) {
    if (locales && typeof locales === 'object' && !Array.isArray(locales) && Object.keys(locales).length) {
        return locales;
    }
    return fallback;
}

function copyLocaleMap(map) {
    var out = {};
    var keys = Object.keys(map || {});
    var i;
    for (i = 0; i < keys.length; i++) out[keys[i]] = map[keys[i]];
    return out;
}

/**
 * Parse a CT attr value into an SFCC variation axis: non-localized key + display-value locales.
 * Long text / newlines are not variation values (they stay as custom attributes).
 * @returns {{ key: string, displayMap: Object, localizable: boolean }|null}
 */
function parseVariationValue(val) {
    if (val == null || val === '' || Array.isArray(val)) return null;
    var key = '';
    var displayMap = {};
    var localizable = false;

    if (typeof val === 'object' && !Array.isArray(val)) {
        if (val.typeId !== undefined) return null;
        if (val.key) {
            key = String(val.key).trim();
            displayMap = copyLocaleMap(normalizeLocaleMap(val.label));
            localizable = Object.keys(displayMap).length > 0;
            if (!Object.keys(displayMap).length) displayMap['x-default'] = key;
        } else {
            displayMap = copyLocaleMap(normalizeLocaleMap(val));
            key = defaultLocaleText(displayMap);
            localizable = Object.keys(displayMap).length > 0;
        }
    } else {
        key = String(val).trim();
        displayMap['x-default'] = key;
        localizable = /[a-zA-Z]/.test(key) && !isHexColor(key);
    }

    if (!key || key.length > 80 || key.indexOf('\n') !== -1) return null;

    if (displayMap['x-default'] == null) {
        displayMap['x-default'] = titleCaseWord(key) || key;
    } else if (displayMap['x-default'] === key) {
        displayMap['x-default'] = titleCaseWord(key) || key;
    }
    if (isHexColor(key)) localizable = false;
    return { key: key, displayMap: displayMap, localizable: localizable };
}

function emitLocalizedCustomAttribute(indent, attrId, map) {
    var keys = Object.keys(map);
    if (!keys.length) return '';
    var def = defaultLocaleText(map);
    if (!def) return '';
    var xml = indent + '<custom-attribute attribute-id="' + xmlEsc(attrId)
        + '" xml:lang="x-default">' + xmlEsc(def) + '</custom-attribute>\n';
    var i;
    for (i = 0; i < keys.length; i++) {
        if (keys[i] === 'x-default') continue;
        xml += indent + '<custom-attribute attribute-id="' + xmlEsc(attrId)
            + '" xml:lang="' + xmlEsc(keys[i]) + '">'
            + xmlEsc(map[keys[i]]) + '</custom-attribute>\n';
    }
    return xml;
}

/**
 * Live SFCC Product definition: true / false / null (unknown — not in BM dump).
 * @param {string} attrId
 * @returns {boolean|null}
 */
function sfccAttrLocalizable(attrId) {
    var map = _xmlOpts && _xmlOpts.localizableAttrIds;
    if (map == null || attrId == null) return null;
    if (typeof map.get === 'function') {
        var hv;
        if (typeof map.containsKey === 'function') {
            if (map.containsKey(attrId)) {
                hv = map.get(attrId);
            } else {
                return null;
            }
        } else {
            hv = map.get(attrId);
        }
        if (hv == null || hv === 'x') return null;
        return hv === true || hv === 1 || hv === '1' || hv === 'true' || String(hv) === 'true';
    }
    if (!Object.prototype.hasOwnProperty.call(map, attrId)) return null;
    var pv = map[attrId];
    if (pv == null || pv === 'x') return null;
    return pv === true || pv === 1 || pv === '1' || pv === 'true';
}

function unlocalizedCustomAttribute(indent, attrId, scalar) {
    if (!scalar) return '';
    return indent + '<custom-attribute attribute-id="' + xmlEsc(attrId) + '">'
        + xmlEsc(scalar) + '</custom-attribute>\n';
}

/**
 * Custom attribute XML.
 * Live BM localizable flag is the source of truth: xml:lang on every entry when
 * the SFCC attribute is localizable. Non-localizable defs omit xml:lang.
 * Unknown defs: locale maps (ltext) keep xml:lang; variation keys do not.
 */
function customAttributeXml(indent, attrId, val, opts) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) return collectionCustomAttributeXml(indent, attrId, val);
    opts = opts || {};
    var axis = parseVariationValue(val);
    var sourceMap = normalizeLocaleMap(val);
    var map = Object.keys(sourceMap).length ? copyLocaleMap(sourceMap) : {};
    var scalar = axis ? axis.key : defaultLocaleText(map);
    if (!scalar && (typeof val === 'string' || typeof val === 'number')) {
        scalar = String(val);
    }
    if (!scalar && typeof val === 'object' && !Array.isArray(val) && val.key != null) {
        scalar = String(val.key);
    }
    if (!scalar) return '';

    var loc = sfccAttrLocalizable(attrId);
    if (opts.forceVariationKey && axis) {
        return indent + '<custom-attribute attribute-id="' + xmlEsc(attrId) + '"'
            + (loc === true ? ' xml:lang="x-default"' : '') + '>'
            + xmlEsc(axis.key) + '</custom-attribute>\n';
    }
    var hasLangs = localeMapHasLangs(sourceMap);
    if (loc === true || (loc == null && hasLangs)) {
        if (!Object.keys(map).length) {
            map['x-default'] = scalar;
        } else if (!map['x-default']) {
            map['x-default'] = defaultLocaleText(map) || scalar;
        }
        return emitLocalizedCustomAttribute(indent, attrId, map);
    }
    if (loc === false) {
        return unlocalizedCustomAttribute(indent, attrId, scalar);
    }
    if (axis) {
        return unlocalizedCustomAttribute(indent, attrId, axis.key);
    }
    if (Object.keys(map).length) {
        return emitLocalizedCustomAttribute(indent, attrId, map);
    }
    return unlocalizedCustomAttribute(indent, attrId, scalar);
}

/**
 * Emit one XML element per locale. Always includes x-default (from en* or first).
 * @param {string} indent
 * @param {string} tag
 * @param {string|Object} localeMapOrString
 * @returns {string}
 */
function localizedElementsXml(indent, tag, localeMapOrString) {
    var map = normalizeLocaleMap(localeMapOrString);
    var keys = Object.keys(map);
    if (!keys.length) return '';
    var def = defaultLocaleText(map);
    var xml = indent + '<' + tag + ' xml:lang="x-default">' + xmlEsc(def) + '</' + tag + '>\n';
    var i;
    for (i = 0; i < keys.length; i++) {
        if (keys[i] === 'x-default') continue;
        xml += indent + '<' + tag + ' xml:lang="' + xmlEsc(keys[i]) + '">'
            + xmlEsc(map[keys[i]]) + '</' + tag + '>\n';
    }
    return xml;
}

function variationAxisDisplayName(attrId) {
    var parts = String(attrId || '').split(/[-_]/);
    var i;
    var w;
    var out = [];
    for (i = 0; i < parts.length; i++) {
        w = parts[i];
        if (!w) continue;
        out.push(w.charAt(0).toUpperCase() + w.slice(1));
    }
    return out.join(' ') || attrId;
}

/**
 * Build <page-attributes> block.
 * catalog.xsd: page-title → page-description → page-keywords → page-url
 */
function buildPageAttributes(t) {
    var indent = '            ';
    var inner = '';
    inner += localizedElementsXml(indent, 'page-title', localeOrString(t.metaTitleLocales, t.metaTitle));
    inner += localizedElementsXml(indent, 'page-description', localeOrString(t.metaDescriptionLocales, t.metaDescription));
    if (t.metaKeywordsLocales || t.metaKeywords) {
        inner += localizedElementsXml(indent, 'page-keywords', localeOrString(t.metaKeywordsLocales, t.metaKeywords));
    }
    inner += localizedElementsXml(indent, 'page-url', localeOrString(t.slugLocales, t.slug));
    if (!inner) return '        <page-attributes/>\n';
    return '        <page-attributes>\n' + inner + '        </page-attributes>\n';
}

var IMAGE_VIEW_TYPES = ['large', 'medium', 'small'];

function externalUrlParts(value) {
    var match = /^(https?):\/\/([^/?#]+)(\/[^#]*)?$/i.exec(String(value || '').trim());
    if (!match) return null;
    return {
        protocol: match[1].toLowerCase(),
        authority: match[2].toLowerCase(),
        path: String(match[3] || '').replace(/^\/+/, '')
    };
}

function normalizeExternalImageBaseUrl(value) {
    var parts = externalUrlParts(value);
    return parts ? parts.protocol + '://' + parts.authority : '';
}

function imagePathForBase(value, baseUrl) {
    var image = externalUrlParts(value);
    var base = externalUrlParts(baseUrl);
    if (!image || !base || image.authority !== base.authority || !image.path) return '';
    return image.path;
}

function imageAltXml(image, indent) {
    var locales = image && image.altLocales;
    if (locales && Object.keys(locales).length) {
        return localizedElementsXml(indent, 'alt', locales);
    }
    return image && image.alt ? localizedElementsXml(indent, 'alt', image.alt) : '';
}

/**
 * Normalize an image list into unique { path, image } entries relative to the
 * catalog's single external image location. The catalog header owns the
 * external origin; URLs from a different origin are intentionally skipped
 * because a catalog supports only one external image location.
 * @param {Array} images
 * @returns {Array<{path: string, image: Object}>}
 */
function normalizeImagePaths(images) {
    var out = [];
    var baseUrl = _xmlOpts && _xmlOpts.externalImageBaseUrl;
    if (!images || !images.length || !baseUrl) return out;
    var seen = {};
    var i;
    for (i = 0; i < images.length; i++) {
        var image = images[i] || {};
        var path = imagePathForBase(image.url || image.path, baseUrl);
        if (!path || seen[path]) continue;
        seen[path] = true;
        out.push({ path: path, image: image });
    }
    return out;
}

/** Order-sensitive identity of an image list (paths only). */
function imageListSignature(normalized) {
    var parts = [];
    var i;
    for (i = 0; i < normalized.length; i++) parts.push(normalized[i].path);
    return parts.join('\n');
}

/**
 * One <image-group>. variationPairs (catalog.xsd complexType.Product.ImageGroup
 * <variation attribute-id value/>) come first and restrict the group to the
 * variants carrying those values; no pairs = fallback group.
 * @param {string} viewType
 * @param {Array<{attributeId: string, value: string}>|null} variationPairs
 * @param {Array<{path: string, image: Object}>} normalized
 * @returns {string}
 */
function imageGroupXml(viewType, variationPairs, normalized) {
    var xml = '            <image-group view-type="' + xmlEsc(viewType) + '">\n';
    var i;
    for (i = 0; i < (variationPairs || []).length; i++) {
        xml += '                <variation attribute-id="' + xmlEsc(variationPairs[i].attributeId)
            + '" value="' + xmlEsc(variationPairs[i].value) + '"/>\n';
    }
    for (i = 0; i < normalized.length; i++) {
        var altXml = imageAltXml(normalized[i].image, '                    ');
        if (altXml) {
            xml += '                <image path="' + xmlEsc(normalized[i].path) + '">\n'
                + altXml
                + '                </image>\n';
        } else {
            xml += '                <image path="' + xmlEsc(normalized[i].path) + '"/>\n';
        }
    }
    xml += '            </image-group>\n';
    return xml;
}

/**
 * <images> for simple products, sets and bundles: one fallback group per view type.
 * @param {Array} images
 * @returns {string}
 */
function buildImagesXml(images) {
    var normalized = normalizeImagePaths(images);
    if (!normalized.length) return '';
    var xml = '        <images>\n';
    var vi;
    for (vi = 0; vi < IMAGE_VIEW_TYPES.length; vi++) {
        xml += imageGroupXml(IMAGE_VIEW_TYPES[vi], null, normalized);
    }
    xml += '        </images>\n';
    return xml;
}

/**
 * First `len` axis values of one variant as <variation> pairs, or null when the
 * variant has no value for one of them (it then simply uses the fallback images).
 */
function variationPrefixPairs(values, axisIds, len) {
    var pairs = [];
    var i;
    for (i = 0; i < len; i++) {
        var v = values ? values[axisIds[i]] : null;
        if (v == null || v === '') return null;
        pairs.push({ attributeId: axisIds[i], value: v });
    }
    return pairs;
}

function variationPairsKey(pairs) {
    var parts = [];
    var i;
    for (i = 0; i < pairs.length; i++) parts.push(pairs[i].attributeId + '=' + pairs[i].value);
    return parts.join('|');
}

/**
 * Shortest axis prefix that still determines the image set, so images that only
 * vary by the first axis (e.g. color on a color+size product) produce one group
 * per color instead of one per variant. Falls back to the full combination.
 * @param {Array<{sig: string, values: Object}>} entries
 * @param {Array<string>} axisIds
 * @returns {number}
 */
function variationImagePrefixLength(entries, axisIds) {
    var len;
    for (len = 1; len < axisIds.length; len++) {
        var sigByKey = {};
        var consistent = true;
        var i;
        for (i = 0; i < entries.length; i++) {
            var pairs = variationPrefixPairs(entries[i].values, axisIds, len);
            if (!pairs) continue;
            var key = variationPairsKey(pairs);
            if (!Object.prototype.hasOwnProperty.call(sigByKey, key)) {
                sigByKey[key] = entries[i].sig;
            } else if (sigByKey[key] !== entries[i].sig) {
                consistent = false;
                break;
            }
        }
        if (consistent) return len;
    }
    return axisIds.length;
}

/**
 * <images> for a variation master. SFCC catalog import rejects <images> on
 * variation products ("Cannot add images to a variation product. Images can be
 * added to master product only."), so every variant's images are written on the
 * master inside image groups qualified by <variation attribute-id value/>
 * elements; groups without <variation> are the master's fallback images.
 * Within one master the same axis always sits at the same index, as the XSD
 * requires. Groups identical to the fallback set are omitted (the fallback
 * already applies). Without any variation axis nothing can qualify a group, so
 * variant-only images are merged into the fallback set instead of being lost.
 *
 * @param {Object} t transformed product
 * @param {{ axisIds: Array<string>, variantValues: Array<Object> }} model
 * @returns {string}
 */
function buildMasterImagesXml(t, model) {
    var fallback = normalizeImagePaths(t.masterImages);
    var variants = t.variants || [];
    var axisIds = (model && model.axisIds) || [];
    var variantValues = (model && model.variantValues) || [];
    var entries = [];
    var i;
    var j;
    for (i = 0; i < variants.length; i++) {
        var normalized = normalizeImagePaths(variants[i] && variants[i].images);
        if (!normalized.length) continue;
        entries.push({
            normalized: normalized,
            sig:        imageListSignature(normalized),
            values:     variantValues[i] || {},
            isDefault:  !!(variants[i] && variants[i].isDefault)
        });
    }

    // No master-level images: the default variant's images become the fallback.
    if (!fallback.length && entries.length) {
        var def = null;
        for (i = 0; i < entries.length; i++) {
            if (entries[i].isDefault) { def = entries[i]; break; }
        }
        fallback = (def || entries[0]).normalized;
    }

    var groups = [];
    if (axisIds.length) {
        var prefixLen = variationImagePrefixLength(entries, axisIds);
        var fallbackSig = imageListSignature(fallback);
        var seenKey = {};
        for (i = 0; i < entries.length; i++) {
            var pairs = variationPrefixPairs(entries[i].values, axisIds, prefixLen);
            if (!pairs) continue;
            var key = variationPairsKey(pairs);
            if (seenKey[key]) continue;
            seenKey[key] = true;
            if (entries[i].sig === fallbackSig) continue;
            groups.push({ pairs: pairs, normalized: entries[i].normalized });
        }
    } else if (entries.length) {
        var have = {};
        var merged = [];
        for (i = 0; i < fallback.length; i++) {
            have[fallback[i].path] = true;
            merged.push(fallback[i]);
        }
        for (i = 0; i < entries.length; i++) {
            for (j = 0; j < entries[i].normalized.length; j++) {
                var entry = entries[i].normalized[j];
                if (have[entry.path]) continue;
                have[entry.path] = true;
                merged.push(entry);
            }
        }
        fallback = merged;
    }

    if (!fallback.length && !groups.length) return '';
    var xml = '        <images>\n';
    var vi;
    for (vi = 0; vi < IMAGE_VIEW_TYPES.length; vi++) {
        if (fallback.length) xml += imageGroupXml(IMAGE_VIEW_TYPES[vi], null, fallback);
        for (i = 0; i < groups.length; i++) {
            xml += imageGroupXml(IMAGE_VIEW_TYPES[vi], groups[i].pairs, groups[i].normalized);
        }
    }
    xml += '        </images>\n';
    return xml;
}

function firstCtpImageBaseUrl(transformedProducts, configuredBaseUrl) {
    var configured = normalizeExternalImageBaseUrl(configuredBaseUrl);
    if (configured) return configured;
    var products = transformedProducts || [];
    var pi;
    for (pi = 0; pi < products.length; pi++) {
        var product = products[pi];
        if (!product || !product.ctpId) continue;
        var imageSets = [product.masterImages || []];
        var variants = product.variants || [];
        var vi;
        for (vi = 0; vi < variants.length; vi++) imageSets.push(variants[vi].images || []);
        var si;
        for (si = 0; si < imageSets.length; si++) {
            var ii;
            for (ii = 0; ii < imageSets[si].length; ii++) {
                var image = imageSets[si][ii] || {};
                var origin = normalizeExternalImageBaseUrl(image.url || image.path);
                if (origin) return origin;
            }
        }
    }
    return '';
}

function imageSettingsHeaderXml(externalImageBaseUrl) {
    var base = externalUrlParts(externalImageBaseUrl);
    if (!base) return '';
    var xml = '    <header>\n'
        + '        <image-settings>\n'
        + '            <external-location>\n'
        + '                <http-url>http://' + xmlEsc(base.authority) + '/</http-url>\n'
        + '                <https-url>https://' + xmlEsc(base.authority) + '/</https-url>\n'
        + '            </external-location>\n'
        + '            <view-types>\n';
    var i;
    for (i = 0; i < IMAGE_VIEW_TYPES.length; i++) {
        xml += '                <view-type>' + IMAGE_VIEW_TYPES[i] + '</view-type>\n';
    }
    return xml + '            </view-types>\n'
        + '        </image-settings>\n'
        + '    </header>\n\n';
}

/**
 * Variation axes and per-variant axis values, shared by <variations> and the
 * master <images> block.
 * platform: 'shopify' | 'sap' | 'bigcommerce' | 'ctp' (default) — which transformer produced t.
 * @returns {{ axisIds: Array<string>, attrMap: Object, variantValues: Array<Object> }}
 */
function collectVariationModel(t, selectedVarAttrs, platform) {
    var isShopify = platform === 'shopify';
    var isBc      = platform === 'bigcommerce';
    var hasVarSelection = selectedVarAttrs && selectedVarAttrs.length;
    var ctpVariationNames = Array.isArray(t.variationAttributeNames)
        ? t.variationAttributeNames : null;
    var attrPrefix = platform === 'shopify' ? 'shopify_'
        : (platform === 'sap' ? 'sap_'
            : (platform === 'bigcommerce' ? 'bc_' : ''));
    var ruleSource = platform === 'shopify' ? 'shopify'
        : (platform === 'sap' ? 'sap'
            : (platform === 'bigcommerce' ? 'bigcommerce' : 'commercetools'));

    // Collect unique variation attribute names + values across all variants.
    // CT: value can be string, number, or { key, label } enum.
    // Shopify/BC: value is always a string (selectedOptions / option_values).
    // attrMap key = SFCC attr ID — must match both axis ID and variant custom attr ID.
    var attrMap = {};       // { sfccAttrId: { key: displayMap } }
    var variantValues = []; // per variant index: { sfccAttrId: key }
    var variants = t.variants || [];
    for (var vi = 0; vi < variants.length; vi++) {
        var values = {};
        variantValues.push(values);
        var attrs = variants[vi].attributes || [];
        for (var ai = 0; ai < attrs.length; ai++) {
            var a   = attrs[ai];
            var val = a.value;
            if (val === null || val === undefined) continue;
            // CT: only include axes that are in the selected variant attrs list (or none if unset).
            // Shopify/BC: include all when unset; when set, include selected options (+ price extras).
            if (isShopify || isBc) {
                if (hasVarSelection
                    && selectedVarAttrs.indexOf(a.name) === -1
                    && a.name !== 'price' && a.name !== 'compareAtPrice' && a.name !== 'barcode'
                    && a.name !== 'sale_price' && a.name !== 'upc') {
                    continue;
                }
            } else {
                if (hasVarSelection && selectedVarAttrs.indexOf(a.name) === -1) continue;
                if (!hasVarSelection) continue;
                if (ctpVariationNames && ctpVariationNames.indexOf(a.name) === -1) continue;
            }

            var axisRule = nativeMap.getRule(ruleSource, 'Product', a.name);
            if (axisRule && nativeMap.isMapAction(axisRule.action)) continue;
            // Use same SFCC ID as variant custom attr so axis ID and value ID match.
            // custom_attr rules map to a native SFCC field (e.g. Shopify "Color" -> "color")
            // instead of the platform-prefixed custom attribute ID.
            // CT: preserve source name (hyphens); other platforms keep safe sanitized ids.
            var sfccAxisId;
            if (axisRule && axisRule.action === 'custom_attr') {
                sfccAxisId = axisRule.sfccField;
            } else if (platform === 'ctp' || !attrPrefix) {
                sfccAxisId = String(a.name || '');
            } else {
                sfccAxisId = attrPrefix + String(a.name || '').replace(/[^a-zA-Z0-9_]/g, '_');
            }
            sfccAxisId = resolveProductAttrId(sfccAxisId);

            var parsed = parseVariationValue(val);
            if (!parsed) continue;
            var key = parsed.key;
            if (!attrMap[sfccAxisId]) attrMap[sfccAxisId] = {};
            if (!attrMap[sfccAxisId][key]) attrMap[sfccAxisId][key] = parsed.displayMap;
            if (values[sfccAxisId] == null) values[sfccAxisId] = key;
        }
    }
    return { axisIds: Object.keys(attrMap), attrMap: attrMap, variantValues: variantValues };
}

/**
 * Build <variations> block with <attributes> (variation axes from variant attrs)
 * and <variants> list.
 * Reference: <attributes> first, then <variants>.
 * @param {Object} t
 * @param {Array} selectedVarAttrs
 * @param {string} platform
 * @param {Object} [model] - result of collectVariationModel (computed when omitted)
 */
function buildVariationsXml(t, selectedVarAttrs, platform, model) {
    var m = model || collectVariationModel(t, selectedVarAttrs, platform);
    var attrMap = m.attrMap;
    var attrNames = m.axisIds;
    var xml = '        <variations>\n';

    if (attrNames.length) {
        xml += '            <attributes>\n';
        for (var ni = 0; ni < attrNames.length; ni++) {
            var attrName = attrNames[ni]; // SFCC attr ID
            if (sfccAttrLocalizable(attrName) === true) {
                throw new Error('SFCC variation attribute "' + attrName
                    + '" is localizable. Change it to a non-localizable String or Integer before migration.');
            }
            xml += '                <variation-attribute attribute-id="' + xmlEsc(attrName)
                + '" variation-attribute-id="' + xmlEsc(attrName) + '">\n';
            xml += '                    <display-name xml:lang="x-default">'
                + xmlEsc(variationAxisDisplayName(attrName))
                + '</display-name>\n';
            xml += '                    <variation-attribute-values>\n';
            var valueKeys = Object.keys(attrMap[attrName]);
            for (var vki = 0; vki < valueKeys.length; vki++) {
                var vKey = valueKeys[vki];
                xml += '                        <variation-attribute-value value="' + xmlEsc(vKey) + '">\n';
                xml += localizedElementsXml('                            ', 'display-value', attrMap[attrName][vKey]);
                xml += '                        </variation-attribute-value>\n';
            }
            xml += '                    </variation-attribute-values>\n';
            xml += '                </variation-attribute>\n';
        }
        xml += '            </attributes>\n';
    }

    xml += '            <variants>\n';
    for (var vi2 = 0; vi2 < t.variants.length; vi2++) {
        var isDefault = t.variants[vi2].isDefault ? ' default="true"' : '';
        xml += '                <variant product-id="' + xmlEsc(t.variants[vi2].productId) + '"' + isDefault + '/>\n';
    }
    xml += '            </variants>\n';
    xml += '        </variations>\n';
    return xml;
}

/**
 * Build <product-set-products> block per SFCC catalog XSD.
 * XSD: complexType.Product.ProductSetProducts → unbounded <product-set-product product-id="..."/>
 */
function buildProductSetProductsXml(setProducts) {
    if (!setProducts || !setProducts.length) return '';
    var xml = '        <product-set-products>\n';
    for (var i = 0; i < setProducts.length; i++) {
        xml += '            <product-set-product product-id="' + xmlEsc(ctpMemberIdToSfcc(setProducts[i].productId)) + '"/>\n';
    }
    xml += '        </product-set-products>\n';
    return xml;
}

/**
 * Build <bundled-products> block per SFCC catalog XSD.
 * XSD: complexType.Product.BundledProduct → attribute product-id + required child <quantity>
 */
function buildBundledProductsXml(bundleProducts) {
    if (!bundleProducts || !bundleProducts.length) {
        return '';
    }
    var xml = '        <bundled-products>\n';
    for (var i = 0; i < bundleProducts.length; i++) {
        var qty = bundleProducts[i].quantity || 1;
        xml += '            <bundled-product product-id="' + xmlEsc(bundleMemberSfccId(bundleProducts[i])) + '">\n';
        xml += '                <quantity>' + qty + '</quantity>\n';
        xml += '            </bundled-product>\n';
    }
    xml += '        </bundled-products>\n';
    return xml;
}

/** Shared store-attributes block at end of every product. */
var STORE_ATTRS = '        <store-attributes>\n'
    + '            <force-price-flag>false</force-price-flag>\n'
    + '            <non-inventory-flag>false</non-inventory-flag>\n'
    + '            <non-revenue-flag>false</non-revenue-flag>\n'
    + '            <non-discountable-flag>false</non-discountable-flag>\n'
    + '        </store-attributes>\n';

function unitAndQtyXml(t) {
    var xml = '';
    xml += optTag('ean', t.ean);
    xml += optTag('upc', t.upc);
    if (t.unit) {
        xml += '        <unit>' + xmlEsc(t.unit) + '</unit>\n';
    } else {
        xml += '        <unit/>\n';
    }
    if (t.unitQuantity != null && t.unitQuantity !== '') {
        xml += '        <unit-quantity>' + xmlEsc(String(t.unitQuantity)) + '</unit-quantity>\n';
    }
    xml += '        <min-order-quantity>' + xmlEsc(t.minOrderQuantity || '1') + '</min-order-quantity>\n';
    xml += '        <step-quantity>' + xmlEsc(t.stepQuantity || '1') + '</step-quantity>\n';
    return xml;
}

function classificationCategoryXml(t) {
    var classCatId = resolveCategorySfccId(t.classificationCategory);
    var classCatalogId = (_xmlOpts && _xmlOpts.catalogId) || '';
    if (classCatId && classCatalogId) {
        return '        <classification-category catalog-id="' + xmlEsc(classCatalogId) + '">'
            + xmlEsc(classCatId) + '</classification-category>\n';
    }
    if (classCatId) {
        return '        <classification-category>' + xmlEsc(classCatId) + '</classification-category>\n';
    }
    return '';
}

/**
 * Build product XML + category-assignment XML for one transformed product.
 * Matches reference SFCC catalog XML structure exactly.
 *
 * @returns {{ productXml: string, categoryXml: string }}
 */
/**
 * Build product XML as separate pieces: the master/simple product first, then one piece
 * per variant product. No single string ever holds a whole product with all its variants,
 * so a large master (e.g. 42 variants with every attribute selected, ~830K chars) stays
 * far below SFCC's 1,000,000-char script string quota (api.jsStringLength).
 *
 * @returns {{ productXmlParts: Array<string>, categoryXml: string }}
 */
function buildProductXmlParts(t, selectedVarAttrs, xmlOpts) {
    if (xmlOpts) _xmlOpts = xmlOpts;
    var pid        = xmlEsc(t.productId);
    var parts      = [];
    var productXml = '';
    var catXml     = '';

    // ── Master / simple product ───────────────────────────────────────────
    productXml += '    <product product-id="' + pid + '">\n';
    productXml += unitAndQtyXml(t);

    productXml += localizedElementsXml('        ', 'display-name', localeOrString(t.nameLocales, t.name));
    productXml += localizedElementsXml('        ', 'short-description', localeOrString(t.shortDescriptionLocales, t.shortDescription));
    productXml += localizedElementsXml('        ', 'long-description', localeOrString(t.longDescriptionLocales, t.longDescription));

    productXml += '        <online-flag>' + (t.onlineFlag === false ? 'false' : 'true') + '</online-flag>\n';
    productXml += '        <available-flag>true</available-flag>\n';
    productXml += '        <searchable-flag>true</searchable-flag>\n';

    var sourcePlatform = t.shopifyId ? 'shopify'
        : (t.sapId ? 'sap'
            : (t.bcId ? 'bigcommerce' : 'ctp'));

    // A variation master owns every image (SFCC import rejects <images> on
    // variation products); simple products, sets and bundles keep their own.
    var isVariationMaster = t.productKind === 'base' && t.hasVariants;
    var variationModel = isVariationMaster
        ? collectVariationModel(t, selectedVarAttrs, sourcePlatform)
        : null;
    productXml += isVariationMaster
        ? buildMasterImagesXml(t, variationModel)
        : buildImagesXml(t.masterImages);

    if (t.taxClassId)       productXml += '        <tax-class-id>'       + xmlEsc(t.taxClassId)       + '</tax-class-id>\n';
    if (t.brand)            productXml += '        <brand>'              + xmlEsc(t.brand)            + '</brand>\n';
    if (t.manufacturerName) productXml += '        <manufacturer-name>'  + xmlEsc(t.manufacturerName) + '</manufacturer-name>\n';
    // CT sku is unique per variant: a variation master leaves it to its variant products.
    // Every CT product has a master variant, so bundles and sets (which export no variant
    // products) carry their master variant SKU themselves; otherwise they would have none.
    var masterSku = String(t.manufacturerSku || '').trim();
    if (sourcePlatform === 'ctp' && !isVariationMaster && !masterSku && t.variants && t.variants[0]) {
        masterSku = String(t.variants[0].sku || '').trim();
    }
    if (masterSku && !(sourcePlatform === 'ctp' && isVariationMaster)) {
        productXml += '        <manufacturer-sku>' + xmlEsc(masterSku) + '</manufacturer-sku>\n';
    }

    productXml += buildPageAttributes(t);

    var productAttrMap = attrIdMapSession.read('product');

    // CT: write master-owned attributes on the master product (full ownership).
    // XSD: custom-attributes before bundled/set/variations.
    if (sourcePlatform === 'ctp') {
        var masterInner = buildCtpCustomAttrInner(
            t.masterAttributes || [],
            selectedVarAttrs,
            productAttrMap,
            '            ',
            t.variationAttributeNames
        );
        masterInner += ctpProductKeyCustomXml(t, productAttrMap, selectedVarAttrs, '            ');
        masterInner += ctpProductLevelCustomXml('productType', t.ctpProductTypeKey, productAttrMap, selectedVarAttrs, '            ');
        if (masterInner) {
            productXml += '        <custom-attributes>\n' + masterInner + '        </custom-attributes>\n';
        }
    }

    // XSD-enforced order: bundled-products → product-set-products → variations
    if (t.productKind === 'bundle') {
        productXml += buildBundledProductsXml(t.bundleProducts);
    } else if (t.productKind === 'set') {
        productXml += buildProductSetProductsXml(t.setProducts);
    } else if (t.hasVariants) {
        // base product with variants
        productXml += buildVariationsXml(t, selectedVarAttrs, sourcePlatform, variationModel);
    }

    productXml += classificationCategoryXml(t);

    productXml += '        <pinterest-enabled-flag>false</pinterest-enabled-flag>\n';
    productXml += '        <facebook-enabled-flag>false</facebook-enabled-flag>\n';
    productXml += STORE_ATTRS;
    productXml += '    </product>\n\n';
    parts.push(productXml);
    productXml = '';

    // ── Variant products (base products only — sets/bundles have no SFCC variants) ──
    if (t.productKind === 'base' && t.hasVariants) {
        var isShopifyVar = sourcePlatform === 'shopify';
        var isSapVar     = sourcePlatform === 'sap';
        var isBcVar      = sourcePlatform === 'bigcommerce';
        for (var vi = 0; vi < t.variants.length; vi++) {
            var v = t.variants[vi];
            productXml += '    <product product-id="' + xmlEsc(v.productId) + '">\n';
            productXml += '        <ean/>\n';
            productXml += '        <upc/>\n';
            if (t.unit) {
                productXml += '        <unit>' + xmlEsc(t.unit) + '</unit>\n';
            } else {
                productXml += '        <unit/>\n';
            }
            productXml += '        <min-order-quantity>' + xmlEsc(t.minOrderQuantity || '1') + '</min-order-quantity>\n';
            productXml += '        <step-quantity>' + xmlEsc(t.stepQuantity || '1') + '</step-quantity>\n';
            productXml += '        <online-flag>' + (t.onlineFlag === false ? 'false' : 'true') + '</online-flag>\n';
            productXml += '        <available-flag>true</available-flag>\n';
            productXml += '        <searchable-flag>true</searchable-flag>\n';
            // SFCC owns all variation image groups on the master product. Child
            // product <images> blocks are rejected during catalog import.
            if (t.taxClassId) productXml += '        <tax-class-id>' + xmlEsc(t.taxClassId) + '</tax-class-id>\n';
            // Trimmed like price book product IDs, so SKU-based lookups match.
            var variantSku = v.sku ? String(v.sku).trim() : '';
            if (variantSku) productXml += '        <manufacturer-sku>' + xmlEsc(variantSku) + '</manufacturer-sku>\n';
            productXml += '        <page-attributes/>\n';

            var varInner;
            var hasVarSelection = selectedVarAttrs && selectedVarAttrs.length;

            if (isShopifyVar) {
                // Shopify: respect selection when set; always keep price/barcode extras
                varInner = '';
                for (var sai = 0; sai < (v.attributes || []).length; sai++) {
                    var sa    = v.attributes[sai];
                    var sval  = sa.value;
                    if (sval === null || sval === undefined) continue;
                    if (Array.isArray(sval)) continue;
                    if (hasVarSelection
                        && selectedVarAttrs.indexOf(sa.name) === -1
                        && sa.name !== 'price' && sa.name !== 'compareAtPrice' && sa.name !== 'barcode') {
                        continue;
                    }
                    var saRule = nativeMap.getRule('shopify', 'Product', sa.name);
                    if (saRule && nativeMap.isMapAction(saRule.action)) continue;
                    var saId  = (saRule && saRule.action === 'custom_attr') ? saRule.sfccField
                        : ('shopify_' + String(sa.name || '').replace(/[^a-zA-Z0-9_]/g, '_'));
                    // Session AI maps are keyed by source name (e.g. product_description → longDescription)
                    if (isProductSystemAttr(attrIdMapSession.resolve(sa.name, productAttrMap))) continue;
                    saId = resolveProductAttrId(saId);
                    if (isProductSystemAttr(saId)) continue;
                    var sstr  = String(sval);
                    if (!sstr) continue;
                    varInner += '            <custom-attribute attribute-id="' + xmlEsc(saId) + '">' + xmlEsc(sstr) + '</custom-attribute>\n';
                }
            } else if (isBcVar) {
                varInner = '';
                for (var bai = 0; bai < (v.attributes || []).length; bai++) {
                    var ba    = v.attributes[bai];
                    var bval  = ba.value;
                    if (bval === null || bval === undefined) continue;
                    if (Array.isArray(bval)) continue;
                    if (hasVarSelection
                        && selectedVarAttrs.indexOf(ba.name) === -1
                        && ba.name !== 'price' && ba.name !== 'sale_price' && ba.name !== 'upc') {
                        continue;
                    }
                    var baRule = nativeMap.getRule('bigcommerce', 'Product', ba.name);
                    if (baRule && nativeMap.isMapAction(baRule.action)) continue;
                    var baId  = (baRule && baRule.action === 'custom_attr') ? baRule.sfccField
                        : ('bc_' + String(ba.name || '').replace(/[^a-zA-Z0-9_]/g, '_'));
                    if (isProductSystemAttr(attrIdMapSession.resolve(ba.name, productAttrMap))) continue;
                    baId = resolveProductAttrId(baId);
                    if (isProductSystemAttr(baId)) continue;
                    var bstr  = String(bval);
                    if (!bstr) continue;
                    varInner += '            <custom-attribute attribute-id="' + xmlEsc(baId) + '">' + xmlEsc(bstr) + '</custom-attribute>\n';
                }
            } else if (isSapVar) {
                // SAP: write variant qualifiers unfiltered
                // (Phase 1 — no explicit-selection UI step for SAP yet, mirrors Shopify's default-include behavior).
                varInner = '';
                for (var qai = 0; qai < (v.attributes || []).length; qai++) {
                    var qa   = v.attributes[qai];
                    var qval = qa.value;
                    if (qval === null || qval === undefined) continue;
                    if (Array.isArray(qval)) continue;
                    var qaRule = nativeMap.getRule('sap', 'Product', qa.name);
                    if (qaRule && nativeMap.isMapAction(qaRule.action)) continue;
                    var qaId  = (qaRule && qaRule.action === 'custom_attr') ? qaRule.sfccField
                        : ('sap_' + String(qa.name || '').replace(/[^a-zA-Z0-9_]/g, '_'));
                    if (isProductSystemAttr(attrIdMapSession.resolve(qa.name, productAttrMap))) continue;
                    qaId = resolveProductAttrId(qaId);
                    if (isProductSystemAttr(qaId)) continue;
                    var qstr = String(qval);
                    if (!qstr) continue;
                    varInner += '            <custom-attribute attribute-id="' + xmlEsc(qaId) + '">' + xmlEsc(qstr) + '</custom-attribute>\n';
                }
            } else {
                // CT: attrs owned by this variant product (full ownership per node)
                varInner = buildCtpCustomAttrInner(
                    v.attributes,
                    selectedVarAttrs,
                    productAttrMap,
                    '            ',
                    t.variationAttributeNames
                );
            }

            if (varInner) productXml += '        <custom-attributes>\n' + varInner + '        </custom-attributes>\n';

            productXml += classificationCategoryXml(t);
            productXml += '        <pinterest-enabled-flag>false</pinterest-enabled-flag>\n';
            productXml += '        <facebook-enabled-flag>false</facebook-enabled-flag>\n';
            productXml += STORE_ATTRS;
            productXml += '    </product>\n\n';
            parts.push(productXml);
            productXml = '';
        }
    }

    // ── Category assignments (after ALL products in the file) ─────────────
    for (var ci = 0; ci < t.categories.length; ci++) {
        var assignCatId = resolveCategorySfccId(t.categories[ci]);
        if (!assignCatId) continue;
        catXml += '    <category-assignment category-id="' + xmlEsc(assignCatId) + '" product-id="' + pid + '">\n';
        if (ci === 0) catXml += '        <primary-flag>true</primary-flag>\n';
        catXml += '    </category-assignment>\n';
    }

    if (productXml) parts.push(productXml);
    return { productXmlParts: parts, categoryXml: catXml };
}

/**
 * Build product XML + category-assignment XML for one transformed product as single strings.
 * Kept for callers and tests that need the whole product; batch builds use
 * buildProductXmlParts so large products never become one string.
 *
 * @returns {{ productXml: string, categoryXml: string }}
 */
function buildProductXml(t, selectedVarAttrs, xmlOpts) {
    var built = buildProductXmlParts(t, selectedVarAttrs, xmlOpts);
    return { productXml: built.productXmlParts.join(''), categoryXml: built.categoryXml };
}

// Well under the 1,000,000-char script string quota, leaving room for one large product.
var FLUSH_CHARS = 262144;

/**
 * Build product and category XML parts for a batch — no XML declaration or catalog wrapper.
 * Returns the inner parts separately so callers can accumulate across multiple batches
 * and write a single XML file at the end.
 *
 * @param {Array}    rawProducts
 * @param {string}   catalogId        - used only for UUID→SFCC-ID map key; not written here
 * @param {Array}    selectedVarAttrs
 * @param {Function} [transformerFn]
 * @param {Object}   [xmlOpts]          - { localizableAttrIds, categoryIdToSfcc, externalImageBaseUrl, onFlush }
 *     onFlush(productsPart, categoriesPart): when given, XML is handed over in pieces of about
 *     FLUSH_CHARS and the returned productsXml/categoriesXml are empty. SFCC caps a single script
 *     string at 1,000,000 chars (quota api.jsStringLength); a 50-product batch with every attribute
 *     selected exceeds that, so callers that write to disk must pass onFlush.
 * @returns {{ productsXml, categoriesXml, built, failed, errors, setCount, bundleCount, imageBaseUrl }}
 */
function buildXmlParts(rawProducts, catalogId, selectedVarAttrs, transformerFn, xmlOpts) {
    var transform = transformerFn || ctpTransformer.transformProduct;
    _xmlOpts = xmlOpts || {};
    if (catalogId && !_xmlOpts.catalogId) _xmlOpts.catalogId = catalogId;

    _uuidToSfccId = {};
    _memberVariantIds = {};
    for (var mi = 0; mi < rawProducts.length; mi++) {
        var cp    = rawProducts[mi];
        var cpId  = cp.id  || '';
        if (cpId) {
            // Same schema map as transformer: id → ID → product-id (never prefer key)
            _uuidToSfccId[cpId] = ctpTransformer.resolveMasterProductId
                ? ctpTransformer.resolveMasterProductId(cp)
                : String(cpId);
        }
    }

    var built         = 0;
    var failed        = 0;
    var errors        = [];
    var setCount      = 0;
    var bundleCount   = 0;
    var productsXml   = '';
    var categoriesXml = '';
    var transformed   = [];

    var i;
    for (i = 0; i < rawProducts.length; i++) {
        try {
            transformed.push({ rawIndex: i, product: transform(rawProducts[i]) });
        } catch (transformError) {
            failed++;
            if (errors.length < 10) {
                errors.push((rawProducts[i].key || rawProducts[i].handle || rawProducts[i].id)
                    + ': ' + (transformError.message || String(transformError)));
            }
        }
    }

    // Exact-variant lookup for bundle members: this batch plus members fetched by the runner.
    var ti;
    for (ti = 0; ti < transformed.length; ti++) registerMemberVariants(transformed[ti].product);
    var extraMembers = _xmlOpts.bundleMemberProducts || [];
    for (ti = 0; ti < extraMembers.length; ti++) {
        try { registerMemberVariants(transform(extraMembers[ti])); } catch (me) { /* falls back to master */ }
    }

    _xmlOpts.externalImageBaseUrl = firstCtpImageBaseUrl(
        transformed.map(function (entry) { return entry.product; }),
        _xmlOpts.externalImageBaseUrl
    );

    var onFlush = typeof _xmlOpts.onFlush === 'function' ? _xmlOpts.onFlush : null;

    for (i = 0; i < transformed.length; i++) {
        var t = transformed[i].product;
        try {
            var result = buildProductXmlParts(t, selectedVarAttrs);
            var pieces = result.productXmlParts.concat([result.categoryXml]);
            var pi;
            for (pi = 0; pi < pieces.length; pi++) {
                var isCategory = pi === pieces.length - 1;
                // Flush what is buffered before this piece would push the buffer past the
                // threshold (checking only after appending let one big product overflow it).
                if (onFlush && (productsXml || categoriesXml) && pieces[pi]
                        && productsXml.length + categoriesXml.length + pieces[pi].length >= FLUSH_CHARS) {
                    onFlush(productsXml, categoriesXml);
                    productsXml   = '';
                    categoriesXml = '';
                }
                if (isCategory) categoriesXml += pieces[pi];
                else productsXml += pieces[pi];
            }
            if (t.productKind === 'set')    setCount++;
            else if (t.productKind === 'bundle') bundleCount++;
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 10) {
                var raw = rawProducts[transformed[i].rawIndex];
                errors.push((raw.key || raw.handle || raw.id) + ': ' + (e.message || String(e)));
            }
        }
        if (onFlush && productsXml.length + categoriesXml.length >= FLUSH_CHARS) {
            onFlush(productsXml, categoriesXml);
            productsXml   = '';
            categoriesXml = '';
        }
    }

    if (onFlush && (productsXml || categoriesXml)) {
        onFlush(productsXml, categoriesXml);
        productsXml   = '';
        categoriesXml = '';
    }

    return {
        productsXml:   productsXml,
        categoriesXml: categoriesXml,
        built:         built,
        failed:        failed,
        errors:        errors,
        setCount:      setCount,
        bundleCount:   bundleCount,
        imageBaseUrl:  _xmlOpts.externalImageBaseUrl || ''
    };
}

/**
 * Build complete SFCC catalog import XML for a batch of products.
 * For single-batch usage (partial migration or Shopify). For multi-batch CT full migration
 * use buildXmlParts + assemble manually to produce one file.
 *
 * @param {Array}    rawProducts
 * @param {string}   catalogId
 * @param {Array}    selectedVarAttrs
 * @param {Function} [transformerFn]
 * @param {Object}   [xmlOpts]
 * @returns {{ xml, built, failed, errors, setCount, bundleCount }}
 */
function buildXml(rawProducts, catalogId, selectedVarAttrs, transformerFn, xmlOpts) {
    var parts = buildXmlParts(rawProducts, catalogId, selectedVarAttrs, transformerFn, xmlOpts);

    var xml = xmlHeader(catalogId, parts.imageBaseUrl)
            + parts.productsXml
            + parts.categoriesXml
            + '\n</catalog>\n';

    return {
        xml:         xml,
        built:       parts.built,
        failed:      parts.failed,
        errors:      parts.errors,
        setCount:    parts.setCount,
        bundleCount: parts.bundleCount,
        imageBaseUrl: parts.imageBaseUrl
    };
}

function xmlHeader(catalogId, externalImageBaseUrl) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31"'
        + ' catalog-id="' + xmlEsc(catalogId) + '">\n\n'
        + imageSettingsHeaderXml(externalImageBaseUrl);
}

var XML_FOOTER = '\n</catalog>\n';

module.exports = {
    buildXml:         buildXml,
    buildXmlParts:    buildXmlParts,
    buildProductXml:  buildProductXml,
    buildProductXmlParts: buildProductXmlParts,
    xmlHeader:        xmlHeader,
    XML_FOOTER:       XML_FOOTER
};
