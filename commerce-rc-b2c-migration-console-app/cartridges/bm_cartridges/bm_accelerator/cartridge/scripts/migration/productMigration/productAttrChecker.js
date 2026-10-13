'use strict';

var http        = require('*/cartridge/scripts/migration/core/http');
var cfg         = require('*/cartridge/scripts/migration/configAccessor');
var Encoding    = require('dw/crypto/Encoding');
var Bytes       = require('dw/util/Bytes');
var attrBuilder = require('*/cartridge/scripts/migration/core/attrBuilder');
var nativeMap   = require('*/cartridge/scripts/migration/config/nativeFieldMap');
var runner      = require('*/cartridge/scripts/migration/core/attrPreflightRunner');

var CTP_ATTR_GROUP_ID   = 'CTPMigration';
var CTP_ATTR_GROUP_NAME = 'CT Migration';

function toBase64(str) {
    return Encoding.toBase64(new Bytes(str, 'UTF-8'));
}

function getCtpToken() {
    var c    = cfg.ctp;
    var body = 'grant_type=client_credentials';
    if (c.scopes) body += '&scope=' + encodeURIComponent(c.scopes);
    var res = http.post(
        c.authUrl + '/oauth/token',
        {
            Authorization:  'Basic ' + toBase64(c.clientId + ':' + c.clientSecret),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    );
    if (res.status !== 200 || !res.data.access_token) {
        throw new Error('CT auth failed (' + res.status + ')');
    }
    return res.data.access_token;
}

/**
 * SFCC attribute id for a CT product-type field — keep the source name as-is
 * (including hyphens). Check Attributes UX, AI maps, and create-metadata all use this.
 * @param {string} name
 * @returns {string}
 */
function toCustomSfccId(name) {
    return String(name || '').trim();
}

/**
 * A CT localized enum that can distinguish variants must become a NON-localizable
 * SFCC attribute: SFCC rejects localizable variation attributes on import
 * ("Custom attribute definition ... has a wrong type 'local'"). The variant value is the
 * enum key; translated labels still reach the storefront as variation display values.
 * Mirrors productTransformer.deriveVariationAttributeNames: any lenum whose constraint is
 * not SameForAll can be emitted as a variation attribute.
 * @param {Object} ad - CT product type attribute definition
 * @returns {boolean} true when the attribute must be created non-localizable
 */
function isLocalizedVariationCandidate(ad) {
    var typeName = ad && ad.type && ad.type.name ? String(ad.type.name) : '';
    var constraint = ad && ad.attributeConstraint ? String(ad.attributeConstraint) : '';
    return typeName === 'lenum' && constraint !== 'SameForAll';
}

/**
 * Fetch all attribute definitions from all CT product types.
 * Rules: not aliased / not identity / not skipped → create candidate with source name as id.
 * @returns {Array} [{ name, label, ctpType, sfccId, sourceKey }]
 */
function getCtpProductTypeFields() {
    var c   = cfg.ctp;
    var tok = getCtpToken();

    var res = http.get(
        c.apiUrl + '/' + c.projectKey + '/product-types?limit=500',
        { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT Product Types API failed (' + res.status + ')');
    }

    var fields = [];
    var seen   = {};
    var variationIds = {};
    var types  = (res.data && res.data.results) ? res.data.results : [];

    for (var t = 0; t < types.length; t++) {
        var attrDefs = types[t].attributes || [];
        for (var a = 0; a < attrDefs.length; a++) {
            var ad = attrDefs[a];
            if (!ad || !ad.name) continue;
            // Same name can appear in several product types; one variation use is enough.
            if (isLocalizedVariationCandidate(ad)) variationIds[toCustomSfccId(ad.name)] = true;
            if (seen[ad.name]) continue;
            seen[ad.name] = true;

            // Aliased / identity / explicit-skip handled in classifyFields; still pass
            // the field so mapped/skipped sections stay accurate when names collide.
            fields.push({
                name:      ad.name,
                sourceKey: ad.name,
                sfccId:    toCustomSfccId(ad.name),
                label:     attrBuilder.toLabel(ad.label) || ad.name,
                ctpType:   (ad.type && ad.type.name) ? ad.type.name : 'text'
            });
        }
    }
    fields.variationIds = variationIds;
    return fields;
}

/**
 * IDs of CT attributes that must be created non-localizable (see isLocalizedVariationCandidate).
 * @returns {Object} map of SFCC attribute id to true; empty when CT is unreachable
 */
function getVariationAttrIds() {
    try {
        return getCtpProductTypeFields().variationIds || {};
    } catch (e) {
        return {};
    }
}

/**
 * Force non-localizable scope on create candidates that can be variation attributes.
 * @param {Array} attrs - create candidates or create requests ({ id, canonicalId?, localizable, scope, ... })
 * @param {Object} variationIds - map of SFCC attribute id to true
 * @returns {Array} the same array, updated in place
 */
function applyVariationScope(attrs, variationIds) {
    var i;
    for (i = 0; i < (attrs || []).length; i++) {
        var a = attrs[i];
        // canonicalId is the CT name when the user renamed the SFCC id on the create screen.
        if (a && ((a.id && variationIds[a.id]) || (a.canonicalId && variationIds[a.canonicalId]))) {
            a.localizable = false;
            a.scope = 'none';
        }
    }
    return attrs;
}

/**
 * Build check table:
 *   1. curated CT Product aliases (mapped)
 *   2. CT Product Type attributes (create if not alias/identity/exists)
 * Skipped catalog + coverage pending come from classifyFields.
 * @returns {{ mapped: Array, missing: Array, coveragePending: Array, skipped: Array }}
 */
function checkMissingAttributes() {
    var fields = nativeMap.getMappedSourceFields('commercetools', 'Product');
    var i;
    // Product.key is a CT built-in (not a Product Type attr): offer create or map, never skip / never ID.
    fields.push({
        name:      'key',
        sourceKey: 'key',
        sfccId:    'key',
        label:     'Key',
        ctpType:   'text'
    });
    // The product type is a reference on the product, not a Product Type attribute: its key
    // (e.g. "personalizable") tells the storefront which products are configurator products.
    fields.push({
        name:      'productType',
        sourceKey: 'productType',
        sfccId:    'productType',
        label:     'Product Type',
        ctpType:   'text'
    });
    var variationIds = {};
    try {
        var ctpFields = getCtpProductTypeFields();
        variationIds = ctpFields.variationIds || {};
        for (i = 0; i < ctpFields.length; i++) {
            fields.push(ctpFields[i]);
        }
    } catch (e) {
        // Types API failure still allows curated maps
    }

    var result = runner.classifyFields({
        sfccObjectType: 'Product',
        taskName:       'Product',
        moduleKey:      'product',
        fields:         fields
    });
    if (result && result.missing) applyVariationScope(result.missing, variationIds);
    return result;
}

function createAttributes(attrs) {
    // Enforce server-side too: the page echoes back whatever localizable flag it was shown.
    applyVariationScope(attrs, getVariationAttrIds());
    return runner.createDefinitions('Product', CTP_ATTR_GROUP_ID, CTP_ATTR_GROUP_NAME, attrs);
}

module.exports = {
    getCtpProductTypeFields: getCtpProductTypeFields,
    isLocalizedVariationCandidate: isLocalizedVariationCandidate,
    applyVariationScope:     applyVariationScope,
    checkMissingAttributes:  checkMissingAttributes,
    createAttributes:        createAttributes
};
