'use strict';

/**
 * Shared utilities for building SFCC attribute definition payloads.
 * All platform connectors use these to produce a consistent output shape.
 */

/**
 * SFCC system objects that do not support localizable or site-specific attributes.
 * Create always forces scope "none" on these types.
 */
var NO_SCOPE_OBJECT_TYPES = {
    Customer: true,
    Profile: true,
    Order: true,
    // order parts written by the order migration (custom-attributes in order.xsd)
    ProductLineItem: true,
    OrderAddress: true,
    OrderPaymentInstrument: true,
    PriceAdjustment: true,
    PriceBook: true,
    ProductInventoryList: true,
    ProductInventoryRecord: true
};

/**
 * Source type names that imply a localizable value on the source platform.
 */
var LOCALIZABLE_SOURCE_TYPES = {
    ltext: true,
    lenum: true,
    LocalizedString: true,
    LocalizedEnum: true,
    localized: true
};

/**
 * @param {string} sfccObjectType
 * @returns {boolean}
 */
function supportsAttributeScope(sfccObjectType) {
    if (!sfccObjectType) return true;
    return !NO_SCOPE_OBJECT_TYPES[sfccObjectType];
}

/**
 * @param {string} sourceType - CT/SAP/Shopify type name
 * @returns {boolean}
 */
function isLocalizableSourceType(sourceType) {
    return !!(sourceType && LOCALIZABLE_SOURCE_TYPES[sourceType]);
}

/**
 * Effective SFCC scope after create for a source type + target object.
 * @param {string} sourceType
 * @param {string} [sfccObjectType]
 * @returns {{ sourceLocalizable: boolean, localizable: boolean, siteSpecific: boolean, scope: string }}
 */
function resolveAttributeScope(sourceType, sfccObjectType) {
    var sourceLocalizable = isLocalizableSourceType(sourceType);
    var localizable = sourceLocalizable && supportsAttributeScope(sfccObjectType);
    return {
        sourceLocalizable: sourceLocalizable,
        localizable:       !!localizable,
        siteSpecific:      false,
        scope:             localizable ? 'localized' : 'none'
    };
}

/**
 * Extract a display string from a CT/Shopify localised string or a plain string.
 * @param {Object|string} obj
 * @returns {string}
 */
function toLabel(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    return obj.en || obj['en-US'] || Object.keys(obj).map(function (k) { return obj[k]; })[0] || '';
}

/**
 * Build the SFCC OCAPI attribute definition payload.
 * @param {string} id        - attribute ID (must be a valid SFCC identifier)
 * @param {string} valueType - SFCC value_type (string, text, html, int, double, boolean, date, datetime, email, enum_of_string, set_of_string, …)
 * @param {string} label     - human-readable display name
 * @param {Object} [opts]    - { localizable?, siteSpecific?, sourceType?, sfccObjectType? }
 * @returns {Object}
 */
function buildAttrDefinition(id, valueType, label, opts) {
    opts = opts || {};
    var scope = resolveAttributeScope(
        opts.sourceType || '',
        opts.sfccObjectType
    );
    // Explicit flags win when provided; still never both true; object deny-list caps localizable.
    var localizable = Object.prototype.hasOwnProperty.call(opts, 'localizable')
        ? !!opts.localizable
        : scope.localizable;
    var siteSpecific = Object.prototype.hasOwnProperty.call(opts, 'siteSpecific')
        ? !!opts.siteSpecific
        : scope.siteSpecific;
    if (!supportsAttributeScope(opts.sfccObjectType)) {
        localizable = false;
        siteSpecific = false;
    }
    if (localizable && siteSpecific) {
        siteSpecific = false;
    }

    return {
        id:                  id,
        value_type:          valueType,
        mandatory:           false,
        searchable:          false,
        externally_defined:  false,
        externally_managed:  false,
        order_required:      false,
        localizable:         localizable,
        site_specific:       siteSpecific,
        display_name:        { default: label || id }
    };
}

module.exports = {
    toLabel:                 toLabel,
    buildAttrDefinition:     buildAttrDefinition,
    supportsAttributeScope:  supportsAttributeScope,
    isLocalizableSourceType: isLocalizableSourceType,
    resolveAttributeScope:   resolveAttributeScope,
    NO_SCOPE_OBJECT_TYPES:   NO_SCOPE_OBJECT_TYPES
};
