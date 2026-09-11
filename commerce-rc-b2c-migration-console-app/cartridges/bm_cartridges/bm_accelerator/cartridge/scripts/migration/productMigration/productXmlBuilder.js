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
 * @returns {string} inner custom-attribute elements (no wrapper)
 */
function buildCtpCustomAttrInner(attributes, selectedVarAttrs, productAttrMap, indent) {
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
        if (Array.isArray(val)) continue;
        inner += customAttributeXml(indent, aId, val);
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
 * CT Product.key is product-level. Write as custom attr when the user created/mapped
 * it in Check Attributes; never when the session target is an SFCC system field.
 */
function ctpProductKeyCustomXml(t, productAttrMap, selectedVarAttrs, indent) {
    if (!t || !t.ctpKey) return '';
    var mapped = attrIdMapSession.resolve('key', productAttrMap);
    var target = mapped || 'key';
    if (isProductSystemAttr(target)) return '';
    var selected = selectedVarAttrs && selectedVarAttrs.indexOf('key') !== -1;
    if (!sfccCustomAttrExists(target) && !selected) return '';
    return customAttributeXml(indent, target, t.ctpKey);
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
    if (val == null || val === '') return null;
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
function customAttributeXml(indent, attrId, val) {
    if (val === null || val === undefined) return '';
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

/**
 * Build <images> block.
 * Reference uses large + medium + small image-group view-types.
 */
function buildImagesXml(images) {
    if (!images || !images.length) return '';
    var viewTypes = ['large', 'medium', 'small'];
    var xml = '        <images>\n';
    for (var vi = 0; vi < viewTypes.length; vi++) {
        xml += '            <image-group view-type="' + viewTypes[vi] + '">\n';
        for (var i = 0; i < images.length; i++) {
            var url = images[i].url || images[i].path || '';
            if (url) xml += '                <image path="' + xmlEsc(url) + '"/>\n';
        }
        xml += '            </image-group>\n';
    }
    xml += '        </images>\n';
    return xml;
}

/**
 * Build <variations> block with <attributes> (variation axes from variant attrs)
 * and <variants> list.
 * Reference: <attributes> first, then <variants>.
 * platform: 'shopify' | 'sap' | 'bigcommerce' | 'ctp' (default) — which transformer produced t.
 */
function buildVariationsXml(t, selectedVarAttrs, platform) {
    var xml = '        <variations>\n';
    var isShopify = platform === 'shopify';
    var isBc      = platform === 'bigcommerce';
    var hasVarSelection = selectedVarAttrs && selectedVarAttrs.length;
    var attrPrefix = platform === 'shopify' ? 'shopify_'
        : (platform === 'sap' ? 'sap_'
            : (platform === 'bigcommerce' ? 'bc_' : ''));

    // Collect unique variation attribute names + values across all variants.
    // CT: value can be string, number, or { key, label } enum.
    // Shopify/BC: value is always a string (selectedOptions / option_values).
    // attrMap key = SFCC attr ID — must match both axis ID and variant custom attr ID.
    var attrMap = {}; // { sfccAttrId: { key: displayVal } }
    for (var vi = 0; vi < t.variants.length; vi++) {
        var attrs = t.variants[vi].attributes || [];
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
            }

            var axisRule = nativeMap.getRule(
                platform === 'shopify' ? 'shopify'
                    : (platform === 'sap' ? 'sap'
                        : (platform === 'bigcommerce' ? 'bigcommerce' : 'commercetools')),
                'Product', a.name);
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
            var displayMap = parsed.displayMap;
            if (!attrMap[sfccAxisId]) attrMap[sfccAxisId] = {};
            if (!attrMap[sfccAxisId][key]) attrMap[sfccAxisId][key] = displayMap;
        }
    }

    var attrNames = Object.keys(attrMap);
    if (attrNames.length) {
        xml += '            <attributes>\n';
        for (var ni = 0; ni < attrNames.length; ni++) {
            var attrName = attrNames[ni]; // SFCC attr ID
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
        xml += '            <bundled-product product-id="' + xmlEsc(ctpMemberIdToSfcc(bundleProducts[i].productId)) + '">\n';
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
function buildProductXml(t, selectedVarAttrs, xmlOpts) {
    if (xmlOpts) _xmlOpts = xmlOpts;
    var pid        = xmlEsc(t.productId);
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

    // Images skipped — CT image URLs are external and incompatible with SFCC DIS path format

    var sourcePlatform = t.shopifyId ? 'shopify'
        : (t.sapId ? 'sap'
            : (t.bcId ? 'bigcommerce' : 'ctp'));

    if (t.taxClassId)       productXml += '        <tax-class-id>'       + xmlEsc(t.taxClassId)       + '</tax-class-id>\n';
    if (t.brand)            productXml += '        <brand>'              + xmlEsc(t.brand)            + '</brand>\n';
    if (t.manufacturerName) productXml += '        <manufacturer-name>'  + xmlEsc(t.manufacturerName) + '</manufacturer-name>\n';
    // CT sku is unique per variant — manufacturer-sku belongs on variant products only.
    if (t.manufacturerSku && !(sourcePlatform === 'ctp' && t.hasVariants)) {
        productXml += '        <manufacturer-sku>' + xmlEsc(t.manufacturerSku) + '</manufacturer-sku>\n';
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
            '            '
        );
        masterInner += ctpProductKeyCustomXml(t, productAttrMap, selectedVarAttrs, '            ');
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
        productXml += buildVariationsXml(t, selectedVarAttrs, sourcePlatform);
    }

    productXml += classificationCategoryXml(t);

    productXml += '        <pinterest-enabled-flag>false</pinterest-enabled-flag>\n';
    productXml += '        <facebook-enabled-flag>false</facebook-enabled-flag>\n';
    productXml += STORE_ATTRS;
    productXml += '    </product>\n\n';

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
            if (t.taxClassId) productXml += '        <tax-class-id>' + xmlEsc(t.taxClassId) + '</tax-class-id>\n';
            if (v.sku) productXml += '        <manufacturer-sku>' + xmlEsc(v.sku) + '</manufacturer-sku>\n';
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
                    '            '
                );
            }

            if (varInner) productXml += '        <custom-attributes>\n' + varInner + '        </custom-attributes>\n';

            productXml += classificationCategoryXml(t);
            productXml += '        <pinterest-enabled-flag>false</pinterest-enabled-flag>\n';
            productXml += '        <facebook-enabled-flag>false</facebook-enabled-flag>\n';
            productXml += STORE_ATTRS;
            productXml += '    </product>\n\n';
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

    return { productXml: productXml, categoryXml: catXml };
}

/**
 * Build product and category XML parts for a batch — no XML declaration or catalog wrapper.
 * Returns the inner parts separately so callers can accumulate across multiple batches
 * and write a single XML file at the end.
 *
 * @param {Array}    rawProducts
 * @param {string}   catalogId        - used only for UUID→SFCC-ID map key; not written here
 * @param {Array}    selectedVarAttrs
 * @param {Function} [transformerFn]
 * @param {Object}   [xmlOpts]          - { localizableAttrIds, categoryIdToSfcc }
 * @returns {{ productsXml, categoriesXml, built, failed, errors, setCount, bundleCount }}
 */
function buildXmlParts(rawProducts, catalogId, selectedVarAttrs, transformerFn, xmlOpts) {
    var transform = transformerFn || ctpTransformer.transformProduct;
    _xmlOpts = xmlOpts || {};
    if (catalogId && !_xmlOpts.catalogId) _xmlOpts.catalogId = catalogId;

    _uuidToSfccId = {};
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

    for (var i = 0; i < rawProducts.length; i++) {
        try {
            var t      = transform(rawProducts[i]);
            var result = buildProductXml(t, selectedVarAttrs);
            productsXml   += result.productXml;
            categoriesXml += result.categoryXml;
            if (t.productKind === 'set')    setCount++;
            else if (t.productKind === 'bundle') bundleCount++;
            built++;
        } catch (e) {
            failed++;
            if (errors.length < 10) {
                errors.push((rawProducts[i].key || rawProducts[i].handle || rawProducts[i].id) + ': ' + (e.message || String(e)));
            }
        }
    }

    return {
        productsXml:   productsXml,
        categoriesXml: categoriesXml,
        built:         built,
        failed:        failed,
        errors:        errors,
        setCount:      setCount,
        bundleCount:   bundleCount
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

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31"'
            + ' catalog-id="' + xmlEsc(catalogId) + '">\n\n'
            + parts.productsXml
            + parts.categoriesXml
            + '\n</catalog>\n';

    return {
        xml:         xml,
        built:       parts.built,
        failed:      parts.failed,
        errors:      parts.errors,
        setCount:    parts.setCount,
        bundleCount: parts.bundleCount
    };
}

function xmlHeader(catalogId) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31"'
        + ' catalog-id="' + xmlEsc(catalogId) + '">\n\n';
}

var XML_FOOTER = '\n</catalog>\n';

module.exports = {
    buildXml:         buildXml,
    buildXmlParts:    buildXmlParts,
    buildProductXml:  buildProductXml,
    xmlHeader:        xmlHeader,
    XML_FOOTER:       XML_FOOTER
};
